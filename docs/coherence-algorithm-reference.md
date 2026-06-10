# Coherence Algorithm — Reference Extraction for iOS Port

> **Audience.** iOS engineer who needs to compute coherence, lens-drive duty, and the breathing pacer entirely on the app side (e.g. when the IBI source is a Polar H10 paired directly to iOS, and the glasses are being driven over `0xA5` static duty rather than via `0xCA` → built-in pipeline).
>
> **Source of truth.** Every numbered code block in §5 / §6 / §7 / §8 is copied **verbatim** from the current Edge firmware at `C:\NARBIS APP\Oct_4_25\Clone\edge-firmware\v4\Code-Glasses\main\main.c`. Line ranges are noted so you can diff against future firmware drops. All algorithm constants and tunables are listed in §3 with their defaults and runtime-tunable ranges.
>
> **When to use this.** If you want lens behaviour identical to what the firmware would produce, port the pipeline below 1-for-1. If you're happy to let the glasses do the work and just want the firmware tinted automatically, send IBIs via `0xCA` instead — see the main protocol doc's §4.7.

---

## Table of contents

1. [Signal flow at a glance](#1-signal-flow-at-a-glance)
2. [How fast each stage runs](#2-how-fast-each-stage-runs)
3. [Constants and defaults](#3-constants-and-defaults)
4. [Tuning settings — slider definition list](#4-tuning-settings--slider-definition-list)
5. [The pipeline, stage by stage (with C source)](#5-the-pipeline-stage-by-stage-with-c-source)
6. [Score smoothing (EWMA in Program 2 only)](#6-score-smoothing-ewma-in-program-2-only)
7. [Adaptive pacer (slew-limited respiration tracker)](#7-adaptive-pacer-slew-limited-respiration-tracker)
8. [PPG programs — coherence score → lens behaviour](#8-ppg-programs--coherence-score--lens-behaviour)
9. [Coherence difficulty preset](#9-coherence-difficulty-preset)
10. [Defaults table](#10-defaults-table)
11. [Notes for the iOS port](#11-notes-for-the-ios-port)

---

## 1. Signal flow at a glance

```
                   Polar H10 / earclip / app PPG
                                │
                                │  R-R interval (ms) + confidence + flags
                                ▼
                ┌──────────────────────────────────┐
        §5.1    │ Outlier gate                     │  rolling-avg × 1.75 cap
                │ Confidence + artifact filter     │  drops missed-beat doubles
                └──────────────────┬───────────────┘
                                   │ (beat_ms, ibi_ms)
                                   ▼
                ┌──────────────────────────────────┐
        §5.2    │ IBI ring buffer (120 entries)    │  ≈ 2 min @ 60 BPM
                └──────────────────┬───────────────┘
                                   │
                                   │  1 Hz tick — coherence_task fires every 1000 ms
                                   ▼
                ┌──────────────────────────────────┐
        §5.3    │ Snapshot + restrict to last 64 s │  COH_WINDOW_S = COH_GRID_N / COH_GRID_HZ
                └──────────────────┬───────────────┘
                                   ▼
                ┌──────────────────────────────────┐
        §5.4    │ Linear resample → uniform 4 Hz   │  COH_GRID_HZ = 4.0
                │ grid of 256 points (64 s)        │
                └──────────────────┬───────────────┘
                                   ▼
                ┌──────────────────────────────────┐
        §5.5    │ Detrend (subtract mean)          │
                │ Apply Hann window                │
                └──────────────────┬───────────────┘
                                   ▼
                ┌──────────────────────────────────┐
        §5.6    │ Radix-2 FFT (256-point)          │  bin width = 4/256 = 0.015625 Hz
                │ Compute PSD = |re|² + |im|²      │
                └──────────────────┬───────────────┘
                                   ▼
                ┌──────────────────────────────────┐
        §5.7    │ Band integration                 │  VLF / LF / HF power
                │ (Task Force 1996 bands)          │
                └──────────────────┬───────────────┘
                                   ▼
                ┌──────────────────────────────────┐
        §5.8    │ LF peak detection                │  argmax in [pk_lo..pk_hi]
                │ ± peak_halfwidth bins integrated │
                └──────────────────┬───────────────┘
                                   ▼
                ┌──────────────────────────────────┐
        §5.9    │ Score = peak / total ×           │  clamped 0..100
                │         coh_multiplier (100)     │
                └──────────────────┬───────────────┘
                                   │
                ┌──────────────────┼───────────────┐
                ▼                  ▼               ▼
         ┌──────────────┐   ┌──────────────┐  ┌──────────────┐
   §7    │ Adaptive     │   │ EWMA smooth  │  │ Score → 0xF2 │  (firmware: BLE emit)
         │ pacer ring   │   │ (Program 2)  │  │ telemetry    │
         │ (15-sample,  │   │ α = 0.005    │  └──────────────┘
         │ slew-limited)│   │ §6           │
         └──────┬───────┘   └──────┬───────┘
                │                  │
                └──────┬───────────┘
                       ▼
            ┌────────────────────────────┐
       §8   │ Lens-drive program (0-3):  │
            │  0  Pulse on beat          │  flash at each beat
            │  1  Coherence-Breathe      │  sine pacer × coherence scale
            │  2  Coherence-Lens         │  smoothed score ^ gamma
            │  3  Coherence-Breathe-     │  Program 1 + strobe modulation
            │     Strobe                 │
            └────────────┬───────────────┘
                         ▼
                  PWM duty 0..brightness
                         ▼
                  Electrochromic lens
```

---

## 2. How fast each stage runs

| Stage | Cadence | Where |
|---|---|---|
| IBI ingest | Per beat (~1 Hz at resting HR) | `on_earclip_ibi()` / `0xCA` handler |
| Outlier gate, ring push | Per beat | same |
| Snapshot + FFT + score | **1 Hz** | `coherence_task` (loop with `COH_UPDATE_MS = 1000`) |
| Adaptive pacer ring push | 1 Hz (driven by FFT output) | inside `coh_compute()` |
| Adaptive pacer quintet latch | At each breathing cycle boundary (~10 s when adaptive) | `led_task` Program 1 / 3 block |
| EWMA smoothing | 100 Hz | `led_task` Program 2 block (10 ms ticks) |
| Lens PWM update | 100 Hz | `led_task` (10 ms `LED_TICK_MS`) |
| AC alternation for lens | 100 Hz | `gptimer` ISR (5 ms half-period) |

The slowest end-to-end latency a user feels is **1 second + tau** — 1 s for the next FFT compute + ~2 s EWMA time constant in Program 2 + lens response time. Programs 0, 1, 3 don't apply the EWMA so they react at the 1 Hz update rate directly.

---

## 3. Constants and defaults

### 3.1 Hard-coded pipeline constants (not BLE-tunable)

```c
/* main.c:5430-5433 */
#define COH_IBI_RING_SIZE     120   /* ~2 min at 60 bpm */
#define COH_GRID_N            256   /* FFT size, power of 2 */
#define COH_GRID_HZ           4.0f  /* Resample rate (standard for HRV analysis) */
#define COH_WINDOW_S          (COH_GRID_N / COH_GRID_HZ)  /* 64 seconds */

/* main.c:5441-5442 */
#define COH_UPDATE_MS         1000  /* Recompute every 1 second */
#define COH_MIN_IBIS          20    /* Need at least this many beats to compute (also runtime-tunable as min_ibis) */

/* main.c:1828-1835 */
#define COH_DUTY_FLOOR_PCT      20  /* Duty scale at coherence=100 (lightest end of the
                                     * coherence→opacity map). 20% keeps it visible
                                     * rather than going fully clear. */

/* main.c:1666 */
#define LED_TICK_MS             10  /* LED task tick */

/* main.c:2502-2503 */
#define PULSE_DURATION_MS       150 /* total pulse duration (cosine decay inside) */
#define PULSE_PEAK_DUTY         80  /* maximum tint at t=0 of the pulse */

/* main.c:3577 (inside Program 2 block) */
const float COH_ALPHA = 0.005f;     /* EWMA coefficient → ~2 s time constant at 10 ms ticks */

/* main.c:2386 */
#define IBI_OUTLIER_THRESHOLD_PCT  75u  /* reject IBI > avg × 1.75; catches missed-beat doubles */

/* main.c:2205-2215 — adaptive pacer */
#define ADAPT_BPM_MIN          3    /* ~0.050 Hz / 20-sec cycle */
#define ADAPT_BPM_MAX         10    /* ~0.167 Hz / 6-sec cycle */
#define ADAPT_BPM_START        6    /* initial pace on program entry */
#define ADAPT_WINDOW_N        15    /* 15 samples at 1 Hz = 15 seconds */
#define ADAPT_QUINTET_MIN     15u   /* 3.0 BPM (quintet = BPM × 5) */
#define ADAPT_QUINTET_MAX     50u   /* 10.0 BPM */
#define ADAPT_QUINTET_START   30u   /* 6.0 BPM */
#define ADAPT_MAX_STEP         1u   /* max 0.2 BPM change per cycle boundary */
```

### 3.2 Runtime-tunable parameters (`narbis_coh_params_t`, all settable via `0xE0`)

| Field | Default | Range | Purpose |
|---|---|---|---|
| `min_ibis` | 20 | 5–120 | Minimum beats before coherence is computed |
| `conf_threshold` | 50 | 0–100 | Drop beats with `confidence < this` |
| `vlf_band_lo` | 1 | 0–127 | VLF band, inclusive low bin |
| `vlf_band_hi` | 2 | ≥ lo, ≤ 127 | VLF band, inclusive high bin |
| `lf_band_lo` | 3 | 0–127 | LF band, inclusive low bin |
| `lf_band_hi` | 9 | ≥ lo, ≤ 127 | LF band, inclusive high bin |
| `hf_band_lo` | 10 | 0–127 | HF band, inclusive low bin |
| `hf_band_hi` | 25 | ≥ lo, ≤ 127 | HF band, inclusive high bin |
| `lf_peak_lo` | 3 | 0–127 | LF peak-search window, inclusive low bin |
| `lf_peak_hi` | 9 | ≥ lo, ≤ 127 | LF peak-search window, inclusive high bin |
| `peak_halfwidth` | 0 | 0–8 | 0 = single-bin peak; N = ± N bins around argmax (inclusive sum) |
| `coh_multiplier` | 100 | 10–255 | Score scaling. 100 = current default (peak/total maps to 0–100). Was 250 pre-v4.14.31 — saturates much faster, useful for beginners. |

**FFT bin grid.** All bin indices above index into a fixed 4 Hz × 256-point FFT. `df = 4/256 = 0.015625 Hz/bin`. The grid is compile-time — you cannot resize the FFT at runtime without re-allocating buffers.

| Frequency | Bin |
|---|---|
| 0.016 Hz | 1 |
| 0.04 Hz | 3 (VLF / LF boundary) |
| 0.10 Hz | 6.4 (mid-LF, resonant breathing target) |
| 0.15 Hz | 10 (LF / HF boundary) |
| 0.40 Hz | 26 (upper HF) |
| ~2 Hz | 127 (Nyquist) |

---

## 4. Tuning settings — slider definition list

This is the same slider set the dashboard exposes (per the attached screenshots). Mirrored here so you can build matching iOS UI.

### Coherence Difficulty — `0xB8`
**Type:** preset, 4 options (Easy / Medium / Hard / Expert).
**Effect:** sets the gamma exponent on the smoothed coherence value in [Program 2 / Coherence-Lens](#83-program-2-coherence-lens). Easy = linear (gamma 1.0). Each step makes the lens require more coherence to reach the same clarity. Other programs are unaffected.
**Persists:** yes (NVS).
**Default:** Easy (0).

### Lens Darkness Limit — `0xA2`
**Type:** integer 0–100 (% brightness cap).
**Effect:** caps the maximum tint duty for the lens. The lens duty in all programs is `effective_duty × brightness / 100`, so this slider sets the ceiling. Programs 1 / 2 / 3 honour it; the breathing waveform / coherence score modulate between 0 and this cap.
**Persists:** yes.
**Default:** 100.

### Strobe Frequency — `0xAB`
**Type:** integer 1–50 Hz (1-byte arg) or 0.1 Hz precision (3-byte arg, deci-Hz).
**Effect:** flash rate for Program 4 (Coherence-Breathe-Strobe) and the standalone strobe mode (`0xA6`).
**Persists:** yes.
**Default:** 10 Hz (deci-Hz value 100).

### Strobe Duty Cycle — `0xAC`
**Type:** integer 10–90 (% of period dark).
**Effect:** dark fraction per strobe cycle. 50% = symmetric square wave.
**Persists:** yes.
**Default:** 50%.

### Breathing Pacer Rate — `0xB1`
**Type:** integer 1–30 BPM.
**Effect:** fixed-rate breathing for Program 1 (Breathe) and Program 4 (Coherence-Breathe-Strobe) when adaptive pacer is OFF. Ignored when adaptive pacer is ON.
**Persists:** yes.
**Default:** 6 BPM (the Lehrer/Vaschillo resonance target).

### Inhale Ratio — `0xB2`
**Type:** integer 10–90 (% inhale).
**Effect:** inhale fraction of the breathing cycle. 40% = 40% inhale / 60% exhale (paced-breathing standard, designed to favour parasympathetic activation on the longer exhale).
**Persists:** yes.
**Default:** 40%.

### Coherence Algorithm Tuning — `0xE0`
**Type:** 12-byte struct (`narbis_coh_params_t`).
**Effect:** live-tunes the FFT band ranges, LF peak window, score multiplier, IBI confidence gate, and `min_ibis`. Changes apply on the next 1 Hz coherence compute. See §3.2 for the field list. Bin width fixed at 0.015625 Hz/bin.
**Persists:** yes (NVS — each field stored as its own u8).

Sub-sliders (all part of the same `0xE0` payload):
- **LF peak: low bin** — default 3 (0.047 Hz).
- **LF peak: high bin** — default 9 (0.141 Hz).
- **Peak halfwidth (± bins around argmax)** — default 0 = single-bin peak. 1 = ±1 bin (3 bins summed). Wider forgives broad resonance peaks.
- **LF band: low bin** — default 3 (0.047 Hz). Used in the denominator of the score.
- **LF band: high bin** — default 9 (0.141 Hz).
- **HF band: low bin** — default 10 (0.156 Hz).
- **HF band: high bin** — default 25 (0.391 Hz).
- **Coherence multiplier (peak/total × N)** — default 100 (post-v4.14.31). 250 = pre-v4.14.31 (saturates faster, useful for beginner sessions).
- **IBI confidence threshold (%)** — default 50. Drop beats with confidence below this. Applies to both earclip-relayed and `0xCA`-injected IBIs.
- **Minimum beats to compute** — default 20.

### Adaptive Pacer — `0xB9`
**Type:** boolean (0 = OFF, 1 = ON).
**Effect:** when ON, the pacer's target BPM walks slowly toward whichever rate produces the highest detected LF peak (the user's measured resonant respiratory frequency). 0.2 BPM steps with a slew-rate limit; cycle changes happen only at the next breathing-cycle boundary so the lens never stutters mid-breath. Affects only Programs 1 and 3.
**Persists:** yes.
**Default:** ON.

### Stream Raw PPG via Glasses — `0xC4`
**Type:** boolean (0 = OFF, 1 = ON).
**Effect:** when ON, the Edge subscribes to the earclip's RAW_PPG characteristic and forwards each batch as a `0xF5` status frame. Significant BLE air-time + earclip power cost. Useful only when diagnosing the raw signal.
**Persists:** no (defaults to enabled at boot).
**Default:** ON.
**Note:** earclip-relay only. **Not relevant to the H10 / iOS-side compute path.**

### PC Jitter Smoothing (dashboard-only)
**Effect:** dashboard-side buffering of incoming raw-PPG BLE packets, replaying at uniform 20 ms intervals to smooth Windows BLE bursty delivery. Adds 150 ms latency. Leave OFF on tablet / iOS — not a glasses-side setting.

---

## 5. The pipeline, stage by stage (with C source)

### 5.1 IBI ingestion — outlier gate + confidence filter

Both the earclip-relay handler (`on_earclip_ibi`) and the `0xCA` external-IBI handler do the same gating before pushing to the ring. The check order is:

1. Confidence ≥ `conf_threshold` AND not `ARTIFACT`-flagged
2. Outlier rejection: drop if `ibi_ms > rolling_avg × 1.75`
3. Update rolling average with IIR: `avg = (avg × 7 + ibi_ms) / 8`
4. Push `(now_ms, ibi_ms)` to the ring

> **Why the outlier gate.** PR #30. If the detector misses a beat, the next reported IBI is ~2× the true value (it includes the missed interval). Pushing that double into the FFT introduces a low-frequency artifact that corrupts the coherence score for the next ~64 seconds (the FFT window). The rolling-avg × 1.75 gate catches these without rejecting legitimately long IBIs (e.g. respiratory sinus arrhythmia extremes).

```c
/* main.c:2386-2387 */
#define IBI_OUTLIER_THRESHOLD_PCT  75u  /* reject IBI > avg × 1.75; catches missed-beat doubles */
static uint32_t g_ibi_rolling_avg_ms = 0;  /* IIR rolling avg ms; 0 = uninit. Reset on disconnect. */

/* main.c:6122-6157 — earclip-relay path */
static void on_earclip_ibi(uint16_t ibi_ms, uint8_t conf, uint8_t flags) {
    /* ... 0xF9 frame emit elided ... */

    /* Skip low-confidence / artifact-flagged beats so noise doesn't
     * corrupt either path. Threshold is runtime-tunable via 0xE0. */
    if (conf < g_coh_params.conf_threshold || (flags & NARBIS_BEAT_FLAG_ARTIFACT)) return;
    beat_pulse_start_tick = xTaskGetTickCount();
    uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000);
    if (ibi_ms > 0) {
        if (g_ibi_rolling_avg_ms == 0) {
            g_ibi_rolling_avg_ms = ibi_ms;
        } else if (ibi_ms > g_ibi_rolling_avg_ms * (100u + IBI_OUTLIER_THRESHOLD_PCT) / 100u) {
            return;  /* likely missed beat; LED already pulsed, coherence ring skipped */
        } else {
            g_ibi_rolling_avg_ms = (g_ibi_rolling_avg_ms * 7u + ibi_ms) / 8u;
        }
        coh_push_ibi(now_ms, ibi_ms);
    }
}

/* main.c:4372-4406 — 0xCA external-IBI handler (Polar H10 path) */
case 0xCA: {  /* External-IBI injection (dashboard / Polar H10 path). */
    if (len < 5) {
        ble_log("0xCA short len=%u (need 5)", len);
        break;
    }
    uint16_t ibi_ms = (uint16_t)data[1] | ((uint16_t)data[2] << 8);
    uint8_t  conf   = data[3];
    uint8_t  flags  = data[4];
    if (conf < g_coh_params.conf_threshold || (flags & NARBIS_BEAT_FLAG_ARTIFACT)) break;
    beat_pulse_start_tick = xTaskGetTickCount();  /* Program 1 flash */
    uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000);
    if (ibi_ms > 0) {
        if (g_ibi_rolling_avg_ms == 0) {
            g_ibi_rolling_avg_ms = ibi_ms;
        } else if (ibi_ms > g_ibi_rolling_avg_ms * (100u + IBI_OUTLIER_THRESHOLD_PCT) / 100u) {
            break;  /* likely missed beat; coherence ring skipped */
        } else {
            g_ibi_rolling_avg_ms = (g_ibi_rolling_avg_ms * 7u + ibi_ms) / 8u;
        }
        coh_push_ibi(now_ms, ibi_ms);
    }
    break;
}
```

**Swift port:** straight-line port. `now_ms` should be a monotonic clock (`CACurrentMediaTime() * 1000` or `mach_absolute_time` derived). Reset `g_ibi_rolling_avg_ms` to 0 whenever the H10 disconnects so a fresh session doesn't carry stale state.

---

### 5.2 IBI ring buffer

```c
/* main.c:5444-5476 */

typedef struct {
    uint32_t beat_ms;   /* absolute ms timestamp of the beat */
    uint16_t ibi_ms;    /* IBI ending at this beat */
} coh_ibi_entry_t;

static coh_ibi_entry_t coh_ibi_ring[COH_IBI_RING_SIZE];   /* 120 */
static uint8_t coh_ibi_head = 0;        /* where next push goes */
static uint8_t coh_ibi_count = 0;       /* how many valid entries (caps at ring size) */
static portMUX_TYPE coh_mux = portMUX_INITIALIZER_UNLOCKED;

/* Push a beat into the ring. Called from ppg_task on every detected beat. */
static void coh_push_ibi(uint32_t beat_ms, uint16_t ibi_ms) {
    portENTER_CRITICAL(&coh_mux);
    coh_ibi_ring[coh_ibi_head].beat_ms = beat_ms;
    coh_ibi_ring[coh_ibi_head].ibi_ms = ibi_ms;
    coh_ibi_head = (coh_ibi_head + 1) % COH_IBI_RING_SIZE;
    if (coh_ibi_count < COH_IBI_RING_SIZE) coh_ibi_count++;
    portEXIT_CRITICAL(&coh_mux);
}

/* v4.13.1: clear IBI ring on sensor disconnect. */
static void coh_clear(void) {
    portENTER_CRITICAL(&coh_mux);
    coh_ibi_head = 0;
    coh_ibi_count = 0;
    portEXIT_CRITICAL(&coh_mux);
}
```

**Swift port:** `[CohIbiEntry]` of fixed size 120, plus head index and count. Wrap reads/writes in a `DispatchQueue` or `os_unfair_lock` if you're reading from a different queue than you're writing from. Call `cohClear()` whenever the H10 disconnects.

---

### 5.3 Snapshot + window restriction

`coh_compute()` first atomically snapshots the ring, then drops everything older than `COH_WINDOW_S` (64 s):

```c
/* main.c:5593-5641 (snapshot + window portion) */
static void coh_compute(void) {
    /* Snapshot ring under critical section */
    static uint32_t snap_beat_ms[COH_IBI_RING_SIZE];
    static uint16_t snap_ibi_ms[COH_IBI_RING_SIZE];
    uint8_t snap_count;

    portENTER_CRITICAL(&coh_mux);
    snap_count = coh_ibi_count;
    if (snap_count > 0) {
        int start = (coh_ibi_head + COH_IBI_RING_SIZE - snap_count) % COH_IBI_RING_SIZE;
        for (int i = 0; i < snap_count; i++) {
            int idx = (start + i) % COH_IBI_RING_SIZE;
            snap_beat_ms[i] = coh_ibi_ring[idx].beat_ms;
            snap_ibi_ms[i] = coh_ibi_ring[idx].ibi_ms;
        }
    }
    portEXIT_CRITICAL(&coh_mux);

    /* Snapshot runtime-tunable knobs once at the top so a concurrent
     * 0xE0 write doesn't change band boundaries mid-compute. */
    const uint8_t coh_min_ibis    = g_coh_params.min_ibis;
    const uint8_t coh_vlf_lo      = g_coh_params.vlf_band_lo;
    const uint8_t coh_vlf_hi      = g_coh_params.vlf_band_hi;
    const uint8_t coh_lf_lo       = g_coh_params.lf_band_lo;
    const uint8_t coh_lf_hi       = g_coh_params.lf_band_hi;
    const uint8_t coh_hf_lo       = g_coh_params.hf_band_lo;
    const uint8_t coh_hf_hi       = g_coh_params.hf_band_hi;
    const uint8_t coh_pk_lo       = g_coh_params.lf_peak_lo;
    const uint8_t coh_pk_hi       = g_coh_params.lf_peak_hi;
    const uint8_t coh_pk_hw       = g_coh_params.peak_halfwidth;
    const uint8_t coh_mult        = g_coh_params.coh_multiplier;

    if (snap_count < coh_min_ibis) return;

    /* Restrict to last COH_WINDOW_S seconds — the FFT grid covers only
     * this duration. Older beats would wrap the grid or be unused. */
    uint32_t window_start_ms = snap_beat_ms[snap_count - 1] > (uint32_t)(COH_WINDOW_S * 1000.0f)
        ? snap_beat_ms[snap_count - 1] - (uint32_t)(COH_WINDOW_S * 1000.0f)
        : 0;
    int first_in_window = 0;
    while (first_in_window < snap_count
           && snap_beat_ms[first_in_window] < window_start_ms) {
        first_in_window++;
    }
    int n_used = snap_count - first_in_window;
    if (n_used < coh_min_ibis) return;
```

---

### 5.4 Resample to uniform 4 Hz grid

IBI series is non-uniformly sampled in time (one sample per beat). FFT needs uniform sampling. Linear interpolation onto a 256-sample grid covering 64 seconds:

```c
/* main.c:5568-5588 */
static void coh_resample(const uint32_t *beat_ms, const uint16_t *ibi_ms,
                         int n_beats, float *grid) {
    uint32_t t0 = beat_ms[0];
    for (int i = 0; i < COH_GRID_N; i++) {
        float t = (float)i / COH_GRID_HZ;        /* seconds from t0 */
        uint32_t abs_ms = t0 + (uint32_t)(t * 1000.0f);
        /* Find bracketing beats j, j+1 such that beat_ms[j] ≤ abs_ms ≤ beat_ms[j+1] */
        if (abs_ms <= beat_ms[0]) { grid[i] = (float)ibi_ms[0]; continue; }
        if (abs_ms >= beat_ms[n_beats - 1]) { grid[i] = (float)ibi_ms[n_beats - 1]; continue; }
        /* Binary search for efficiency */
        int lo = 0, hi = n_beats - 1;
        while (hi - lo > 1) {
            int mid = (lo + hi) / 2;
            if (beat_ms[mid] <= abs_ms) lo = mid; else hi = mid;
        }
        /* Linear interp between [lo] and [hi] */
        uint32_t dt = beat_ms[hi] - beat_ms[lo];
        float frac = (dt > 0) ? ((float)(abs_ms - beat_ms[lo]) / (float)dt) : 0.0f;
        grid[i] = (float)ibi_ms[lo] + frac * ((float)ibi_ms[hi] - (float)ibi_ms[lo]);
    }
}
```

> **Why linear and not cubic.** Task Force 1996 doesn't specify; linear is what Kubios uses for short windows and it's what the dashboard's Lomb-Scargle implementation effectively matches in this frequency range. Cubic added no measurable accuracy in early A/B testing and cost stack.

**Swift port:** trivial. Pre-allocate the 256-element `grid` buffer once and reuse.

---

### 5.5 Detrend + Hann window

```c
/* main.c:5509-5513 — Hann window precomputed once at init */
static void coh_init(void) {
    for (int i = 0; i < COH_GRID_N; i++) {
        coh_hann[i] = 0.5f * (1.0f - cosf(2.0f * (float)M_PI * i / (COH_GRID_N - 1)));
    }
}

/* main.c:5647-5658 — detrend + window inside coh_compute */
/* Detrend — subtract mean, critical for FFT because DC bin dominates otherwise */
float sum = 0.0f;
for (int i = 0; i < COH_GRID_N; i++) sum += coh_fft_re[i];
float mean = sum / COH_GRID_N;
for (int i = 0; i < COH_GRID_N; i++) coh_fft_re[i] -= mean;

/* Apply Hanning window + zero imaginary part */
for (int i = 0; i < COH_GRID_N; i++) {
    coh_fft_re[i] *= coh_hann[i];
    coh_fft_im[i] = 0.0f;
}
```

> **Why detrend.** Without subtracting the mean, the DC bin (bin 0) dominates the spectrum and the LF peak detection misfires. The Hann window then suppresses spectral leakage from the finite 64 s window.

**Swift port:** use `vDSP_meanv` + `vDSP_vsadd` for detrend, and precompute the Hann window once with `vDSP_hann_window`.

---

### 5.6 FFT (256-point radix-2)

The firmware uses a hand-written in-place radix-2 Cooley-Tukey FFT (no ESP-DSP dependency, ~30 lines):

```c
/* main.c:5524-5558 */
static void coh_fft(float *re, float *im, int N) {
    /* Bit-reversal permutation */
    for (int i = 1, j = 0; i < N; i++) {
        int bit = N >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            float tr = re[i]; re[i] = re[j]; re[j] = tr;
            float ti = im[i]; im[i] = im[j]; im[j] = ti;
        }
    }
    /* Butterfly */
    for (int len = 2; len <= N; len <<= 1) {
        float ang = -2.0f * (float)M_PI / (float)len;
        float wlen_re = cosf(ang);
        float wlen_im = sinf(ang);
        int half = len >> 1;
        for (int i = 0; i < N; i += len) {
            float w_re = 1.0f, w_im = 0.0f;
            for (int j = 0; j < half; j++) {
                float u_re = re[i + j];
                float u_im = im[i + j];
                float v_re = re[i + j + half] * w_re - im[i + j + half] * w_im;
                float v_im = re[i + j + half] * w_im + im[i + j + half] * w_re;
                re[i + j] = u_re + v_re;
                im[i + j] = u_im + v_im;
                re[i + j + half] = u_re - v_re;
                im[i + j + half] = u_im - v_im;
                float new_w_re = w_re * wlen_re - w_im * wlen_im;
                w_im = w_re * wlen_im + w_im * wlen_re;
                w_re = new_w_re;
            }
        }
    }
}
```

**Swift port — strongly recommend Accelerate.** Don't port this loop verbatim. Use vDSP:

```swift
import Accelerate

private var fftSetup: vDSP.FFT<DSPSplitComplex>!  // initialise once
// log2(256) = 8
fftSetup = vDSP.FFT(log2n: 8, radix: .radix2, ofType: DSPSplitComplex.self)!

// Per-compute: convert real input to split-complex, then forward FFT.
// Output is split-complex; magnitude² = realp[i]² + imagp[i]²
```

A single 256-point FFT on an A-series chip is sub-millisecond — orders of magnitude faster than the ESP32's 3 ms. Don't micro-optimise.

---

### 5.7 Band power integration + PSD

```c
/* main.c:5663-5687 */
/* One-sided PSD — store magnitude² back into psd[].
 * Only need bins 0..N/2-1 since real input produces conjugate-symmetric
 * output. Freq at bin k: f_k = k × Fs / N = k × 4/256 = k × 0.015625 Hz */
float psd[COH_GRID_N / 2];   /* 128 bins */
for (int i = 0; i < COH_GRID_N / 2; i++) {
    psd[i] = coh_fft_re[i] * coh_fft_re[i] + coh_fft_im[i] * coh_fft_im[i];
}

/* Band integration — Task Force 1996 bands.
 * Bin indices (0.015625 Hz/bin):
 *   VLF: 0.003-0.04 → bins 1-2  (skip DC bin 0)
 *   LF:  0.04-0.15  → bins 3-9
 *   HF:  0.15-0.4   → bins 10-25
 *
 * v4.13.8: this sum (bins 1-25, covering 0.016-0.391 Hz) IS the
 * coherence denominator. */
float vlf = 0.0f, lf = 0.0f, hf = 0.0f;
for (int i = coh_vlf_lo; i <= coh_vlf_hi; i++) vlf += psd[i];  /* skip DC bin 0 by default (vlf_lo=1) */
for (int i = coh_lf_lo;  i <= coh_lf_hi;  i++) lf  += psd[i];
for (int i = coh_hf_lo;  i <= coh_hf_hi;  i++) hf  += psd[i];
float total = vlf + lf + hf;
```

The denominator for the coherence score is **VLF + LF + HF**, not the full spectrum out to Nyquist. This matches the dashboard's Lomb-Scargle reference implementation and avoids systematically deflating the score.

---

### 5.8 LF peak detection (Lehrer/Vaschillo) + halfwidth

```c
/* main.c:5713-5731 */
/* LF resonance peak (Lehrer/Vaschillo method):
 * 1. Find argmax within LF band (default 0.047-0.141 Hz = bins 3-9)
 * 2. If peak_halfwidth == 0: use single peak bin as numerator (matches
 *    dashboard v13.10's narrow-window behavior — adjacent bins are
 *    0.015625 Hz away, just outside the dashboard's 0.015 Hz window).
 * 3. If peak_halfwidth > 0: sum psd[peak-hw .. peak+hw] inclusive —
 *    approximates "spectral peak + neighbors" for broad resonance.
 *
 * Range and ± halfwidth are runtime-tunable via 0xE0. */
int peak_bin = coh_pk_lo;
float peak_argmax_pow = psd[coh_pk_lo];
for (int i = (int)coh_pk_lo + 1; i <= (int)coh_pk_hi; i++) {
    if (psd[i] > peak_argmax_pow) {
        peak_argmax_pow = psd[i];
        peak_bin = i;
    }
}
float peak_pow;
if (coh_pk_hw == 0) {
    peak_pow = peak_argmax_pow;
} else {
    int lo_b = peak_bin - (int)coh_pk_hw;
    int hi_b = peak_bin + (int)coh_pk_hw;
    if (lo_b < 0) lo_b = 0;
    if (hi_b > (COH_GRID_N / 2 - 1)) hi_b = COH_GRID_N / 2 - 1;
    peak_pow = 0.0f;
    for (int i = lo_b; i <= hi_b; i++) peak_pow += psd[i];
}
```

> **Why this is the "Lehrer/Vaschillo" peak.** HRV coherence (the HeartMath definition) is the ratio of power in the dominant LF spectral peak to total power. Higher = HR oscillating strongly at a single resonant frequency = the user's parasympathetic gain. Lehrer & Vaschillo showed the resonant frequency varies between individuals in the 0.075–0.12 Hz range (4.5–7.5 BPM), which is what the LF peak window (default 3–9 = 0.047–0.141 Hz) covers.

---

### 5.9 Score computation + state publish

```c
/* main.c:5733-5783 */
float coherence = 0.0f;
if (total > 1e-6f) {
    float ratio = peak_pow / total;
    /* v4.14.31: multiplier changed 250 → 100. The old 250 pegged
     * score at 100 for any peak-to-total ratio above 0.40, which
     * is extremely easy to hit (steady paced breathing alone does it).
     * Multiplier is runtime-tunable via 0xE0. */
    coherence = ratio * (float)coh_mult;
    if (coherence > 100.0f) coherence = 100.0f;
    if (coherence < 0.0f) coherence = 0.0f;
}

/* Normalize band powers to fit u16 for the display/status packet. */
float scale = 1.0f;
float maxband = total;
if (maxband > 6.5e4f) scale = 6.5e4f / maxband;

float lfhf = (hf > 1.0f) ? (lf / hf) : 0.0f;
uint16_t lfhf_fp88 = (uint16_t)(lfhf * 256.0f + 0.5f);
if (lfhf > 255.0f) lfhf_fp88 = 0xFFFF;

float lf_plus_hf = lf + hf;
uint8_t lf_norm = (lf_plus_hf > 0) ? (uint8_t)(lf / lf_plus_hf * 100.0f) : 0;
uint8_t hf_norm = (lf_plus_hf > 0) ? (uint8_t)(hf / lf_plus_hf * 100.0f) : 0;

/* Publish. */
coh_state.coherence      = (uint8_t)coherence;
coh_state.resp_peak_mhz  = (uint16_t)((float)peak_bin * COH_GRID_HZ / COH_GRID_N * 1000.0f);
/* v4.14.32: feed the adaptive-pacer ring. Only in-range values
 * count — the ring's push function drops out-of-band measurements. */
adapt_resp_push(coh_state.resp_peak_mhz);
coh_state.vlf_power      = (uint16_t)(vlf * scale);
coh_state.lf_power       = (uint16_t)(lf * scale);
coh_state.hf_power       = (uint16_t)(hf * scale);
coh_state.total_power    = (uint16_t)(total * scale);
coh_state.lf_norm        = lf_norm;
coh_state.hf_norm        = hf_norm;
coh_state.lf_hf_fp88     = lfhf_fp88;
coh_state.n_ibis_used    = (n_used > 255) ? 255 : (uint8_t)n_used;
coh_state.last_update_ms = (uint32_t)(esp_timer_get_time() / 1000);
```

The `coh_state` struct is the output bundle. The peak frequency in milli-Hz (`resp_peak_mhz`) is `peak_bin × df × 1000`, where `df = COH_GRID_HZ / COH_GRID_N = 4/256 = 0.015625 Hz/bin`.

---

## 6. Score smoothing (EWMA in Program 2 only)

The raw `coh_state.coherence` updates at 1 Hz with step changes of up to 10–30 points between consecutive computes. For **Program 2 (Coherence-Lens)** that drives lens opacity directly, the firmware EWMA-smooths to avoid visible step transitions:

```c
/* main.c:3576-3585 (inside Program 2 block of led_task) */
/* EWMA: alpha = 0.005 → ~2s time constant at 10ms ticks. */
const float COH_ALPHA = 0.005f;
coh_smooth += (((float)coh_raw) - coh_smooth) * COH_ALPHA;

/* Clamp to stay in valid range (float math could creep
 * slightly negative on the way down, or slightly > 100
 * if someone writes past range). */
float s = coh_smooth;
if (s < 0.0f) s = 0.0f;
if (s > 100.0f) s = 100.0f;
```

> **Time constant.** `α = 1 − exp(−Δt / τ)`, with `Δt = 10 ms` (led_task tick) and `τ ≈ 2 s`, gives `α ≈ 0.005`. Practical: a step from 0 → 50 reaches ~32 in 2 s, ~43 in 4 s, ~47 in 6 s. Small or large step, the response feels uniformly smooth.

Programs 0, 1, 3 use the **raw** 1 Hz coherence value (no smoothing) — they have their own motion / pacing that masks the per-second steps.

**On Program 2 entry**, snap the smoothed value to the current raw value so the lens doesn't ramp from "dark" up to the live score:

```c
/* main.c:3567-3573 */
if (prev_led_mode != LED_MODE_COHERENCE_LENS) {
    coh_smooth = (float)coh_raw;
}
```

---

## 7. Adaptive pacer (slew-limited respiration tracker)

Maintains a 15-sample ring of measured `resp_peak_mhz` values, computes the average, converts to "quintets" (BPM × 5; 0.2 BPM resolution), clamps to a breathable range, and applies a slew-rate limit of ±1 quintet per breathing-cycle boundary.

```c
/* main.c:2210-2258 */
/* Quintet = BPM × 5 (0.2 BPM per step). Pacer cycle = 300000 / quintet ms.
 * ADAPT_MAX_STEP limits how many quintets the pacer can shift per cycle
 * boundary — prevents artifact-driven jumps (e.g. 4 → 8 BPM). */
#define ADAPT_QUINTET_MIN   15u   /* 3.0 BPM */
#define ADAPT_QUINTET_MAX   50u   /* 10.0 BPM */
#define ADAPT_QUINTET_START 30u   /* 6.0 BPM */
#define ADAPT_MAX_STEP       1u   /* max 0.2 BPM change per cycle update */
#define ADAPT_WINDOW_N      15    /* 15 samples at 1 Hz = 15 seconds */

static volatile uint8_t coh_pacer_adaptive = 1;   /* default ON */
static uint16_t adapt_resp_ring[ADAPT_WINDOW_N] = {0};
static uint8_t  adapt_resp_idx = 0;
static uint8_t  adapt_resp_count = 0;

/* Called from coherence_task once per compute cycle (1 Hz). Only
 * pushes in-range values to avoid corrupting the average with
 * garbage during warmup or when resp_peak is near the LF band edges. */
static void adapt_resp_push(uint16_t mhz) {
    /* Clamp to ADAPT BPM range converted to mHz.
     *   ADAPT_BPM_MIN=3  → 0.05 Hz = 50 mHz
     *   ADAPT_BPM_MAX=10 → 0.167 Hz = 167 mHz */
    if (mhz < 50 || mhz > 167) return;   /* drop out-of-range */
    adapt_resp_ring[adapt_resp_idx] = mhz;
    adapt_resp_idx = (adapt_resp_idx + 1) % ADAPT_WINDOW_N;
    if (adapt_resp_count < ADAPT_WINDOW_N) adapt_resp_count++;
}

/* Return average resp rate in quintets (BPM × 5, 0.2-BPM resolution).
 * Formula: quintet = round(mhz × 3 / 10). */
static uint8_t adapt_resp_quintet(void) {
    if (adapt_resp_count == 0) return 0;
    uint32_t sum = 0;
    for (int i = 0; i < adapt_resp_count; i++) sum += adapt_resp_ring[i];
    uint32_t avg_mhz = sum / adapt_resp_count;
    uint32_t q = (avg_mhz * 3u + 5u) / 10u;   /* round(bpm / 0.2) */
    if (q < ADAPT_QUINTET_MIN) q = ADAPT_QUINTET_MIN;
    if (q > ADAPT_QUINTET_MAX) q = ADAPT_QUINTET_MAX;
    return (uint8_t)q;
}
```

The **slew-rate limit** is applied at the cycle boundary inside the Program 1/3 block — see §8.2 for the integration.

> **Why quintets.** Discretising at 0.2 BPM (= 1/5 BPM) is fine enough that the user can't perceive the step, but coarse enough that random LF-peak jitter doesn't constantly nudge the pacer. The cycle duration becomes a simple integer: `300_000 / quintet` ms.

---

## 8. PPG programs — coherence score → lens behaviour

The firmware ships four programs, selected via opcode `0xB7` (arg 0–3):

| Arg | Program | Internal `led_mode` | What you see |
|---|---|---|---|
| 0 | Heartbeat | `LED_MODE_PULSE_ON_BEAT` | Lens darkens briefly at every detected beat |
| 1 | Coherence-Breathe | `LED_MODE_COHERENCE_BREATHE` | Lens follows a sine breathing pacer; coherence scales the depth |
| 2 | Coherence-Lens | `LED_MODE_COHERENCE_LENS` | Smoothed coherence score drives opacity directly, with difficulty gamma |
| 3 | Coherence-Breathe-Strobe | `LED_MODE_COHERENCE_BREATHE_STROBE` | Program 1 waveform × coherence modulates a strobe |

All four run inside the `led_task` at 100 Hz (`LED_TICK_MS = 10`). The output is `effective_duty` (0..100, scaled by `brightness`), which is then converted to PWM by the AC-sync timer ISR.

### 8.1 Program 0 — Heartbeat (pulse on beat)

```c
/* main.c:3607-3633 */
/* PULSE_ON_BEAT mode. ppg_task / on_earclip_ibi / 0xCA handler writes
 * beat_pulse_start_tick each time a beat is accepted. We read that tick
 * here on the 10ms led_task tick and compute the current pulse envelope.
 *
 * Envelope: cosine half-cycle from full tint to zero over PULSE_DURATION_MS.
 * Result: a brief visible flash timed to each heartbeat. */
else if (led_mode == LED_MODE_PULSE_ON_BEAT) {
    uint32_t now_tick = xTaskGetTickCount();
    uint32_t since_beat_ms = (now_tick - beat_pulse_start_tick) * portTICK_PERIOD_MS;
    if (beat_pulse_start_tick != 0 && since_beat_ms < PULSE_DURATION_MS) {
        /* Cosine decay: 1.0 at t=0, 0.0 at t=PULSE_DURATION_MS */
        float p = (float)since_beat_ms / (float)PULSE_DURATION_MS;
        float env = (1.0f + cosf((float)M_PI * p)) / 2.0f;
        uint8_t tint = (uint8_t)(env * (float)PULSE_PEAK_DUTY * (float)brightness / 100.0f);
        effective_duty = tint;
    } else {
        effective_duty = 0;   /* Between beats: lens fully clear */
    }
}
```

**Pulse profile:**
- Duration: `PULSE_DURATION_MS = 150 ms`
- Peak tint: `PULSE_PEAK_DUTY = 80` (% of brightness)
- Envelope: `(1 + cos(πt/150)) / 2` (smooth decay from 1.0 → 0.0)

**Swift port:** trigger a 150 ms animation each time you receive a beat (after passing the §5.1 filters). Cosine envelope. Simple.

---

### 8.2 Programs 1 & 3 — Coherence-Breathe (+ Strobe)

Both modes share this block. They differ only in the final output: Program 1 writes `effective_duty` directly; Program 3 publishes `breathe_frac_q8` for the strobe ISR to consume.

```c
/* main.c:3445-3528 */
else if (led_mode == LED_MODE_COHERENCE_BREATHE ||
         led_mode == LED_MODE_COHERENCE_BREATHE_STROBE) {
    /* State persists across ticks. Reset on mode entry so every
     * entry starts at BPM_START and rebuilds the cycle fresh. */
    static uint32_t cb_cycle_ms = 10000;     /* current cycle duration */
    static uint32_t cb_cycle_start_tick = 0; /* when this cycle began */
    static led_mode_t cb_prev_mode = LED_MODE_STROBE;

    uint32_t now_tick = tick_count;
    if (cb_prev_mode != LED_MODE_COHERENCE_BREATHE &&
        cb_prev_mode != LED_MODE_COHERENCE_BREATHE_STROBE) {
        /* Entering the coherence-breathe family. Reset to 6.0 BPM
         * (quintet 30) and start this cycle fresh at now. */
        cb_cycle_ms = 300000u / ADAPT_QUINTET_START;
        cb_cycle_start_tick = now_tick;
        coh_pacer_current_bpm = ADAPT_QUINTET_START;
    }
    cb_prev_mode = led_mode;

    /* Elapsed within current cycle. */
    uint32_t elapsed_ms = (now_tick - cb_cycle_start_tick) * LED_TICK_MS;

    /* Did we cross the boundary? If so, latch new cycle duration
     * and reset the cycle clock. */
    if (elapsed_ms >= cb_cycle_ms) {
        if (coh_pacer_adaptive) {
            uint8_t target_q = adapt_resp_quintet();
            if (target_q > 0) {
                /* Slew-rate limit: max ADAPT_MAX_STEP quintets (0.2 BPM)
                 * per cycle. Prevents artifact spikes from driving large
                 * jumps (e.g. 4 → 8 BPM in one update). */
                uint8_t prev_q = coh_pacer_current_bpm;
                if (prev_q == 0) prev_q = target_q;  /* first latch: no slew */
                int8_t delta = (int8_t)((int16_t)target_q - (int16_t)prev_q);
                if (delta >  (int8_t)ADAPT_MAX_STEP) delta =  (int8_t)ADAPT_MAX_STEP;
                if (delta < -(int8_t)ADAPT_MAX_STEP) delta = -(int8_t)ADAPT_MAX_STEP;
                uint8_t new_q = (uint8_t)((int16_t)prev_q + delta);
                if (new_q < ADAPT_QUINTET_MIN) new_q = ADAPT_QUINTET_MIN;
                if (new_q > ADAPT_QUINTET_MAX) new_q = ADAPT_QUINTET_MAX;
                cb_cycle_ms = 300000u / new_q;
                coh_pacer_current_bpm = new_q;
            }
            /* If ring is empty keep previous cycle; dashboard keeps
             * showing last adopted value. */
        } else {
            /* Disabled: force back to 6.0 BPM (quintet 30) each cycle. */
            cb_cycle_ms = 300000u / ADAPT_QUINTET_START;
            coh_pacer_current_bpm = ADAPT_QUINTET_START;
        }
        cb_cycle_start_tick = now_tick;
        elapsed_ms = 0;
    }

    /* 40/60 inhale/exhale split of the current cycle. */
    uint32_t cb_inhale_ms = cb_cycle_ms * 40 / 100;
    uint32_t cb_exhale_ms = cb_cycle_ms - cb_inhale_ms;

    float frac = 0.0f;
    if (elapsed_ms < cb_inhale_ms) {
        float p = (float)elapsed_ms / (float)cb_inhale_ms;
        frac = (1.0f - cosf((float)M_PI * p)) / 2.0f;
    } else {
        float p = (float)(elapsed_ms - cb_inhale_ms) / (float)cb_exhale_ms;
        frac = (1.0f + cosf((float)M_PI * p)) / 2.0f;
    }

    /* Coherence → scale factor. */
    uint8_t coh = coh_get_coherence();           /* 0..100 */
    if (coh > 100) coh = 100;
    float coh_scale = 1.0f -
        ((float)coh * (100.0f - (float)COH_DUTY_FLOOR_PCT) / 10000.0f);

    float modulated = frac * coh_scale;

    /* Publish scaled value for the strobe ISR. */
    breathe_frac_q8 = (uint8_t)(modulated * 255.0f);

    if (led_mode == LED_MODE_COHERENCE_BREATHE) {
        effective_duty = (uint8_t)(modulated * (float)brightness);
    }
    /* COHERENCE_BREATHE_STROBE: ISR scales strobe dark duty by
     * breathe_frac_q8, so strobe intensity now tracks waveform ×
     * coherence the same way flat-tint opacity does. */
}
```

**Coherence scaling formula** (the key piece for biofeedback):

```
coh_scale = 1.0 − coh/100 × (1.0 − COH_DUTY_FLOOR_PCT/100)
          = 1.0 − coh/100 × 0.8                          (with default floor = 20)

coh = 0    → coh_scale = 1.0   (full waveform amplitude — lens tints fully on inhale)
coh = 50   → coh_scale = 0.6
coh = 100  → coh_scale = 0.2   (waveform amplitude scaled to 20%, lens stays mostly clear)
```

**Why the floor is 20%, not 0%.** Early builds tried `COH_DUTY_FLOOR_PCT = 0` (lens goes fully clear at peak coherence). User feedback: they lose the breathing visual cue entirely at the moment they're being rewarded. 20% keeps the rhythm visible.

**Swift port:** straightforward. Run a 100 Hz timer; track cycle boundaries; latch new cycle duration at each boundary using the slew-rate logic; output `modulated × brightness` as your lens command.

---

### 8.3 Program 2 — Coherence-Lens

```c
/* main.c:3557-3605 */
else if (led_mode == LED_MODE_COHERENCE_LENS) {
    static float coh_smooth = 0.0f;
    static led_mode_t prev_led_mode = LED_MODE_STROBE;

    uint8_t coh_raw = coh_get_coherence();
    if (coh_raw > 100) coh_raw = 100;

    /* On mode entry, snap smoothed value to current coherence
     * so we don't ramp the lens up from "dark" to whatever the
     * live coherence is. */
    if (prev_led_mode != LED_MODE_COHERENCE_LENS) {
        coh_smooth = (float)coh_raw;
    }
    prev_led_mode = led_mode;

    /* EWMA: alpha = 0.005 → ~2s time constant at 10ms ticks. */
    const float COH_ALPHA = 0.005f;
    coh_smooth += (((float)coh_raw) - coh_smooth) * COH_ALPHA;

    float s = coh_smooth;
    if (s < 0.0f) s = 0.0f;
    if (s > 100.0f) s = 100.0f;

    /* v4.14.29: apply difficulty via gamma curve.
     *   lens_clear_pct = (coh / 100) ^ gamma * 100
     * Higher gamma → steeper curve → more coherence required
     * for same visible lens response. But unlike knee-point
     * approach, the lens stays RESPONSIVE at every coherence
     * value — no dead zone. */
    uint8_t diff = coh_difficulty;
    if (diff > 3) diff = 0;
    float gamma = coh_difficulty_table[diff].gamma;
    float normalized = s / 100.0f;             /* 0..1 */
    float effective_s = powf(normalized, gamma) * 100.0f;

    /* Higher coh → clearer lens → lower duty. */
    uint32_t duty = (uint32_t)brightness * (uint32_t)(100.0f - effective_s) / 100;
    if (duty > 100) duty = 100;
    effective_duty = (uint8_t)duty;
}
```

**The full Program 2 mapping is:**

```
1. Snap coh_smooth = coh_raw on mode entry
2. coh_smooth += (coh_raw − coh_smooth) × 0.005       (EWMA, 100 Hz tick)
3. clamp coh_smooth to [0..100]
4. lens_clear_pct = (coh_smooth / 100) ^ gamma × 100   (gamma per difficulty)
5. duty = brightness × (100 − lens_clear_pct) / 100
```

**Swift port:** trivial. EWMA is one line; `powf(normalized, gamma)` is a `Foundation` `pow()`. Use the gamma table from §9.

---

### 8.4 Program 3 — Coherence-Breathe-Strobe

Same waveform / coherence scaling as Program 1 (§8.2). The only difference is that `effective_duty` is set by the strobe ISR instead of directly, and the ISR scales the **dark phase** of each strobe burst by `breathe_frac_q8`:

```
strobe_dark_burst_duty = breathe_frac_q8 / 255 × brightness × coh_scale
strobe_clear_phase_duty = 0
```

For an iOS port, you have two choices:

1. **Glasses-side strobe.** Run Programs 1/2 (no strobe) on iOS; for Program 3, set the strobe frequency / duty via `0xAB` / `0xAC` on the glasses, then run Program 1's waveform compute on iOS and send the modulated value as you would for Program 1 — but the glasses also need to know strobe is desired. This requires a way to tell the glasses "use my computed waveform as the strobe envelope" — there's no such opcode currently. Workaround: don't port Program 3 to iOS, leave it as glasses-side via `0xCA`.
2. **App-side strobe.** Run the strobe on iOS too: at the configured strobe frequency, toggle the lens between `brightness × coh_scale × breathe_frac` (dark phase) and 0 (clear phase) using `0xA5` (Static LED) at strobe rate. BLE round-trip latency makes this impractical above ~10 Hz, and you'd be sending hundreds of writes per second. Don't.

**Recommendation:** if you need Program 3, keep it on the glasses (use `0xCA` + `0xB7 3`). For Programs 0–2, port to iOS.

---

## 9. Coherence difficulty preset

```c
/* main.c:2163-2174 */
typedef struct {
    float gamma;   /* exponent on normalized coherence */
} coh_difficulty_t;

static const coh_difficulty_t coh_difficulty_table[4] = {
    { 1.0f },   /* Easy    — linear */
    { 1.5f },   /* Medium  */
    { 2.0f },   /* Hard    */
    { 3.0f },   /* Expert  */
};

static volatile uint8_t coh_difficulty = 0;   /* default Easy */
```

**Gamma curve:** `lens_clear_pct = (coh / 100) ^ gamma × 100`. All levels converge at `coh = 0` (lens dark) and `coh = 100` (lens fully clear). Between, monotonic in gamma.

Examples:

| Coherence | Easy (γ=1.0) | Medium (γ=1.5) | Hard (γ=2.0) | Expert (γ=3.0) |
|---|---|---|---|---|
| 25 | 25% | 13% | 6% | 2% |
| 50 | 50% | 35% | 25% | 13% |
| 75 | 75% | 65% | 56% | 42% |
| 100 | 100% | 100% | 100% | 100% |

> **Why gamma, not knee points.** v4.14.28 used `coh_threshold + coh_slope` knee curves. Expert with start=75 meant any coherence below 75 produced zero lens response — the user saw nothing even if they improved from 40 → 70. That kills operant conditioning because feedback goes silent in the very range the user is learning. Gamma keeps the lens responsive at every coherence value while still requiring higher coherence for the same clearness at harder settings.

Applied **only in Program 2**. Other programs ignore `coh_difficulty`.

---

## 10. Defaults table

Mirrors the defaults the firmware uses at first boot (before any `0xE0` / `0xB1` / etc. writes are persisted to NVS):

| Setting | Default | Opcode | NVS key |
|---|---|---|---|
| Brightness | 100% | `0xA2` | `KEY_BRIGHTNESS` |
| Session duration | 30 min | `0xA4` | `KEY_SESSION_MIN` |
| Strobe freq | 10 Hz (deci-Hz 100) | `0xAB` | `KEY_STROBE_DHZ` |
| Strobe duty | 50% | `0xAC` | `KEY_STROBE_DUTY` |
| Breathe BPM (fixed) | 6 | `0xB1` | `KEY_BREATHE_BPM` |
| Inhale ratio | 40% | `0xB2` | `KEY_BREATHE_INHALE` |
| Hold-top | 0 (×100 ms) | `0xB3` | `KEY_BREATHE_HOLD_TOP` |
| Hold-bottom | 0 (×100 ms) | `0xB4` | `KEY_BREATHE_HOLD_BOT` |
| Breathe waveform | 0 (sine) | `0xB5` | `KEY_BREATHE_WAVE` |
| PPG program | 0 (Heartbeat) | `0xB7` | not persisted |
| Coherence difficulty | 0 (Easy, γ=1.0) | `0xB8` | `KEY_COH_DIFFICULTY` |
| Adaptive pacer | 1 (ON) | `0xB9` | `KEY_COH_ADAPTIVE` |
| `min_ibis` | 20 | `0xE0` | `KEY_COH_MINIBIS` |
| `conf_threshold` | 50 | `0xE0` | `KEY_COH_CONFTH` |
| `vlf_band_lo / hi` | 1 / 2 | `0xE0` | `KEY_COH_VLF_LO/HI` |
| `lf_band_lo / hi` | 3 / 9 | `0xE0` | `KEY_COH_LF_LO/HI` |
| `hf_band_lo / hi` | 10 / 25 | `0xE0` | `KEY_COH_HF_LO/HI` |
| `lf_peak_lo / hi` | 3 / 9 | `0xE0` | `KEY_COH_PK_LO/HI` |
| `peak_halfwidth` | 0 | `0xE0` | `KEY_COH_PK_HW` |
| `coh_multiplier` | 100 | `0xE0` | `KEY_COH_MULT` |
| `COH_DUTY_FLOOR_PCT` | 20 | (constant) | not exposed |
| `COH_ALPHA` (EWMA) | 0.005 | (constant) | not exposed |
| `PULSE_DURATION_MS` | 150 | (constant) | not exposed |
| `PULSE_PEAK_DUTY` | 80 | (constant) | not exposed |

---

## 11. Notes for the iOS port

### What you actually need to send to the glasses

If you compute everything app-side, the only Edge opcode you need at runtime is **`0xA5` (Static LED mode, 1-byte arg 0..100)** — that's the "set lens duty directly" command. Push it on every render tick where the duty changes (10–20 Hz is plenty; the AC-sync timer on the glasses already smooths the PWM). The 0–100 duty argument lands in `effective_duty` directly.

You can also use `0xA2` (brightness) as the global ceiling and let your duty math output the modulation against it — but writing `0xA5` per tick is simpler.

**You do NOT need:**
- `0xCA` — that's the route for letting the glasses do the math.
- `0xCB` — same.
- `0xB7` — you're not running a glasses-side program.
- `0xE0` — you're not driving the glasses' coherence pipeline.

**You SHOULD still use:**
- `0xA2` brightness as your global cap.
- `0xA6` / `0xAB` / `0xAC` if you still want a strobe option (let the glasses handle it for Program 3).
- `0xA4` session duration for the auto-sleep timer.

### Swift implementation skeleton

```swift
import Accelerate

final class CoherencePipeline {
    // — Constants —
    static let N = 256
    static let fs: Float = 4.0            // Hz
    static let windowS: Float = 64.0      // = N / fs
    static let ringSize = 120
    static let updateMs = 1000
    static let alphaEWMA: Float = 0.005

    // — Tunables (mirror narbis_coh_params_t) —
    var minIbis: Int = 20
    var confThreshold: UInt8 = 50
    var vlfLo: Int = 1, vlfHi: Int = 2
    var lfLo:  Int = 3, lfHi:  Int = 9
    var hfLo:  Int = 10, hfHi: Int = 25
    var pkLo:  Int = 3, pkHi:  Int = 9
    var pkHw:  Int = 0
    var cohMult: Float = 100

    // — State —
    private var ring: [(beatMs: UInt32, ibiMs: UInt16)] = []
    private var rollingAvgMs: UInt32 = 0
    private var hann: [Float] = []
    private var fftSetup: vDSP.FFT<DSPSplitComplex>!
    private(set) var coherence: UInt8 = 0
    private(set) var respPeakMhz: UInt16 = 0
    private var cohSmooth: Float = 0
    private var adaptiveRing: [UInt16] = []   // mHz samples, max 15

    init() {
        hann = vDSP.window(ofType: Float.self, usingSequence: .hanningNormalized, count: Self.N, isHalfWindow: false)
        fftSetup = vDSP.FFT(log2n: 8, radix: .radix2, ofType: DSPSplitComplex.self)
    }

    /// Call once per beat from the H10 / Apple Watch / app PPG handler.
    func push(ibiMs: UInt16, confidence: UInt8, isArtifact: Bool) {
        guard confidence >= confThreshold, !isArtifact, ibiMs > 0 else { return }

        // Outlier gate (rolling avg × 1.75)
        if rollingAvgMs == 0 {
            rollingAvgMs = UInt32(ibiMs)
        } else if UInt32(ibiMs) > rollingAvgMs * 175 / 100 {
            return   // likely missed-beat double
        } else {
            rollingAvgMs = (rollingAvgMs * 7 + UInt32(ibiMs)) / 8
        }
        let nowMs = UInt32(CACurrentMediaTime() * 1000)
        ring.append((nowMs, ibiMs))
        if ring.count > Self.ringSize { ring.removeFirst() }
    }

    /// Call on 1 Hz timer (matches firmware coherence_task).
    func compute() {
        guard ring.count >= minIbis else { return }
        // 1. Restrict to last 64 s
        let lastMs = ring.last!.beatMs
        let cutoff = lastMs > UInt32(Self.windowS * 1000) ? lastMs - UInt32(Self.windowS * 1000) : 0
        let active = ring.filter { $0.beatMs >= cutoff }
        guard active.count >= minIbis else { return }

        // 2. Resample to 256-point grid at 4 Hz (linear interp; see §5.4)
        var grid = resampleToGrid(active)

        // 3. Detrend (vDSP.add / vDSP.subtract with mean)
        var mean: Float = 0
        vDSP_meanv(grid, 1, &mean, vDSP_Length(Self.N))
        var negMean = -mean
        vDSP_vsadd(grid, 1, &negMean, &grid, 1, vDSP_Length(Self.N))

        // 4. Hann window
        vDSP_vmul(grid, 1, hann, 1, &grid, 1, vDSP_Length(Self.N))

        // 5. FFT → magnitude²  (use vDSP_fft_zip; see §5.6)
        let psd = fft(grid)   // length N/2

        // 6. Band integration (§5.7)
        let vlf = (vlfLo...vlfHi).reduce(Float(0)) { $0 + psd[$1] }
        let lf  = (lfLo...lfHi  ).reduce(Float(0)) { $0 + psd[$1] }
        let hf  = (hfLo...hfHi  ).reduce(Float(0)) { $0 + psd[$1] }
        let total = vlf + lf + hf

        // 7. LF peak (§5.8)
        var peakBin = pkLo
        var peakPow = psd[pkLo]
        for i in (pkLo + 1)...pkHi where psd[i] > peakPow {
            peakPow = psd[i]; peakBin = i
        }
        if pkHw > 0 {
            let lo = max(0, peakBin - pkHw)
            let hi = min(Self.N/2 - 1, peakBin + pkHw)
            peakPow = (lo...hi).reduce(Float(0)) { $0 + psd[$1] }
        }

        // 8. Score (§5.9)
        if total > 1e-6 {
            let ratio = peakPow / total
            var c = ratio * cohMult
            c = max(0, min(100, c))
            coherence = UInt8(c)
        }
        let df = Self.fs / Float(Self.N)
        respPeakMhz = UInt16(Float(peakBin) * df * 1000)

        // 9. Feed adaptive pacer ring (only in-range)
        let mhz = respPeakMhz
        if mhz >= 50 && mhz <= 167 {
            adaptiveRing.append(mhz)
            if adaptiveRing.count > 15 { adaptiveRing.removeFirst() }
        }
    }

    /// Call on 100 Hz timer for Program 2 (Coherence-Lens).
    /// Returns lens duty 0..100 to send via 0xA5.
    func program2Duty(brightness: UInt8, difficulty: Int) -> UInt8 {
        cohSmooth += (Float(coherence) - cohSmooth) * Self.alphaEWMA
        let s = max(0, min(100, cohSmooth))
        let gammas: [Float] = [1.0, 1.5, 2.0, 3.0]
        let gamma = gammas[max(0, min(3, difficulty))]
        let normalized = s / 100
        let effectiveS = pow(normalized, gamma) * 100
        let duty = Float(brightness) * (100 - effectiveS) / 100
        return UInt8(max(0, min(100, duty)))
    }

    // …resampleToGrid, fft helpers, Programs 0 / 1 / 3 omitted; see §§5.4–5.6, 8.1–8.4
}
```

### Things to double-check after porting

1. **Endianness of `0xCA` payloads** — irrelevant for the app-side compute path, but if you ever drop back to `0xCA` for A/B comparison, `ibi_ms` is little-endian.
2. **Hann window normalization** — `vDSP.hanningNormalized` divides by N; the firmware doesn't. Either rescale or use an un-normalized window. The coherence score is a *ratio* (peak/total), so the absolute normalization cancels out — but the band powers in `0xF2` will differ in absolute magnitude. Doesn't affect lens behaviour.
3. **Mean drift after long sessions.** The firmware never resets `g_ibi_rolling_avg_ms` except on sensor disconnect. If your H10 has a flaky connection that re-pairs without an explicit disconnect, you may need to reset the rolling avg yourself on long silences.
4. **Adaptive pacer warm-up.** The first 15 seconds after the user opens Program 1/3 the adaptive ring isn't full yet, so the pacer holds at 6 BPM and starts walking after the ring fills. Match this — don't try to "instantly converge" by averaging fewer samples.
5. **Mode-entry snap.** Both EWMA in Program 2 (`coh_smooth = coh_raw` on entry) and the cycle-clock in Programs 1/3 (`cb_cycle_start_tick = now`) reset on mode entry. If you let the user switch programs mid-session, replicate these resets or transitions will look jarring.

### Source of truth

- Firmware: `C:\NARBIS APP\Oct_4_25\Clone\edge-firmware\v4\Code-Glasses\main\main.c` — line ranges noted throughout this doc.
- Coherence params struct + defaults macro: [`protocol/narbis_protocol.h`](./narbis_protocol.h) (sibling file in this repo) lines 444–496.
- Battle-tested TypeScript parser for the `0xF2` telemetry frame: `dashboard/src/ble/parsers.ts` (in the same repo) — useful if you want a second reference implementation.
