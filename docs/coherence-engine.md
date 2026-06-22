# Narbis Coherence Engine — Algorithm & Architecture

> **What this is.** The app-side **Coherence Engine** that runs inside the Narbis earclip dashboard
> (`dashboard/src/engine/`). It computes heart-rate-variability (HRV) coherence, paces your
> breathing, finds your resonance frequency, and drives the Edge glasses' electrochromic lens —
> entirely on the app side, with the glasses acting as a display.
>
> **Companion docs.**
> - [`coherence-algorithm-reference.md`](./coherence-algorithm-reference.md) — the **firmware** coherence
>   pipeline that runs *on the glasses* (256-pt FFT). Used by the **Firmware** engine (Standard /
>   on-glasses).
> - [`bluetooth-protocol.md`](./bluetooth-protocol.md) — the BLE surface (opcodes, relay frames) the
>   engine commands the glasses through (§4.3, §4.7).
>
> **Source of truth.** The dashboard engine (`dashboard/src/engine/*.ts`) and the iOS Swift package
> (`NarbisCoherenceEngine.swift`) are kept in lock-step — same algorithms, same tunables, same
> defaults. Every stage below maps to a file in `dashboard/src/engine/` and to a `class`/`func` in the
> Swift engine; line-level behavior matches. Defaults/ranges live in `tunables.ts` (`DEFAULT_TUNABLES`)
> and in the Swift `CoherenceTunables` struct, and are exposed (with a click-to-expand ⓘ on each) in the
> dashboard's Coherence Engine panel. **§5 is the complete tunable reference** — every knob, with the
> same explanation the in-app ⓘ shows.

---

## Revision history

> TL;DR of behavior changes to the app-side engine. The dashboard package is unversioned
> (`package.json` = `0.0.0`), so changes are referenced by date + PR; the glasses firmware version is
> the lens/breathe-sync target the engine drives over BLE.

| Date | Change | Dashboard | Glasses FW |
|---|---|---|---|
| 2026-06-22 | **Mode B/C resonance reliability fixes** ([#81](https://github.com/narbiscorp/edge-earclip/pull/81)). **(1) ACC respiration no longer frequency-doubles.** The breathing rate is now estimated by **summing the three accelerometer axes' periodograms** instead of the vector-magnitude `√(x²+y²+z²)` signal — the magnitude (large gravity DC + the squaring nonlinearity) injected a strong 2× component and reported ~2× the true rate, so verification failed on every dwell (on a real session it read a steady **9.34 br/min for a genuine ~4–5 br/min breath**). **(2) Per-breath retest.** A dwell now re-tests only the *missed* breaths and **accepts on partial verification** (≥1 confirmed), with a hard estimate-breath cap, so the search advances instead of re-running the whole dwell and freezing on one rate (new `dwellVerifyTarget`, `dwellMaxEstimateBreaths`; the Mayer-wave abort is preserved). **(3) 60 s quiet settling** for Mode B & C (new `initialSettleS=60`, `modeCWarmupS` 120→60, `modeCWarmupMaxS` 240→120): the cue is paused, the chime muted, and the lens held fully clear while the sensors warm up. | `0.0.0` (app-side only) | ≥ 4.15.5 (unchanged) |

---

## Table of contents
- [Revision history](#revision-history)
1. [Why an app-side engine](#1-why-an-app-side-engine)
2. [The four engines](#2-the-four-engines)
3. [Signal flow at a glance](#3-signal-flow-at-a-glance)
4. [How fast each stage runs](#4-how-fast-each-stage-runs)
5. [Tunable reference — every knob](#5-tunable-reference--every-knob)
6. [Stage 1 — beat ingest + artifact gate](#6-stage-1--beat-ingest--artifact-gate)
7. [Stage 2 — detrend + Lomb–Scargle (Welch-averaged)](#7-stage-2--detrend--lombscargle-welch-averaged)
8. [Stage 3 — coherence ratio (CR) + squash](#8-stage-3--coherence-ratio-cr--squash)
9. [Stage 4 — resonance read-back & HRV companions](#9-stage-4--resonance-read-back--hrv-companions)
10. [Stage 5 — the follow pacer (two-speed slew)](#10-stage-5--the-follow-pacer-two-speed-slew)
11. [Stage 6 — lens drive (firmware-rendered)](#11-stage-6--lens-drive-firmware-rendered)
12. [Mode A — Follow](#12-mode-a--follow)
13. [Breath–heart coherence (real γ²/phase) & the Mayer-wave confound](#13-breathheart-coherence-real-γphase--the-mayer-wave-confound)
14. [Mode B — Resonance (search + verify + maintain)](#14-mode-b--resonance-search--verify--maintain)
15. [Mode C — Settle & Find](#15-mode-c--settle--find)
16. [Firmware engine — Standard (on-glasses)](#16-firmware-engine--standard-on-glasses)
17. [Tuning](#17-tuning)
18. [Reference literature](#18-reference-literature)
19. [Commercial / prior-art examples](#19-commercial--prior-art-examples)

---

## 1. Why an app-side engine

Historically the **glasses firmware** computed coherence (a 256-point FFT on the incoming inter-beat
intervals) and drove the lens itself — see [`coherence-algorithm-reference.md`](./coherence-algorithm-reference.md).
That works but is constrained: a fixed FFT grid (0.0156 Hz bins), integer breathing rates, no
independent respiration sensor, and slow to iterate.

The Coherence Engine moves **all signal processing into the app**:

- **Richer math** — smoothness-priors detrending, a dense, Welch-averaged **Lomb–Scargle** periodogram
  (spectrum-analyzes the unevenly-sampled beat series *directly*, no resampling artifact), a
  field-standard coherence ratio, an adaptive **Lipponen–Tarvainen** artifact gate, a **real
  cross-spectral breath–heart coherence** (γ²/phase), an automated **resonance-frequency search**, and
  an independent **accelerometer respiration** channel for verification.
- **Fast iteration** — every constant is a live, unit-tested tunable (§5).
- **The glasses become a display.** The engine computes *what the lens should do* and commands the
  firmware's own smooth breathe / static / strobe program over BLE — it does **not** stream per-tick
  PWM (choppy over BLE). See [§11](#11-stage-6--lens-drive-firmware-rendered).

The engine is a main-thread singleton (`coherenceEngine`, an `EventTarget`) mirroring the
`edgeDevice` / `polarH10` device objects. It ingests beats + accelerometer samples from the existing
device events, self-ticks, and publishes status (coherence, CR, breath–heart γ², resp Hz, pacer BPM,
Mode B/C state) via `CustomEvent`s. The 1 Hz Lomb–Scargle (~1–3 ms on a few hundred beats) is cheap
enough for the main thread.

---

## 2. The four engines

The dashboard's engine selector is mutually exclusive — exactly one engine is active. `EngineMode` is
`firmware | modeA | modeB | modeC`:

| Engine | Name | Coherence computed by | Paced by | Needs H10 ACC? |
|---|---|---|---|---|
| **Firmware** | **Standard (on-glasses)** | **firmware** (its own 256-pt FFT) | firmware adaptive pacer | no |
| **Mode A** | **Follow** | app (engine) | app — *follows* your drifting resonance | no |
| **Mode B** | **Resonance** | app (engine) | app — *searches* for your resonance frequency | **yes** |
| **Mode C** | **Settle & Find** | app (engine) | app — Mode A warm-up → seeded Mode B search | **yes** |

- **Firmware** is the legacy on-glasses path: the engine is off, the app forwards beats (`0xCA`) and
  the glasses compute coherence and render the lens. Full pipeline in
  [`coherence-algorithm-reference.md`](./coherence-algorithm-reference.md). See [§16](#16-firmware-engine--standard-on-glasses).
- **Mode A (Follow)** continuously tracks the rate where your HRV is strongest and paces you toward it,
  clearing the lens as coherence rises. See [§12](#12-mode-a--follow).
- **Mode B (Resonance)** runs the Lehrer/Vaschillo resonance assessment automatically — sweeps rates,
  finds the HRV-amplitude peak, *verifies* it with the accelerometer, locks and tracks your resonance
  frequency. See [§14](#14-mode-b--resonance-search--verify--maintain).
- **Mode C (Settle & Find)** is the "just press start" mode: it runs the Mode A Follow warm-up until
  your breathing is steady **and** the accelerometer confirms it, then hands off — atomically, seeded
  at the settled rate — into the exact Mode B search. See [§15](#15-mode-c--settle--find).

Modes A/B/C run the app engine and set the firmware program aside; selecting Firmware stops the engine
and restores the firmware program. **Mode B and Mode C require a Polar H10** (validated beats *and* its
accelerometer); Mode A works with any validated beat source (H10 or earclip).

---

## 3. Signal flow at a glance

```
   Polar H10 RR + monotonic beat timestamps                 H10 accelerometer (Mode B/C only)
   (or earclip beats — Mode A only)                                 │ x/y/z @ 50 Hz (Polar PMD)
            │                                                        ▼
            ▼                                              ┌────────────────────────────┐
   ┌──────────────────────┐                               │ RespirationFromACC          │
   │ §6 Artifact gate      │  adaptive dRR,                │ |x,y,z| → detrend+Hann →    │
   │ AdaptiveDRRGate /      │  drop (no interpolate)        │ periodogram → prominence    │
   │ IBIIngest beat ring    │                               │ peak + sway floor + octave  │
   └─────────┬─────────────┘                               │ guard + harmonic-robust conf│
             │ clean (beatTimeS, rrMs) ring                 └─────────────┬──────────────┘
             ▼                                                 measured BPM │ + confidence
   ┌──────────────────────┐   1 Hz                                         │  + ACC mag window
   │ §7 detrend → LS PSD    │──────────────┬───────────────┐              │
   │ (Welch-averaged)       │              │               │              │
   └─────────┬─────────────┘              │               ▼              ▼
             ▼                            ▼      ┌──────────────────────────────────┐
   ┌──────────────────────┐    ┌────────────────┐│ §13 breath–heart γ²/phase         │ (Mode A
   │ §8 CR = win/(total−win)│   │ §9 LF readback ││ cross-spectrum(HR, ACC resp)      │  display)
   │ coh% = 100·CR/(CR+k)   │   │ → pacer target ││ → confound flag                   │
   └─────────┬─────────────┘    └───────┬────────┘└──────────────────────────────────┘
             │ coh% (lens depth)         │ resp mHz
             │                           ▼
             │                  ┌────────────────────┐         ┌─────────────────────┐
             │                  │ §10 FollowPacer     │         │ §14 ResonanceCtrl   │ (Mode B/C
             │                  │ slew + two-speed    │◄────────┤ hill-climb + per-   │  after gate)
             │                  │ jump (quintets)     │ B/C     │ dwell verification  │
             │                  └─────────┬──────────┘ drives   └─────────────────────┘
             ▼                            ▼
                       ┌────────────────────────────────────┐
                       │ §11 LensState → edgeDevice.driveLens │  ~1 Hz + per breath boundary
                       └────────────────┬───────────────────┘
                                        ▼
                          firmware breathe / static / strobe program (renders the smooth cycle)
                                        ▼
                          on-screen cue + chime lock to the engine's breath clock
```

For Mode C, the left/centre path (LS → CR → pacer) runs exactly as Mode A during warm-up; once the
warm-up gate passes, the ResonanceController (right) is created and becomes the sole pacer source.

---

## 4. How fast each stage runs

| Stage | Cadence | Where |
|---|---|---|
| Beat ingest + artifact gate | per BLE notification (~1 Hz at rest; H10 batches 1–2 RR) | `onH10RR` / `onRR` → `IBIIngest` |
| ACC ingest | per PMD packet (batch of samples, ~50 Hz) | `onAccPacket` → `RespirationFromACC` |
| Detrend + Lomb–Scargle + CR + pacer push + breath–heart γ² | **1 Hz** | `tick1Hz()` |
| Lens param push (`emitLens`) | **1 Hz** + on each breath boundary | `tick1Hz` / `onBreathBoundary` |
| Breath-clock tick (boundary detection) | ~83 ms (12 Hz) | `lensTick()` |
| Pacer latch / Mode B controller advance / Mode C gate | each **breath-cycle boundary** (~10 s @ 6 BPM) | `onBreathBoundary()` |
| On-screen cue / chime | RAF / 100 ms, sampling `coherenceEngine.breathCyclePos()` | `BreathCue` / `useBreathPhase` |

End-to-end latency a user feels: ≤ 1 s (next LS compute) + lens response. The lens itself is rendered
by the firmware at 100 Hz, so the *waveform* is smooth regardless of the 1 Hz param cadence.

---

## 5. Tunable reference — every knob

Everything below is in `tunables.ts` (`DEFAULT_TUNABLES`) and the Swift `CoherenceTunables` struct, and
is live-tunable from the dashboard's **Coherence Engine** panel — each field has a click-to-expand **ⓘ**
with the same text reproduced here. All values are scalars; quintet = BPM × 5 (0.2-BPM resolution).
Sections are shown for the mode(s) they apply to. **Mode C uses every Mode A and Mode B section** (it
runs the Mode A warm-up then the Mode B search) plus its own warm-up gate. The **Firmware** engine has
no app-side tunables — see [`coherence-algorithm-reference.md`](./coherence-algorithm-reference.md).

### 5.1 Ingest & artifact gate — *Modes A, B, C*

- **`confThreshold`** — default **50**, range 0–100. Beats whose quality score is below this are dropped
  before analysis. The Polar H10 reports 100, so this mainly gates noisier sources. Higher = stricter.
  Leave at 50 for H10.
- **`ringSize`** — default **600** beats, range 256–1024. How many recent beats are held in memory. Must
  cover the coherence window plus the Mode B dwell history (~600 is roughly 8–10 min at rest). Rarely
  needs changing.
- **`dRRFloorMs`** — default **180** ms, range 50–400. Floor on the adaptive artifact gate: a beat is
  rejected when its interval jumps more than max(5.2 × recent variability, this floor) from the previous
  one. The floor stops the gate over-rejecting when breathing is very regular. Raise toward 250 if real
  beats are dropped; lower toward 120 to catch subtler ectopics.

### 5.2 Lomb–Scargle & coherence — *Modes A, B, C*

- **`coherenceWindowS`** — default **64** s, range 32–128. Trailing window the Lomb–Scargle spectrum runs
  over. Fixed at 64 s, which sets the ~0.0156 Hz resolution the whole engine assumes. Changing it shifts
  every band — leave it unless you know why.
- **`lsFreqLo`** — default **0.0033** Hz, range 0.001–0.02. Low edge of the full analysis band (also the
  CR total-power band). Widen only to chase unusual signals.
- **`lsFreqHi`** — default **0.4** Hz, range 0.2–0.5. High edge of the analysis band. 0.4 Hz spans up
  through the HF range.
- **`lsDf`** — default **0.002** Hz, range 0.001–0.005. Frequency-grid spacing for the spectrum. Denser
  (smaller) sharpens peak localization at some CPU cost. 0.002 Hz is a good balance.
- **`peakSearchLo`** — default **0.04** Hz, range 0.02–0.1. Low edge of the band the coherence peak is
  searched in (the published resonance range starts at 0.04 Hz = 2.4 br/min).
- **`peakSearchHi`** — default **0.26** Hz, range 0.15–0.35. High edge of the coherence peak search
  (0.26 Hz = 15.6 br/min). CR = peak power divided by the rest of the band.
- **`resonanceHz`** — default **0.015** Hz, range 0.005–0.03. Half-width of the integration window around
  the coherence peak (±0.015 Hz). Wider captures a broader resonance hump and raises the score; narrower
  is stricter.
- **`lfReadbackLo`** — default **0.04** Hz, range 0.02–0.1. Low edge of the LF-only band the Follow pacer
  reads your resonance rate back from. Kept separate from the CR search band so the pacer tracks
  breathing.
- **`lfReadbackHi`** — default **0.15** Hz, range 0.1–0.25. High edge of the pacer readback band
  (0.15 Hz = 9 br/min).
- **`cohSquashK`** — default **3.0**, range 1.0–8.0. **THE primary feel knob.** Maps the raw coherence
  ratio to the 0–100 score: `coh% = 100 × CR / (CR + k)`. LOWER k (toward 1) is easier — the score climbs
  fast and saturates. HIGHER k (toward 8) is harder — you must hold strong coherence for a high score.
  Tune this first.
- **`lfBandLo`** — default **0.04** Hz, range 0.02–0.1. Low edge of the LF band for the LF and LF/HF
  readouts (display only — does not drive the lens).
- **`lfBandHi`** — default **0.15** Hz, range 0.1–0.2. High edge of the LF band.
- **`hfBandLo`** — default **0.15** Hz, range 0.1–0.2. Low edge of the HF band for the HF readout.
- **`hfBandHi`** — default **0.4** Hz, range 0.3–0.5. High edge of the HF band.

### 5.3 Detrend & spectral averaging — *Modes A, B, C*

- **`detrendEnabled`** — default **1 (on)**, range 0/1. Turns on smoothness-priors detrending (the Kubios
  method) before the coherence spectrum. 1 = on (removes slow drift and very-low-frequency trend so it
  cannot inflate the total-power term and depress the score); 0 = the legacy mean-only removal. Leave on.
  *(Stored as numeric 0/1 in the app's scalar schema; the Swift struct exposes it as a `Bool`.)*
- **`detrendLambda`** — default **500**, range 100–1000. Stiffness of the detrend trend line (Tarvainen
  lambda). HIGHER (toward 1000) removes only the slowest drift and keeps more low-frequency content;
  LOWER (toward 100) removes faster wander too. 500 puts the cutoff near 0.035 Hz, below the LF band, so
  it cleans drift without touching the breathing peak.
- **`spectralSegments`** — default **3**, range 1–5. How many overlapping sub-windows the spectrum is
  averaged over (Welch averaging). 1 is a single periodogram (sharpest resolution, noisiest score). 3
  averages three sub-windows, which steadies the live score at the cost of coarser resolution within
  each. 2–3 is a good balance; above 4 the LF band under-resolves.
- **`spectralOverlapPct`** — default **50** %, range 0–75. How much the averaged sub-windows overlap. More
  overlap forms more sub-windows from the same data (steadier) at the cost of correlated segments. 50% is
  standard.
- **`bhSmoothAlpha`** — default **0.08**, range 0.02–0.5. Time-smoothing for the measured breath–heart
  coherence readout (γ² and phase). Each 1 Hz cross-spectrum estimate is noisy, so the displayed value is
  an exponential moving average; the phase is a coherence-weighted circular mean so low-coherence moments
  barely move it. LOWER (toward 0.02) is steadier but slower to react; higher (toward 0.5) tracks faster
  but jitters more. 0.08 is about a 12-second average.

### 5.4 Lens program — *Modes A, B, C*

- **`ewmaAlpha`** — default **0.005**, range 0.002–0.02. Legacy smoothing for the old app-rendered lens.
  The firmware now renders the cycle and depth tracks live coherence, so this has little effect. Leave at
  default.
- **`gammaEasy`** — default **1.0**, range 0.5–4.0. Difficulty curve for Easy: lens depth =
  `brightness × (1 − (coh/100)^gamma)`. Gamma 1.0 is linear (50% coherence = 50% clear).
- **`gammaMedium`** — default **1.5**, range 0.5–4.0. Difficulty curve for Medium: the lens demands
  somewhat higher coherence before clearing than Easy.
- **`gammaHard`** — default **2.0**, range 0.5–4.0. Difficulty curve for Hard: clears noticeably slower —
  you hold higher coherence to open the lens.
- **`gammaExpert`** — default **3.0**, range 0.5–5.0. Difficulty curve for Expert: the lens only clears
  near peak coherence. Pick the level in the main controls; these set what each level means.
- **`dutyFloorPct`** — default **20** %, range 0–50. Minimum lens darkness at peak coherence for the
  legacy app-rendered breathe cue, so it never fully vanishes. With the firmware rendering the cycle now
  this has limited effect; 0 lets the lens clear fully at perfect coherence.
- **`heartbeatPulseMs`** — default **150** ms, range 100–300. Width of the per-beat flash in the Heartbeat
  program. ~150 ms reads as a gentle pulse.
- **`heartbeatPeakDuty`** — default **80** %, range 0–100. Peak darkness of the Heartbeat flash. 80% is a
  soft pulse.
- **`breatheInhalePct`** — default **40** %, range 20–70. Inhale fraction of each breath cycle. 40 =
  inhale 40% / exhale 60%; the longer exhale is the standard resonance-breathing shape. Sent to the
  glasses as the breathe inhale ratio.

### 5.5 Mode A — Follow pacer — *Mode A (and Mode C warm-up)*

- **`quintetMin`** — default **15** (3.0 BPM), range 10–30. Lowest pace the engine will set, in quintets
  (BPM × 5). The pace is clamped to this floor.
- **`quintetMax`** — default **60** (12.0 BPM), range 40–70. Highest pace, in quintets. Clamped to this
  ceiling.
- **`quintetDefault`** — default **30** (6.0 BPM), range 15–60. Starting pace before the engine has
  tracked your rate.
- **`pacerAvgN`** — default **15** samples, range 8–30. How many 1 Hz resonance readings are averaged to
  set the pacer target. More (toward 30) is smoother but laggier; fewer (toward 8) is snappier but
  jumpier. Keep it fairly smooth — the two-speed jump handles fast catch-up.
- **`pacerSlewQuintet`** — default **1**, range 1–3. The gentle glide rate when the pace is near target:
  1 = ±0.2 BPM per breath. Intentionally slow so the cue does not lurch. Big gaps are handled by the jump
  below, not by raising this.
- **`pacerJumpThresholdBPM`** — default **0.5** BPM, range 0.4–3. Two-speed pacer: when your detected
  breathing rate is at least this far from the current pace AND stays that far for the Jump-sustain
  breaths, the pace SNAPS straight to it instead of crawling. Lower jumps more eagerly; raise toward 2 if
  it over-reacts.
- **`pacerJumpSustainBreaths`** — default **2** breaths, range 1–6. How many breaths in a row the gap must
  persist before the pace snaps — the wall against a transient bad reading causing a jump. 1 snaps almost
  immediately; 2–3 is safer. If catch-up feels too slow, lower this.

### 5.6 Mode B — Fast amplitude — *Mode B (and Mode C search)*

- **`ampWindowBreaths`** — default **2.5** breaths, range 2.0–3.0. Mode B averages HRV amplitude over this
  many recent breaths per dwell. ~2.5 balances responsiveness against noise.

### 5.7 Mode B — Resonance search — *Mode B (and Mode C search)*

- **`dwellBreaths`** — default **6** breaths, range 4–8. How many breaths Mode B holds each candidate rate
  before scoring it. Longer is more reliable but slows the search. 6 is a good balance.
- **`dwellEstimateFraction`** — default **0.6**, range 0.5–0.7. Fraction at the START of each dwell that is
  discarded as settling while the pacer slews; estimate breaths are collected after it. 0.6 ⇒ ~3 of the
  first breaths discarded.
- **`dwellVerifyTarget`** — default **2** breaths, range 1–5. How many breaths must be **confirmed** against
  the accelerometer before a rate is accepted. The dwell keeps re-testing breaths at the same rate until it
  reaches this (or hits the cap below) rather than discarding the whole dwell on one miss. Lower = faster
  but slightly noisier amplitude.
- **`dwellMaxEstimateBreaths`** — default **6** breaths, range 3–12. Hard cap on estimate breaths (incl.
  re-tests) before the search **must** decide — guarantees it never freezes on one rate. If ≥1 breath
  confirmed it advances on partial verification; if none did it charges an unverified dwell.
- **`initialSettleS`** — default **60** s, range 0–180. **Mode B only:** a quiet warm-up at the very start
  (cue, chime, and lens held paused/clear) while you breathe naturally and the sensors fill their windows;
  the resonance search begins after it. Mode C uses its own warm-up minimum (`modeCWarmupS`) as its
  settling instead.
- **`probeStepInitBPM`** — default **0.4** BPM, range 0.3–0.6. Initial step size as Mode B brackets the
  resonance peak. Bigger is faster but coarser.
- **`probeStepFloorBPM`** — default **0.2** BPM, range 0.1–0.3. Finest step the search resolves on the
  grid. The peak is then refined by a parabolic fit below this.
- **`epsilonPctOfA`** — default **0.05**, range 0.03–0.1. Hysteresis: how much higher one rate's amplitude
  must be (as a fraction of A) to count as better, so noise does not flip the bracket. 5%.
- **`searchLoBPM`** — default **4.0** BPM, range 3.5–4.5. Low end of the breathing-rate range Mode B
  searches. Narrow the range if you know roughly where your resonance is.
- **`searchHiBPM`** — default **7.5** BPM, range 7.0–8.0. High end of the search range. Most adults
  resonate around 5.5–6 br/min.
- **`respVerifyToleranceBPM`** — default **0.8** BPM, range 0.2–1.0. How close the accelerometer breathing
  rate must be to the paced rate for a dwell to count as followed. The 45 s respiration window can only
  resolve rate to ~0.7–1.3 br/min, so values much below 0.8 reject real breathing. RAISE toward 1.0 if
  good dwells keep being rejected; lower only if sway is being accepted.
- **`confirmProbeBPM`** — default **0.5** BPM, range 0.3–0.7. On a warm start from a saved resonance
  frequency, the half-range re-checked around it before re-locking.
- **`maxUnverifiedDwells`** — default **12**, range 4–24. Mode B aborts the search after this many dwells
  in a row it cannot verify against the accelerometer (you are moving or not following). RAISE if it
  gives up too readily; the hold-still hint appears as this climbs.
- **`ditherAmpBPM`** — default **0.1** BPM, range 0.05–0.15. While holding lock, the pace is nudged by this
  much (sub-perceptual) to keep tracking a drifting resonance.
- **`ditherPeriodS`** — default **180** s, range 120–300. Period of the maintenance dither.
- **`escGainBPM`** — default **0.15**, range 0.05–0.3. How aggressively the held lock follows a drifting
  resonance. Higher tracks faster but can wander.
- **`escMaxStepBPM`** — default **0.05** BPM, range 0.02–0.1. Per-cycle cap on how far the lock can move,
  so a noisy reading cannot yank it.
- **`escMeanAlpha`** — default **0.02**, range 0.01–0.05. High-pass on the amplitude objective so a uniform
  fade (fatigue) is not mistaken for a gradient. Lower = longer memory.
- **`decayFastAlpha`** — default **0.2**, range 0.1–0.4. Fast amplitude average for the sudden-loss
  detector. A sudden drop of the fast average below the slow one triggers a re-probe.
- **`decaySlowAlpha`** — default **0.02**, range 0.01–0.05. Slow amplitude average (the reference) for the
  sudden-loss detector.
- **`reprobeDecayPct`** — default **0.15**, range 0.1–0.2. If HRV amplitude falls at least this fraction
  below its slow average and stays there, Mode B re-probes around the lock. 0.15 = 15%.
- **`reprobeSustainS`** — default **120** s, range 60–180. How long the amplitude drop must persist before
  a re-probe.
- **`reprobeCapS`** — default **180** s, range 120–300. Minimum time between re-probes, so it cannot thrash.

### 5.8 Mode B — ACC respiration — *Mode B (and Mode C)*

- **`accSampleHz`** — default **50** Hz, range 25–200. Polar accelerometer sample rate. MUST match the
  rate the PMD stream is started at (50 Hz) — changing only this desyncs the timing.
- **`respBandLo`** — default **0.05** Hz, range 0.02–0.1. Low edge of the band the breathing peak is
  searched for in the accelerometer (0.05 Hz = 3 br/min). The sway floor further de-weights the very low
  end.
- **`respBandHi`** — default **0.4** Hz, range 0.3–0.6. High edge of the accelerometer breathing band
  (0.4 Hz = 24 br/min). Excludes higher-frequency motion.
- **`respWindowS`** — default **45** s, range 30–60. Trailing window the accelerometer respiration estimate
  runs over. 45 s gives a clean peak but lags rate changes slightly. (The estimate runs on the three axes'
  summed periodograms, not the vector magnitude — see §14.4.)
- **`respConfidenceMin`** — default **0.3**, range 0.3–0.6. Minimum spectral peakiness for the
  accelerometer breathing estimate to be trusted for verification. If Mode B keeps saying it cannot
  confirm your breathing even when you hold still, LOWER toward 0.3; raise if sway is being accepted.
- **`respMinHz`** — default **0.08** Hz, range 0.05–0.12. Accelerometer peaks below this (~4.8 br/min) are
  treated as body sway and de-weighted, so the verifier locks onto real breathing (~6) instead of
  postural drift (~3.9). RAISE if a slow wobble still reads as breathing; LOWER for genuinely slow
  (under 5 br/min) breathers.
- **`respNearPeakHz`** — default **0.04** Hz, range 0.02–0.08. The ± window around the detected peak counted
  as the breath when scoring confidence. Wider tolerates a slightly spread peak (higher confidence);
  narrower is stricter.
- **`respHarmonicExcludeMult`** — default **1.6** ×, range 1.3–2.5. Confidence ignores spectral power above
  this multiple of the breathing rate, so the 2nd and 3rd harmonics of a non-sinusoidal breath do not
  drag the score down. 1.6 cuts just below the 2× harmonic.

### 5.9 Mode C — Settle & Find (warm-up gate) — *Mode C*

- **`modeCWarmupS`** — default **60** s, range 30–300. Minimum time in the quiet Follow warm-up (settling)
  before Mode C hands off to the resonance search, even if your breathing is already steady and confirmed.
  The cue/chime/lens fade are paused during it (see §15). Gives you time to settle in.
- **`modeCWarmupMaxS`** — default **120** s, range 60–600. Upper bound on the warm-up. Past this, Mode C
  transitions on confident breathing alone without waiting for the steadiness test, so a naturally
  variable breather is not trapped in warm-up. It NEVER relaxes the accelerometer-confirmation requirement.
- **`modeCStabilityWindowS`** — default **30** s, range 10–60. Trailing window over which Mode C measures
  how steady your detected breathing rate is, and how consistently the accelerometer can see your breath.
- **`modeCStabilityBpmSd`** — default **0.4** BPM, range 0.2–1.5. How steady your breathing must be to
  hand off before the cap: the detected rate must vary no more than this (standard deviation, BPM) over
  the stability window. LOWER is stricter. 0.4 is tight, so many steady breathers still transition on the
  cap; raise toward 0.6–0.8 if it rarely passes the real gate.

> **iOS note.** The Swift `CoherenceTunables` carries the identical keys + defaults, with three
> serialization-only differences (no behavior change): the LF/HF bands are Swift tuples
> (`lfBand`/`hfBand`) rather than four scalars; the four difficulty gammas are a `gammaTable` array;
> and the Swift struct adds `logGapToleranceFactor` (1.5) for the offline session-log dropout flag,
> which the dashboard doesn't need.

---

## 6. Stage 1 — beat ingest + artifact gate

`adaptiveDrrGate.ts` (the shared gate) + `ibiIngest.ts` (the time-stamped ring); Swift `IBIIngest`. A
beat is accepted iff:

1. `confidence ≥ confThreshold` and `250 ms < RR < 2500 ms` (24–240 bpm physiological bounds);
2. once ≥ 8 successive-difference samples exist, the adaptive **Lipponen–Tarvainen** gate passes:

```
dRR  = RR_n − RR_{n−1}
thr  = max( 5.2 × quartileDeviation(recent dRR),  dRRFloorMs )
reject if |dRR| > thr        // and do NOT advance lastRR on a reject
```

`quartileDeviation` = Q3 − Q1 of the recent |dRR| (64-sample window). There is **no fixed ±band** —
that clips legitimate large respiratory-sinus-arrhythmia swings at high coherence. The floor stops the
gate failing open when variability ≈ 0 (calm regular breathing). Rejected beats are **dropped, not
interpolated**; not advancing `lastRR` stops one artifact cascading a false rejection onto the next
good beat. The same gate is used by every beat path, so all agree on what an artifact is. H10 batch
timestamps are reconstructed per beat from the notification arrival time (the newest interval ends at
the arrival time; each earlier beat precedes its successor by that successor's RR).

---

## 7. Stage 2 — detrend + Lomb–Scargle (Welch-averaged)

`lombScargleCore.ts` / Swift `LombScargleCore`. The RR series is sampled once per beat — unevenly in
time. Rather than resample onto a uniform grid (the firmware's approach, which can smear the spectrum),
the engine runs the **variance-normalized Lomb–Scargle** periodogram directly on the irregular
`(beatTimeS, rrMs)` pairs.

**Detrend (#1).** Before the spectrum, the RR series (treated as evenly spaced by beat index) is
detrended with the **smoothness-priors** method (Tarvainen 2002 / Kubios) when `detrendEnabled`: the
slow trend solving `(I + λ²·D₂ᵀD₂)·trend = z` is subtracted, with `λ = detrendLambda` setting the
cutoff (~0.035 Hz at λ=500, below the LF band). This removes slow drift / VLF that would otherwise
inflate the CR "total" term and depress the score, without touching the breathing peak. (`M` is a
symmetric pentadiagonal SPD matrix solved banded in O(N) via LDLᵀ.) Disabled ⇒ plain mean removal.

**Periodogram.** For each grid frequency `f` (from `lsFreqLo` to `lsFreqHi` step `lsDf`), with
`ω = 2πf` and the detrended series `y`:

```
τ   = atan2( Σ sin 2ωtᵢ , Σ cos 2ωtᵢ ) / (2ω)
P(f) = ½ · [ (Σ yᵢ cos ω(tᵢ−τ))² / Σ cos² ω(tᵢ−τ)
           + (Σ yᵢ sin ω(tᵢ−τ))² / Σ sin² ω(tᵢ−τ) ]  / variance
```

The `/variance` normalization cancels in the CR ratio; it just keeps the spectrum scale-free. Needs
≥ 20 beats.

**Welch averaging (#2).** When `spectralSegments ≥ 2`, the periodogram is averaged over that many
overlapping **time** sub-windows (`spectralOverlapPct` overlap). Averaging cuts run-to-run variance
~1/S (steadier live score), but each sub-window spans ~1/S the duration → coarser intrinsic resolution;
the same oversampled `freqs` grid is kept so peak localization is unchanged. If any sub-window holds
fewer than 20 beats, it falls back to the single full-window periodogram. Don't push S past ~4 or the
0.04 Hz LF band under-resolves within a sub-window. Cost is ~1–3 ms for a few hundred beats — fine on
the main thread.

---

## 8. Stage 3 — coherence ratio (CR) + squash

The **field-standard coherence ratio** (McCraty & Childre; HeartMath):

```
total = Σ P(f)            over [lsFreqLo … lsFreqHi]      (0.0033–0.4 Hz)
peakHz = argmax P(f)      over [peakSearchLo … peakSearchHi] (0.04–0.26 Hz)
win   = Σ P(f)            where |f − peakHz| ≤ resonanceHz (±0.015 Hz)
CR    = win / (total − win)
```

CR is the power concentrated in the dominant heart-rhythm peak relative to *everything else*. High CR
= the heart rate is oscillating strongly at one frequency = strong, ordered baroreflex/parasympathetic
resonance.

The lens drive is a **Narbis-designed bounded squash** of CR (not a HeartMath formula):

```
coh% = clamp( 100 · CR / (CR + cohSquashK) , 0, 100 )      // k = 3.0 default
```

`cohSquashK` is the single most impactful feel knob: lower k → the score climbs fast and saturates
(easier); higher k → you must hold strong coherence for a high score (harder). **This `coh%` is what
drives the lens, in every app mode** — the cross-spectral breath–heart coherence (§13) is reported
alongside but never drives the lens.

---

## 9. Stage 4 — resonance read-back & HRV companions

The **pacer read-back** is a *separate* argmax over the **LF-only** band (`lfReadbackLo…lfReadbackHi`,
0.04–0.15 Hz), distinct from the CR peak search (which extends to 0.26 Hz). This stops a fast
self-selected breather (e.g. 0.2 Hz) from feeding the pacer a too-high target. The result (`respPeakHz`,
converted to mHz) is what `FollowPacer` tracks.

The engine also publishes display-only companions: `LF`, `HF` (band sums), `LF/HF`, and normalized
`LFnu`/`HFnu`.

---

## 10. Stage 5 — the follow pacer (two-speed slew)

`followPacer.ts` / Swift `FollowPacer`. Maintains a `pacerAvgN`-sample ring of in-range read-back
values, converts the average to **quintets** (BPM × 5; 0.2-BPM resolution:
`q = round(avg_mHz · 3 / 10)`), and clamps to `[quintetMin, quintetMax]`. At each breath boundary it
moves the current pace toward that target with a **two-speed** rule:

```
err = target − current                                   (quintets)
if |err| ≥ pacerJumpThresholdBPM·5  for ≥ pacerJumpSustainBreaths consecutive breaths:
      SNAP   current = target                            (fast acquisition)
else: GLIDE  current += clamp(err, ±pacerSlewQuintet)    (±0.2 BPM/breath, gentle)
```

The sustain counter is the wall against a transient false reading triggering a jump (on top of the
`pacerAvgN` smoothing and the physiological clamp). Cycle duration = `300000 / quintet` ms. In Mode B
and in Mode C after handoff the controller drives the pacer via `setTargetBPM` (the pacer slews
smoothly toward the commanded rate); at Mode B entry / Mode C handoff the pacer is **snapped** to the
start/seed rate so the first dwell isn't measured mid-slew.

---

## 11. Stage 6 — lens drive (firmware-rendered)

`coherenceEngine.emitLens()` → `edgeDevice.driveLens()`. The engine emits a small **`LensState`**
(`{ style, bpm, depthPct, inhalePct, strobeHz, strobeDutyPct }`) ~1 Hz; the host coalesces it into
firmware commands, writing an opcode **only when its value changed**:

| Lens style | Firmware command | Notes |
|---|---|---|
| `breathingGuide` | `0xB0` BREATHE + `0xB1` rate + `0xA2` depth + `0xBA` phase sync | firmware renders the 100 Hz cosine |
| `coherenceLens` | `0xA5` static-duty setpoint (slow, ~1 Hz) | steady tint, no waveform |
| `breatheStrobe` | breathe + `0xAB`/`0xAC` strobe | *strobe overlay pending a firmware opcode* |

**Depth is computed app-side** from the engine's coherence with the difficulty gamma:

```
depthPct = brightness · (1 − (coh/100)^γ)        γ = gammaTable[difficulty]
         → at γ=1 (Easy): linear — coh 0%→full dark, 50%→half, 100%→clear
```

Depth and rate are **latched once per breath** (sampled at the cycle boundary, where the waveform value
≈ 0, and held for the whole breath), so the firmware's `effective_duty = wave(frac) × depth` stays
monotonic — pushing a new depth/rate mid-inhale is what made the lens "darken → clear a bit → darken."

Because the firmware renders the smooth waveform locally, the BLE link carries only occasional
parameter writes — never per-tick PWM. (`0xB1` is whole-BPM, but the engine also sends the **exact**
cycle length in ms via `0xBA` BREATHE_SYNC, so on firmware ≥ 4.15.5 the lens runs at the fractional
pacer rate.)

**Cue sync.** The on-screen breathing orb (`BreathCue`) and audio chime (`BreathChime` via
`useBreathPhase`) read `coherenceEngine.breathCyclePos()` directly — the engine is the single clock
authority — so the screen rate matches the lens. The glasses are phase-locked to that same clock: at
each cycle boundary — and on Mode A/B/C start / glasses-connect — `emitSync()` sends a **`0xBA`
BREATHE_SYNC** (`[cycle_ms u16 LE][inhale_pct u8]`), which restarts the firmware's breathe cosine at the
on-screen inhale boundary and renders at the exact cycle length. Re-anchoring only at the boundary
(waveform ~0) plus a firmware lens slew-rate limiter (~250 ms fade) means resyncs never snap. Glasses on
firmware **< 4.15.5** ignore `0xBA` and stay rate-synced only (no regression).

See [`bluetooth-protocol.md` §4.7](./bluetooth-protocol.md) for the opcode-level integration.

---

## 12. Mode A — Follow

> **In one line.** Mode A is *coherence biofeedback*: it watches the breathing rate at which your own
> HRV is strongest right now, paces you toward it, and clears the lens as your coherence rises. You
> don't pick a rate — the engine follows yours.

### 12.1 What it's for
Most paced-breathing tools make you breathe at a fixed rate (usually 6 br/min). But the rate that
actually maximizes *your* HRV — your resonance frequency — varies between people and drifts within a
session (posture, alertness, blood CO₂). Mode A is the everyday "just train" mode: it continuously
estimates where your HRV is strongest and nudges the breathing cue toward it, while the lens gives a
moment-to-moment coherence reward. It's the engine analog of a HeartMath emWave / Inner Balance
coherence session, but with the Edge lens as the display and an *adaptive* (not fixed) pacer.

If you instead want the engine to *find and lock* your single best rate, that's **Mode B** (or **Mode
C**, which warms up in Follow first). Mode A **follows**; Mode B **searches**.

### 12.2 The closed loop, step by step
Every second (`tick1Hz`):
1. **Ingest + clean** — new beats pass the §6 artifact gate into the ring.
2. **Spectrum** — the §7 detrend + Welch-averaged Lomb–Scargle PSD is computed over the trailing
   `coherenceWindowS` (64 s).
3. **Coherence** — §8 CR → `coh%`; this sets lens depth (clearer as `coh%` rises).
4. **Read-back** — the §9 LF-only peak (`respPeakHz`, 0.04–0.15 Hz) is pushed into the pacer's
   `pacerAvgN`-sample ring (out-of-band values are dropped, so noise/too-fast breaths don't feed it).
5. **Breath–heart γ²** — if a Polar H10 accelerometer is present, the real cross-spectral coherence is
   computed and reported (§13). Display only — it never drives the lens.

Every breath-cycle boundary (`onBreathBoundary`):
6. **Latch the pace** — the §10 pacer turns the averaged read-back into a quintet target and moves the
   commanded rate toward it (glide ±0.2 BPM, or snap — see §12.3). New cycle = `300000 / quintet` ms.
7. **Drive + sync** — `emitLens` pushes the new rate + the coherence-derived depth to the firmware
   breathe program (§11); the on-screen cue + chime re-lock to the engine clock.

The loop in words: *you breathe with the cue → your RSA appears at that rate → the LS read-back detects
it → the pacer holds/adjusts → the lens rewards the resulting coherence.*

### 12.3 Why a gentle glide *and* an occasional snap
There's a feedback subtlety: because you follow the cue, your RSA then appears *at the cue's rate*, so a
naive pacer could chase its own tail. Two choices keep it stable:
- **LF-only, averaged read-back** (0.04–0.15 Hz over `pacerAvgN` ≈ 15 s) — a transient or a too-fast
  self-selected breath can't yank the target.
- **A two-speed pacer.** Near target it **glides** ±0.2 BPM/breath — slow enough that the cue never
  lurches and the chase loop stays stable. But when you've clearly moved (the smoothed target sits ≥
  `pacerJumpThresholdBPM` away for `pacerJumpSustainBreaths` consecutive breaths) it **snaps** straight
  there, so you're not stuck crawling 0.2 BPM/breath for a minute when your real rate is 2 BPM off. The
  sustain count is the wall against one bad reading triggering a jump.

### 12.4 What you see
- **The breathing cue** (orb + Inhale/Exhale label) animates at the engine's current pace; the optional
  **chime** marks each inhale/exhale boundary. Both are phase-locked to the engine clock.
- **The lens** (and its on-screen mirror) clears as coherence rises: at `coh` 0 it tints fully on the
  inhale peak; at `coh` 100 it stays clear. The depth curve is shaped by the **Difficulty** setting.
- **The coherence ring / score** shows `coh%`; the readout shows the current pacer BPM. With an H10
  accelerometer connected, the **breath–heart coherence** (γ² and phase) is shown too (§13).

### 12.5 Parameters that shape Mode A
`cohSquashK` (overall difficulty — primary knob) · Difficulty `gamma*` (the coherence→depth curve) ·
`quintetMin/Max/Default` (rate clamp + start) · `pacerAvgN` (target smoothness) · `pacerSlewQuintet`
(glide rate) · `pacerJumpThresholdBPM` / `pacerJumpSustainBreaths` (snap behavior) · `detrend*` /
`spectral*` (spectrum steadiness) · lens style (breathingGuide / coherenceLens / breatheStrobe).

### 12.6 Failure modes & tuning
- **Pace feels jittery / chases you** → raise `pacerAvgN` or `pacerJumpThresholdBPM`.
- **Pace takes forever to catch up** → lower `pacerJumpSustainBreaths` or raise `pacerSlewQuintet`.
- **Score never moves / always pegged** → that's `cohSquashK` (raise = harder) + the Difficulty gamma.
- **Score looks jumpy** → raise `spectralSegments` (more Welch averaging) for a steadier live score.
- **No pace at all** → the read-back found nothing in 0.04–0.15 Hz (too few beats, or breathing outside
  the band); the pace holds its last value / `quintetDefault`.

Mode A works with any validated beat source (Polar H10 *or* the earclip). The accelerometer is optional
in Mode A — used only for the breath–heart coherence readout (§13), not for the lens.

---

## 13. Breath–heart coherence (real γ²/phase) & the Mayer-wave confound

`breathHeartCoherence.ts` / Swift `computeBreathHeartCoherence`. The CR of §8 is a *single-signal*
measure — spectral concentration of the heart rhythm. The HRV-biofeedback literature (Gevirtz) means
something stricter by "coherence": the **magnitude-squared coherence γ²(f)** between *respiration* and
*heart rate* — a true two-signal cross-spectrum that is ≈1 with ≈0° phase at resonance. The engine
computes it in Mode A (and during the Mode C warm-up) whenever a Polar H10 accelerometer stream is
present, as an honest readout **alongside** the CR — it does **not** drive the lens.

How it's built, at 1 Hz:
1. **x = heart rate** — the detrended RR series (same §7 detrend); **y = respiration** — the H10
   accelerometer's **de-meaned principal-axis** window (the same channel Mode B verifies with, §14.4; the
   vector magnitude is deliberately avoided — it frequency-doubles the breath).
2. Both are cubic-resampled onto a uniform 4 Hz grid and aligned on absolute time.
3. A **Welch cross-spectrum** (~3 segments, 50% overlap) gives γ²(f) and the cross-phase. γ² is
   identically 1 for a single segment, so ≥2 segments are required — otherwise it returns "can't
   assess" rather than a fake 1.0.
4. γ² and phase are read at the bin nearest the **ACC-measured** breathing rate (the trusted channel).

Because the 1 Hz estimate is noisy, the readout is EWMA-smoothed (`bhSmoothAlpha`) and the phase is a
γ²-weighted circular mean (low-γ² ticks barely move the angle). A brief gap holds the last value; a
sustained gap (ACC truly gone) decays it to "needs a Polar H10."

**The Mayer-wave confound flag.** The LF rhythm the pacer follows can be a **Mayer wave** — a ~0.1 Hz
blood-pressure oscillation that moves heart rate *regardless of breathing*. If the followed LF rate
sits off the ACC-measured breathing rate (by more than `respVerifyToleranceBPM`), or the smoothed γ² is
below the significance floor (0.5), the engine raises a **confound** flag: the rhythm on the lens is
likely *not* breathing-driven. This is the display-side analog of the verification Mode B enforces on
the search.

---

## 14. Mode B — Resonance (search + verify + maintain)

> **In one line.** Mode B runs the **Lehrer/Vaschillo resonance-frequency assessment** automatically:
> it paces you across a range of breathing rates, measures where your HRV amplitude peaks, *verifies*
> with an independent accelerometer channel that you actually breathed at each rate, locks your
> resonance frequency (RF), and then tracks it. Requires a Polar H10 (validated beats **and** its ACC).
> Implemented in `resonanceController.ts` (+ `fastAmplitude.ts`, `respirationFromAcc.ts`) / Swift
> `ResonanceController` (+ `FastAmplitudeTracker`, `RespirationFromACC`).

### 14.1 The science — resonance frequency & the baroreflex
The cardiovascular system has a resonance. The **baroreflex** (the blood-pressure feedback loop) has a
delay of ~5 s, so oscillating it at ~0.1 Hz (~6 br/min) produces the largest swing in heart rate —
maximal respiratory sinus arrhythmia (RSA). The exact peak — your **resonance frequency** — is
individual, typically 0.075–0.12 Hz (~4.5–7 br/min), set largely by body size / blood volume.
Breathing at *your* RF maximizes HRV amplitude and trains baroreflex gain; this is the mechanism behind
HRV biofeedback (Lehrer & Vaschillo). Clinically, RF is found by pacing a person through candidate
rates and watching which maximizes HRV. **Mode B automates exactly that** — plus an objective
verification step a clinician would do by watching the person breathe.

Mode B opens with a **60 s quiet settling** (`initialSettleS`, §5.7): the controller is seeded but does
not dwell yet, and the cue/chime/lens fade are paused while you breathe naturally and the LS (64 s) and
ACC (45 s) windows fill — so the first dwell isn't scored on half-warm sensors. The search begins when it
elapses.

### 14.2 Why a dedicated objective (fast amplitude)
The §8 coherence score uses a 64-s window, so after a rate change it stays contaminated by the *old*
rate for up to a minute — useless for a hill-climb that moves every few breaths. Mode B therefore uses
a faster objective: `FastAmplitudeTracker.amplitude()` returns the **mean per-breath peak-to-trough RR**
over the last `ampWindowBreaths` (2.5) breaths. It chunks recent beats into per-breath windows
(`breathS = 60 / commandedBPM`) and averages each chunk's `(max − min)` RR. This responds *within a
breath* of a rate change. It is the **only** objective the hill-climb consumes.

### 14.3 The dwell — settle, retest, accept
Mode B holds each candidate rate for a **dwell**, split into:
- **Settle** — the first `ceil(dwellBreaths · (1 − dwellEstimateFraction))` breaths (≈ 2–3) are
  discarded while the pacer slews to the new rate and your breathing catches up.
- **Estimate** — subsequent breaths are verified one at a time (§14.4); amplitude is collected from the
  **verified** breaths only, so an off-rate or low-confidence breath never pollutes the hill-climb.

Rather than scoring a fixed window all-or-nothing, the dwell **accumulates verified breaths and re-tests
the missed ones at the same rate**, deciding as soon as either:
- `dwellVerified ≥ dwellVerifyTarget` (default 2) — enough confirmed breaths → **accept** at full
  precision; or
- `dwellEstimate ≥ dwellMaxEstimateBreaths` (default 6) — the retest cap is hit → decide now.

On a decision: if **≥1 breath confirmed** and the dwell was artifact-clean, it is **accepted** (proceeding
even on partial verification — slightly less precise, but the search never freezes on one rate) and
`unverifiedDwells` resets. If **no** breath confirmed (or the dwell was artifact-dirty), it re-dwells and
`unverifiedDwells` increments — preserving the Mayer-wave abort (§14.4). A dwell with no ACC estimate at
all is charged to `unmeasuredDwells` instead (sensor warming up / dropout), not the verification budget.

### 14.4 Independent verification & the Mayer-wave defense
This is what makes an *automated* search trustworthy. Per estimate-window breath:

```
verified(breath) = measuredBPM ≠ null
                 ∧ respConfidence ≥ respConfidenceMin            (the ACC breathing peak is clear)
                 ∧ |measuredBPM − pacedBPM| ≤ respVerifyToleranceBPM   (you breathed at the paced rate)
```

`measuredBPM` / `respConfidence` come from the **accelerometer** respiration channel — *independent of
the heart*. Why does independence matter? Because the HRV/RSA peak alone can lie: the **Mayer wave** is
a ~0.1 Hz oscillation of blood pressure (and therefore heart rate) driven by the baroreflex
*regardless of breathing*. Off-resonance, the RSA peak can sit at the Mayer frequency (~6/min) even
though you're actually breathing at, say, 7/min — so an HRV-only search would happily "confirm"
resonance at the wrong rate. The chest accelerometer measures *real breathing motion*, so requiring
`|measured − paced| ≤ tolerance` proves you truly breathed where you were paced.

The ACC respiration estimate (`respirationFromAcc.ts`) runs on the **sum of the three axes' periodograms**
(each axis is linear in the breathing motion and the periodogram linear-detrends out the gravity DC). It
deliberately does **not** use the vector magnitude `√(x²+y²+z²)`: with gravity as a large DC on one axis,
the squaring nonlinearity injects a strong 2× term that **frequency-doubles** the breath — on real H10 data
the magnitude read a steady ~9.3 br/min for a genuine ~4–5 br/min breath (every individual axis read
4–5), which failed verification on every dwell. The per-axis combination removes that. On top of it the
estimate is robust: it picks the breathing peak by **prominence** (height relative to the in-band mean)
with a **low-frequency sway floor** (`respMinHz`) that de-weights ~0.065 Hz postural drift, an **octave
guard** that steps a harmonic-latched peak down to its true fundamental, a **parabolic sub-bin** refinement
(the raw bin is ~0.73 BPM coarse), and a **harmonic-excluded confidence** (`respHarmonicExcludeMult`) so a
breath's own 2×/3× harmonics don't deflate the confidence score. (The same de-meaned principal axis feeds
the Mode A breath–heart γ², §13.)

Persistent failure ⇒ a **"hold still / follow the cue"** hint, and after `maxUnverifiedDwells` (12)
consecutive unverifiable dwells the search **aborts** (`searchAborted`) and holds a steady pace rather
than chase un-trustable data.

### 14.5 The search state machine
A state machine whose `commandedBPM` is handed to the pacer to slew toward each dwell. States
(`SearchPhase`), with the plain-language `SearchProgress.phase` the UI shows in *italics*:

1. **`probe0`** *(baseline)* — dwell at the start rate (your warm-start RF, else 6 BPM); record its
   amplitude as the baseline.
2. **`findDir`** *(baseline)* — probe one `probeStepInitBPM` (0.4 BPM) step **down**; compare its
   amplitude to baseline to decide which direction is **uphill** (toward higher HRV amplitude).
3. **`bracketOut`** *(climbing)* — step in the uphill direction, `probeStepInitBPM` at a time, shifting
   the window while amplitude keeps rising, until it **drops** — yielding a 3-point bracket
   `[low, peak, high]` straddling the maximum. (If it climbs into a search-band edge first, it locks
   there — see §14.6.)
4. **`refine`** *(refining)* — **golden-section** narrowing inside the bracket: probe the larger
   sub-interval, keep the higher-amplitude side, repeat. When the bracket can no longer tighten on the
   0.2-BPM grid (`probeStepFloorBPM`), fit a **parabola** through the three points and **lock its
   vertex** → a sub-grid resonance frequency.

Hysteresis keeps noise from flipping decisions: a rate only counts as "better" if its amplitude beats
the incumbent by `ε = max(epsilonPctOfA · A, 1 SD of the dwell's amplitudes)`.

### 14.6 Boundary lock & parabolic vertex
- **Boundary lock** — if the best-so-far dwell sits at a search-band edge (`searchLoBPM` /
  `searchHiBPM`) and an interior sample is lower, the true peak is at/beyond the clamp; it locks at the
  edge and flags **`boundaryLimited`** (so you know the band — not your physiology — set the answer;
  widen the band and retry).
- **Parabolic vertex** — at the finest bracket the lock is the vertex of the parabola through the three
  `(rate, amplitude)` points, not the best grid point, giving sub-0.2-BPM precision on the RF.

### 14.7 Maintain — drift tracking & sudden-loss re-probe
Once `state = maintaining`, the lock is **not** frozen — resonance drifts with posture/fatigue. Two
mechanisms keep it:
- **Extremum-seeking** — a sub-perceptual dither (`ditherAmpBPM` = 0.1 BPM over `ditherPeriodS` = 180 s)
  is added to the pace; the amplitude response is demodulated against the dither to estimate the local
  gradient and nudge the lock uphill (`escGainBPM`, capped per cycle at `escMaxStepBPM`). The objective
  is **high-passed** first (`escMeanAlpha`), so a *uniform* amplitude fade (fatigue) cancels and is not
  mistaken for a gradient.
- **Sudden-loss re-probe** — a fast vs slow amplitude EWMA (`decayFastAlpha` / `decaySlowAlpha`).
  Gradual fatigue moves both together; a *sudden* drop (you shifted, the strap moved, you stopped
  following) drops the fast EWMA first. If `fast < slow · (1 − reprobeDecayPct)` sustained for
  `reprobeSustainS` (and at most once per `reprobeCapS`), it restarts a short bracket search around the
  lock to re-acquire.

### 14.8 Warm start & abort
- **Warm start** — the converged RF is persisted per user. Next session Mode B starts the pacer *at*
  that RF and runs a short re-confirm within `±confirmProbeBPM` instead of a cold hunt.
- **Abort** — `maxUnverifiedDwells` consecutive unverifiable dwells ⇒ `searchAborted`; it stops hunting
  and holds a steady comfortable pace. Sit still and re-enter Mode B to retry.

### 14.9 What you see (UI states)
- **Searching** — e.g. *"Pacing you at 6.0 br/min to read your baseline (breath 4 of 6)"*, then
  *climbing* / *refining*, with the best rate found so far and the count of rates tested.
- **Hold-still hint** — driven by `unverifiedDwells`.
- **Maintaining** — shows your **locked resonance frequency**; flags `boundaryLimited` if it locked at a
  band edge, or `searchAborted` if it gave up.
- The breathing cue + chime pace you through every dwell; the **Breathing-wave (H10 accelerometer)
  chart** shows the independent respiration the verifier is reading.

### 14.10 A worked timeline
Seated, still, H10 connected, no saved RF:
1. **probe0** — paced 6.0 for 6 breaths (~60 s); baseline amplitude recorded once verified.
2. **findDir** — paced 5.6; amplitude higher ⇒ uphill is *downward* in rate.
3. **bracketOut** — 5.2, 4.8 … amplitude rises then falls at 4.4 ⇒ bracket ≈ `[4.4, 4.8, 5.2]`.
4. **refine** — golden-section probes inside; tightens to the 0.2-BPM floor.
5. **lock** — parabola vertex ≈ **4.9 BPM** → `maintaining`; RF persisted.
6. **maintain** — dithers ±0.1 around 4.9, tracks drift; re-probes only if amplitude suddenly collapses.

### 14.11 Parameters & tuning
- **`searchLoBPM` / `searchHiBPM`** — the searched range (4.0–7.5). If `boundaryLimited`, widen it.
- **`dwellBreaths` / `dwellEstimateFraction`** — reliability vs search speed.
- **`probeStepInitBPM` / `probeStepFloorBPM`** — coarse step / final resolution.
- **`respVerifyToleranceBPM`** — how strictly "you breathed where I paced" is enforced (raise toward 1.0
  if good dwells keep getting rejected).
- **`respConfidenceMin`, `respMinHz`** — the ACC verifier's strictness / sway rejection — the usual
  levers when Mode B "can't confirm".
- **`maxUnverifiedDwells`** — patience before aborting.
- Maintenance: `ditherAmpBPM/PeriodS`, `escGainBPM/MaxStepBPM/MeanAlpha`, `decayFastAlpha/decaySlowAlpha`,
  `reprobeDecayPct/SustainS/CapS`.

Mode B requires a Polar H10 (validated beats **and** the accelerometer channel).

---

## 15. Mode C — Settle & Find

> **In one line.** Mode C is the "just press start" resonance mode: it runs the **Mode A Follow**
> warm-up until your breathing is steady *and* the accelerometer confirms it, then hands off — seeded at
> the rate you settled into — to the exact **Mode B** search. No cold 6-BPM hunt, no manual mode switch.
> Requires a Polar H10 (beats **and** ACC). The warm-up gate lives in `coherenceEngine.ts`
> (`evaluateModeCGate`) / Swift `evaluateModeCGate`.

### 15.1 Why it exists
Mode B's cold start always begins at 6 BPM and hunts outward — fine, but it spends its first dwells far
from where many people naturally settle, and it can rack up "couldn't confirm" dwells if the user hasn't
settled yet. Mode C front-loads a calm Follow phase: it lets you settle, *measures* where you settled,
and seeds the search there — so Mode B starts close to the answer and on a breath the accelerometer can
already confirm.

### 15.2 The three phases
1. **`warmup`** — the Mode A Follow loop (§12: LS → CR, LF read-back → pacer) run as a **quiet settling**:
   the pacer tracks exactly as Mode A, but the breath cue is paused, the chime muted, and the lens held
   **fully clear** (depth 0) — `status.settling` is `true`. No resonance controller exists yet, so every
   Mode B status field reads its default (the UI never shows stale resonance data). Each second the engine
   records two **unsmoothed** gate samples into a trailing `modeCStabilityWindowS` window: the detected
   LF-peak rate (BPM) and whether the ACC respiration confidence cleared `respConfidenceMin`.
2. **`searching`** — once the gate passes (§15.3) the engine, in one atomic tick, creates the
   `ResonanceController` seeded at the settled rate and **hard-snaps** the pacer there; from that point
   the controller is the sole pacer source and the search runs exactly as Mode B (§14).
3. **`maintaining`** — the controller locks and tracks the resonance, identical to Mode B §14.7.

### 15.3 The warm-up gate
Evaluated once per breath over the trailing stability window:

```
accConfident = ≥ 60% of the window's ACC samples cleared respConfidenceMin   (MANDATORY)
stable       = SD(detected-rate samples) ≤ modeCStabilityBpmSd
seedBPM      = mean(detected-rate samples), clamped to [searchLoBPM, searchHiBPM]
canTransition = accConfident ∧ elapsed ≥ modeCWarmupS ∧ (stable ∨ elapsed ≥ modeCWarmupMaxS)
```

Two deliberate properties:
- **ACC confidence is mandatory and never relaxed.** With no confident accelerometer breathing, the user
  simply stays in warm-up indefinitely — an honest wait, strictly better than handing off into a search
  that will only rack up unverifiable dwells. The time cap relaxes *only* the stability requirement.
- **The detected rate is the UNSMOOTHED LS read-back, not the slew-limited pacer output** — the pacer
  reads "stable" by construction even for an erratic breather, so the gate must judge the raw estimate.

`seedBPM` is the windowed mean (falling back to 6.0 only if no rate was ever detected), clamped to the
Mode B search band, so the search begins where you actually settled.

### 15.4 Re-entry — never stuck
If the handed-off search later **aborts** (`searchAborted` — persistent unverifiable breathing), Mode C
drops the controller and re-enters the Follow `warmup`, resetting the clock and gate windows. It then
runs the honest wait again rather than sitting stuck in a failed search. (Plain Mode B keeps its own
abort behavior — hold a steady pace — and does *not* re-enter a warm-up.)

### 15.5 Parameters & tuning
Mode C uses **every Mode A and Mode B tunable** (§5.1–§5.8) plus its own warm-up gate (§5.9):
`modeCWarmupS` (minimum settle time), `modeCWarmupMaxS` (cap that relaxes only stability),
`modeCStabilityWindowS` (the trailing window), and `modeCStabilityBpmSd` (how steady counts as stable —
0.4 is tight; raise toward 0.6–0.8 if real gate passes are rare and most sessions transition on the cap).

---

## 16. Firmware engine — Standard (on-glasses)

The legacy behavior, kept as the **Firmware** selectable engine: the app engine is **off**, the
dashboard forwards beats to the glasses (`0xCA`), and the **firmware** computes coherence and drives the
lens with its own programs (Heartbeat / Coherence-Breathe / Coherence-Lens / Breath+Strobe). Full
pipeline in [`coherence-algorithm-reference.md`](./coherence-algorithm-reference.md).

Because the firmware owns the lens phase on a clock the app cannot observe, the dashboard's on-screen
breathing cue + chime are **hidden** in Firmware mode (showing them would drift out of sync with the
glasses). The glasses themselves are the cue. This engine has no app-side tunables; its knobs live in
the firmware config (see the algorithm reference).

---

## 17. Tuning

Every parameter in §5 is live in the dashboard's **Coherence Engine** panel, grouped by the same
sections. Each knob has a click-to-expand **ⓘ** explaining what it does, its effect, and the recommended
tuning direction (the text reproduced in §5). The shipped defaults are the recommended starting values;
**reset-all** re-applies them. Tunable sets save/load as named presets.

Quick-start tuning order:
1. **`cohSquashK`** — overall difficulty (primary knob).
2. **Difficulty gamma** — the lens coherence→depth curve.
3. **`spectralSegments`** — raise for a steadier live score if it looks jumpy.
4. **Mode B/C `respMinHz` / `respConfidenceMin`** — if the ACC verifier struggles to confirm breathing.
5. **Pacer `pacerJumpThresholdBPM` / `pacerJumpSustainBreaths`** — catch-up feel.
6. **Mode C `modeCStabilityBpmSd` / `modeCWarmupS`** — how long/strict the settle phase is.

---

## 18. Reference literature

- **Lomb (1976); Scargle (1982)** — least-squares spectral analysis of unevenly-sampled data; lets us
  analyze the beat series without resampling.
- **Tarvainen, Ranta-aho & Karjalainen (2002)** — smoothness-priors detrending (the Kubios method);
  basis of the §7 detrend.
- **Welch (1967)** — averaged-periodogram spectral estimation; basis of the §7 sub-window averaging and
  the §13 cross-spectrum.
- **HeartMath — McCraty, Childre, et al.** — physiological *coherence* as the ratio of power in the
  dominant heart-rhythm peak to surrounding power; the basis of CR and the coh% squash.
- **Lehrer & Vaschillo; Vaschillo, Vaschillo & Lehrer** — resonance-frequency HRV biofeedback: each
  person has a breathing rate (~0.075–0.12 Hz, ~4.5–7 br/min) that maximizes baroreflex-driven HRV.
  Foundation of Mode B/C's search and the ~6 br/min default pace.
- **Gevirtz** — HRV biofeedback and the respiration↔heart coupling that the §13 cross-spectral coherence
  measures.
- **Lipponen & Tarvainen (2019)** — robust HRV artifact correction via successive-difference
  classification; basis of the adaptive dRR gate.
- **Task Force of the ESC/NASPE (1996)** — standards for HRV measurement (VLF/LF/HF bands).
- **Shaffer & Ginsberg (2017)** — overview of HRV metrics and norms.
- **Elgendi et al.** — systolic-peak detection in PPG (the earclip's beat detector).
- **Baroreflex / Mayer waves (~0.1 Hz)** — the low-frequency blood-pressure oscillation the §13 confound
  flag and Mode B's accelerometer channel exist to distinguish from genuine breathing.

*(Citations at author/topic level; consult the originals for exact parameters.)*

---

## 19. Commercial / prior-art examples

- **HeartMath emWave Pro / Inner Balance** — the canonical coherence-biofeedback trainers; **Mode A**
  is the closest analog (coherence score + paced breathing).
- **Clinical HRV biofeedback / resonance-frequency assessment (Lehrer protocol)** — therapists sweep
  paced breathing rates and pick the one maximizing HRV; **Mode B / Mode C** automate exactly this, with
  the accelerometer adding the verification a clinician would do by observation.
- **Resonance-breathing apps** — Elite HRV, Breathe (Apple Watch), and similar paced-breathing tools
  share the breathing-cue idea but without the closed-loop coherence/resonance feedback.
- **Adjacent neurofeedback wearables** — Muse (EEG), Apollo Neuro (HRV-adjacent) — different signals,
  same biofeedback-loop philosophy.

What is distinctive here is the **output device**: rather than a screen or audio, the feedback is the
Narbis Edge **electrochromic lens** clearing as your coherence rises — driven by an app-side engine
that treats the glasses as a display.
