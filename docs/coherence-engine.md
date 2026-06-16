# Narbis Coherence Engine — Algorithm & Architecture

> **What this is.** The app-side **Coherence Engine** that runs inside the Narbis earclip dashboard
> (`dashboard/src/engine/`). It computes heart-rate-variability (HRV) coherence, paces your
> breathing, finds your resonance frequency, and drives the Edge glasses' electrochromic lens —
> entirely on the app side, with the glasses acting as a display.
>
> **Companion docs.**
> - [`coherence-algorithm-reference.md`](./coherence-algorithm-reference.md) — the **firmware** coherence
>   pipeline that runs *on the glasses* (256-pt FFT). Used by Mode C (Standard / on-glasses).
> - [`bluetooth-protocol.md`](./bluetooth-protocol.md) — the BLE surface (opcodes, relay frames) the
>   engine commands the glasses through (§4.3, §4.7).
>
> **Source of truth.** The engine is a faithful TypeScript port of the Swift `NarbisCoherenceEngine`.
> Every stage below maps to a file in `dashboard/src/engine/`; line-level behavior matches the code.
> Defaults/ranges live in `tunables.ts` and are exposed (with a click-to-expand ⓘ on each) in the
> dashboard's Coherence Engine panel.

---

## Table of contents
1. [Why an app-side engine](#1-why-an-app-side-engine)
2. [The three modes](#2-the-three-modes)
3. [Signal flow at a glance](#3-signal-flow-at-a-glance)
4. [How fast each stage runs](#4-how-fast-each-stage-runs)
5. [Constants & defaults](#5-constants--defaults)
6. [Stage 1 — beat ingest + artifact gate](#6-stage-1--beat-ingest--artifact-gate)
7. [Stage 2 — Lomb–Scargle periodogram](#7-stage-2--lombscargle-periodogram)
8. [Stage 3 — coherence ratio (CR) + squash](#8-stage-3--coherence-ratio-cr--squash)
9. [Stage 4 — resonance read-back & HRV companions](#9-stage-4--resonance-read-back--hrv-companions)
10. [Stage 5 — the follow pacer (two-speed slew)](#10-stage-5--the-follow-pacer-two-speed-slew)
11. [Stage 6 — lens drive (firmware-rendered)](#11-stage-6--lens-drive-firmware-rendered)
12. [Mode A — Follow](#12-mode-a--follow)
13. [Mode B — Resonance (search + verify + maintain)](#13-mode-b--resonance-search--verify--maintain)
14. [Mode C — Standard (on-glasses)](#14-mode-c--standard-on-glasses)
15. [Tuning](#15-tuning)
16. [Reference literature](#16-reference-literature)
17. [Commercial / prior-art examples](#17-commercial--prior-art-examples)

---

## 1. Why an app-side engine

Historically the **glasses firmware** computed coherence (a 256-point FFT on the incoming inter-beat
intervals) and drove the lens itself — see [`coherence-algorithm-reference.md`](./coherence-algorithm-reference.md).
That works but is constrained: a fixed FFT grid (0.0156 Hz bins), integer breathing rates, no
independent respiration sensor, and slow to iterate.

The Coherence Engine moves **all signal processing into the app**:

- **Richer math** — a dense **Lomb–Scargle** periodogram (spectrum-analyzes the unevenly-sampled
  beat series *directly*, no resampling artifact), a field-standard coherence ratio, an adaptive
  **Lipponen–Tarvainen** artifact gate, an automated **resonance-frequency search**, and an
  independent **accelerometer respiration** channel for verification.
- **Fast iteration** — every constant is a live, unit-tested tunable.
- **The glasses become a display.** The engine computes *what the lens should do* and commands the
  firmware's own smooth breathe / static / strobe program over BLE — it does **not** stream per-tick
  PWM (choppy over BLE). See [§11](#11-stage-6--lens-drive-firmware-rendered).

The engine is a main-thread singleton (`coherenceEngine`, an `EventTarget`) mirroring the
`edgeDevice` / `polarH10` device objects. It ingests beats + accelerometer samples from the existing
device events, self-ticks, and publishes status (coherence, CR, resp Hz, pacer BPM, Mode B state)
via `CustomEvent`s. The 1 Hz Lomb–Scargle (~1–3 ms on a few hundred beats) is cheap enough for the
main thread; the existing metrics web-worker is left alone for the display/validation traces.

---

## 2. The three modes

The dashboard's engine selector is mutually exclusive — exactly one mode is active:

| Mode | Name | Coherence computed by | Paced by | Lens driven by |
|---|---|---|---|---|
| **A** | **Follow** | app (engine) | app — follows *your* drifting resonance | engine → firmware breathe program |
| **B** | **Resonance** | app (engine) | app — *searches* for your resonance frequency | engine → firmware breathe program |
| **C** | **Standard (on-glasses)** | **firmware** | firmware adaptive pacer | firmware (its own pipeline) |

`engineMode` is mutually exclusive with the firmware program / standalone-mode selectors (the same
pattern those use). Entering A/B starts the engine and sets the firmware program aside; returning to
C stops the engine and restores the firmware program.

---

## 3. Signal flow at a glance

```
   Polar H10 RR + monotonic beat timestamps                 H10 accelerometer (Mode B only)
   (or earclip beats)                                                │ x/y/z @ 50 Hz (Polar PMD)
            │                                                        ▼
            ▼                                              ┌────────────────────────────┐
   ┌──────────────────────┐                               │ RespirationFromACC          │
   │ §6 Artifact gate      │  adaptive dRR,                │ |x,y,z| → detrend+Hann →    │
   │ AdaptiveDRRGate /      │  drop (no interpolate)        │ periodogram → prominence    │
   │ IBIIngest beat ring    │                               │ peak + low-freq sway floor  │
   └─────────┬─────────────┘                               │ + harmonic-robust conf.     │
             │ clean (beatTimeS, rrMs) ring                 └─────────────┬──────────────┘
             ▼                                                            │ measured BPM + confidence
   ┌──────────────────────┐   1 Hz                                        │
   │ §7 Lomb–Scargle PSD    │──────────────┐                              │
   │ (variance-normalized)  │              │                              │
   └─────────┬─────────────┘              │                              │
             ▼                            ▼                               │
   ┌──────────────────────┐    ┌────────────────────┐                    │
   │ §8 CR = win/(total−win)│   │ §9 LF-only readback │                    │
   │ coh% = 100·CR/(CR+k)   │   │ → pacer target      │                    │
   └─────────┬─────────────┘    └─────────┬──────────┘                    │
             │ coh% (lens depth)           │ resp mHz                       │
             │                             ▼                               ▼
             │                   ┌────────────────────┐         ┌─────────────────────┐
             │                   │ §10 FollowPacer     │         │ §13 ResonanceCtrl   │ (Mode B)
             │                   │ slew + two-speed    │◄────────┤ hill-climb + per-   │
             │                   │ jump (quintets)     │ Mode B  │ dwell verification  │
             │                   └─────────┬──────────┘ drives   └─────────────────────┘
             │                             │ pacer BPM
             ▼                             ▼
                       ┌────────────────────────────────┐
                       │ §11 LensState → edgeDevice.driveLens │  ~1 Hz + per breath boundary
                       └────────────────┬─────────────────┘
                                        ▼
                          firmware breathe / static / strobe program (renders the smooth cycle)
                                        ▼
                          on-screen cue + chime lock to the engine's breath clock
```

---

## 4. How fast each stage runs

| Stage | Cadence | Where |
|---|---|---|
| Beat ingest + artifact gate | per BLE notification (~1 Hz at rest; H10 batches 1–2 RR) | `onH10RR` / `onRR` → `IBIIngest` |
| ACC ingest | per PMD packet (batch of samples, ~50 Hz) | `onAccPacket` → `RespirationFromACC` |
| Lomb–Scargle compute + CR + pacer push | **1 Hz** | `tick1Hz()` |
| Lens param push (`emitLens`) | **1 Hz** + on each breath boundary | `tick1Hz` / `onBreathBoundary` |
| Breath-clock tick (boundary detection) | ~83 ms (12 Hz) | `lensTick()` |
| Pacer latch / Mode B controller advance | each **breath-cycle boundary** (~10 s @ 6 BPM) | `onBreathBoundary()` |
| On-screen cue / chime | RAF / 100 ms, sampling `coherenceEngine.breathCyclePos()` | `BreathCue` / `useBreathPhase` |

End-to-end latency a user feels: ≤ 1 s (next LS compute) + lens response. The lens itself is rendered
by the firmware at 100 Hz, so the *waveform* is smooth regardless of the 1 Hz param cadence.

---

## 5. Constants & defaults

All in `tunables.ts` (`DEFAULT_TUNABLES`); all live-tunable via the panel. Quintet = BPM × 5.

### Ingest / artifact
| Knob | Default | Range | Purpose |
|---|---|---|---|
| `confThreshold` | 50 | 0–100 | drop beats below this quality (H10 = 100) |
| `ringSize` | 600 | 256–1024 | beat ring depth (~8–10 min) |
| `dRRFloorMs` | 180 | 50–400 | floor on the adaptive dRR reject threshold |

### Lomb–Scargle & coherence
| Knob | Default | Range | Purpose |
|---|---|---|---|
| `coherenceWindowS` | 64 | 32–128 | trailing analysis window (sets resolution) |
| `lsFreqLo` / `lsFreqHi` | 0.0033 / 0.4 | — | analysis band = CR "total" band, Hz |
| `lsDf` | 0.002 | 0.001–0.005 | LS frequency-grid spacing, Hz |
| `peakSearchLo` / `peakSearchHi` | 0.04 / 0.26 | — | CR peak search band, Hz (HeartMath/registry) |
| `resonanceHz` | 0.015 | 0.005–0.03 | ± integration window around the CR peak, Hz |
| `lfReadbackLo` / `lfReadbackHi` | 0.04 / 0.15 | — | LF-only pacer read-back band, Hz |
| `cohSquashK` | 3.0 | 1–8 | **primary knob**: `coh% = 100·CR/(CR+k)` |
| `lfBandLo/Hi`, `hfBandLo/Hi` | 0.04/0.15, 0.15/0.4 | — | LF/HF display bands, Hz |

### Lens
| Knob | Default | Purpose |
|---|---|---|
| `gammaEasy/Medium/Hard/Expert` | 1.0 / 1.5 / 2.0 / 3.0 | difficulty curve on coherence→depth |
| `dutyFloorPct` | 20 | legacy floor (limited effect now) |
| `breatheInhalePct` | 40 | inhale fraction (40/60) |
| `heartbeatPulseMs` / `heartbeatPeakDuty` | 150 / 80 | Heartbeat-program flash |
| `ewmaAlpha` | 0.005 | legacy Program-2 smoothing |

### Mode A pacer
| Knob | Default | Purpose |
|---|---|---|
| `quintetMin/Max/Default` | 15 / 60 / 30 | 3.0 / 12.0 / 6.0 BPM clamp + start |
| `pacerAvgN` | 15 | resonance read-back averaging (samples) |
| `pacerSlewQuintet` | 1 | gentle glide ±0.2 BPM/breath |
| `pacerJumpThresholdBPM` | 1.0 | snap when target is ≥ this far |
| `pacerJumpSustainBreaths` | 2 | …for this many breaths (false-jump wall) |

### Mode B
| Knob | Default | Purpose |
|---|---|---|
| `ampWindowBreaths` | 2.5 | breaths averaged for the amplitude objective |
| `dwellBreaths` | 6 | breaths held per candidate rate |
| `dwellEstimateFraction` | 0.6 | estimate on the last 60% (discard settling) |
| `probeStepInitBPM` / `probeStepFloorBPM` | 0.4 / 0.2 | initial / floor search step, BPM |
| `epsilonPctOfA` | 0.05 | hill-climb hysteresis (fraction of amplitude) |
| `searchLoBPM` / `searchHiBPM` | 4.0 / 7.5 | resonance search band |
| `respVerifyToleranceBPM` | 0.5 | |measured − paced| accept window |
| `maxUnverifiedDwells` | 12 | abort search after N unverified dwells |
| `ditherAmpBPM` / `ditherPeriodS` | 0.1 / 180 | maintenance extremum-seeking dither |
| `escGainBPM` / `escMaxStepBPM` / `escMeanAlpha` | 0.15 / 0.05 / 0.02 | drift tracking gain / cap / high-pass |
| `decayFastAlpha` / `decaySlowAlpha` | 0.2 / 0.02 | sudden-loss fast/slow EWMAs |
| `reprobeDecayPct` / `reprobeSustainS` / `reprobeCapS` | 0.15 / 120 / 180 | re-probe trigger / sustain / cooldown |
| `confirmProbeBPM` | 0.5 | warm-start re-confirm half-range |

### ACC respiration (Mode B)
| Knob | Default | Purpose |
|---|---|---|
| `accSampleHz` | 50 | PMD ACC rate (must match the stream) |
| `respBandLo` / `respBandHi` | 0.05 / 0.4 | breathing search band, Hz |
| `respWindowS` | 45 | ACC estimate window, s |
| `respConfidenceMin` | 0.3 | min spectral concentration to trust |
| `respMinHz` | 0.08 | low-freq sway floor (de-weight below) |
| `respNearPeakHz` | 0.04 | ± peak window for confidence |
| `respHarmonicExcludeMult` | 1.6 | exclude ≥ this × peak from conf. denominator |

---

## 6. Stage 1 — beat ingest + artifact gate

`adaptiveDrrGate.ts` (the shared gate) + `ibiIngest.ts` (the time-stamped ring). A beat is accepted iff:

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
good beat. The same gate is used by every beat path (H10 display/forward, engine, earclip-relay), so
all three agree on what an artifact is. H10 batch timestamps are reconstructed per beat from the
notification arrival time.

---

## 7. Stage 2 — Lomb–Scargle periodogram

`lombScargleCore.ts`. The RR series is sampled once per beat — unevenly in time. Rather than resample
onto a uniform grid (the firmware's approach, which can smear the spectrum), the engine runs the
**variance-normalized Lomb–Scargle** periodogram directly on the irregular `(beatTimeS, rrMs)` pairs.

For each grid frequency `f` (from `lsFreqLo` to `lsFreqHi` step `lsDf`), with `ω = 2πf` and the
mean-subtracted series `y`:

```
τ   = atan2( Σ sin 2ωtᵢ , Σ cos 2ωtᵢ ) / (2ω)
P(f) = ½ · [ (Σ yᵢ cos ω(tᵢ−τ))² / Σ cos² ω(tᵢ−τ)
           + (Σ yᵢ sin ω(tᵢ−τ))² / Σ sin² ω(tᵢ−τ) ]  / variance
```

The `/variance` normalization cancels in the CR ratio; it just keeps the spectrum scale-free. Needs
≥ 20 beats. Cost is ~1–3 ms for a few hundred beats at the default grid — fine on the main thread.

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
(easier); higher k → you must hold strong coherence for a high score (harder).

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

`followPacer.ts`. Maintains a `pacerAvgN`-sample ring of in-range read-back values, converts the
average to **quintets** (BPM × 5; 0.2-BPM resolution: `q = round(avg_mHz · 3 / 10)`), and clamps to
`[quintetMin, quintetMax]`. At each breath boundary it moves the current pace toward that target with a
**two-speed** rule:

```
err = target − current                                   (quintets)
if |err| ≥ pacerJumpThresholdBPM·5  for ≥ pacerJumpSustainBreaths consecutive breaths:
      SNAP   current = target                            (fast acquisition)
else: GLIDE  current += clamp(err, ±pacerSlewQuintet)    (±0.2 BPM/breath, gentle)
```

The sustain counter is the wall against a transient false reading triggering a jump (on top of the
`pacerAvgN` smoothing and the physiological clamp). Cycle duration = `300000 / quintet` ms.

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

Because the firmware renders the smooth waveform locally, the BLE link carries only occasional
parameter writes — never per-tick PWM. (`0xB1` is whole-BPM, but the engine also sends the **exact**
cycle length in ms via `0xBA` BREATHE_SYNC — see *Cue sync* below — so on firmware ≥ 4.15.5 the lens
runs at the fractional pacer rate, not a rounded one.)

**Cue sync.** The on-screen breathing orb (`BreathCue`) and audio chime (`BreathChime` via
`useBreathPhase`) read `coherenceEngine.breathCyclePos()` directly — the engine is the single clock
authority — so the screen rate matches the lens. The glasses are phase-locked to that same clock: at
each cycle boundary — and on Mode A/B start / glasses-connect — `emitSync()` sends the firmware a
**`0xBA` BREATHE_SYNC** (`[cycle_ms u16 LE][inhale_pct u8]`), which restarts the firmware's breathe
cosine at the on-screen inhale boundary and renders at the *exact* cycle length, so orb, chime, and
lens share one clock. Re-anchoring only at the boundary (waveform ~0) plus a firmware lens slew-rate
limiter (~250 ms fade) means resyncs never snap, even as the pacer drifts. Glasses on firmware
**< 4.15.5** ignore `0xBA` and stay rate-synced only (the prior behavior — no regression).

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

If you instead want the engine to *find and lock* your single best rate, that's **Mode B**. Mode A
**follows**; Mode B **searches**.

### 12.2 The closed loop, step by step
Every second (`tick1Hz`):
1. **Ingest + clean** — new beats pass the §6 artifact gate into the ring.
2. **Spectrum** — the §7 Lomb–Scargle PSD is computed over the trailing `coherenceWindowS` (64 s).
3. **Coherence** — §8 CR → `coh%`; this sets lens depth (clearer as `coh%` rises).
4. **Read-back** — the §9 LF-only peak (`respPeakHz`, 0.04–0.15 Hz) is pushed into the pacer's
   `pacerAvgN`-sample ring (out-of-band values are dropped, so noise/too-fast breaths don't feed it).

Every breath-cycle boundary (`onBreathBoundary`):
5. **Latch the pace** — the §10 pacer turns the averaged read-back into a quintet target and moves the
   commanded rate toward it (glide ±0.2 BPM, or snap — see §12.3). New cycle = `300000 / quintet` ms.
6. **Drive + sync** — `emitLens` pushes the new rate + the coherence-derived depth to the firmware
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
- **The breathing cue** (orb + Inhale/Exhale label) animates at the engine's current pace — the thing
  to breathe with; the optional **chime** marks each inhale/exhale boundary. Both are phase-locked to
  the engine clock, so they match the lens rate.
- **The lens** (and its on-screen mirror) clears as coherence rises: at `coh` 0 it tints fully on the
  inhale peak; at `coh` 100 it stays clear. The depth curve is shaped by the **Difficulty** setting.
- **The coherence ring / score** shows `coh%`; the readout shows the current pacer BPM.

### 12.5 Parameters that shape Mode A
`cohSquashK` (overall difficulty — primary knob) · Difficulty `gamma*` (the coherence→depth curve) ·
`quintetMin/Max/Default` (rate clamp + start) · `pacerAvgN` (target smoothness) · `pacerSlewQuintet`
(glide rate) · `pacerJumpThresholdBPM` / `pacerJumpSustainBreaths` (snap behavior) · lens style
(breathingGuide / coherenceLens / breatheStrobe).

### 12.6 Failure modes & tuning
- **Pace feels jittery / chases you** → raise `pacerAvgN` or `pacerJumpThresholdBPM`.
- **Pace takes forever to catch up** → lower `pacerJumpSustainBreaths` or raise `pacerSlewQuintet`.
- **Score never moves / always pegged** → that's `cohSquashK` (raise = harder) + the Difficulty gamma.
- **No pace at all** → the read-back found nothing in 0.04–0.15 Hz (too few beats, or breathing outside
  the band); the pace holds its last value / `quintetDefault`.

Mode A works with any validated beat source (Polar H10 *or* the earclip) and does **not** use the
accelerometer (that's Mode B only).

---

## 13. Mode B — Resonance (search + verify + maintain)

> **In one line.** Mode B runs the **Lehrer/Vaschillo resonance-frequency assessment** automatically:
> it paces you across a range of breathing rates, measures where your HRV amplitude peaks, *verifies*
> with an independent accelerometer channel that you actually breathed at each rate, locks your
> resonance frequency (RF), and then tracks it. Requires a Polar H10 (validated beats **and** its ACC).
> Implemented in `resonanceController.ts` (+ `fastAmplitude.ts`, `respirationFromAcc.ts`).

### 13.1 The science — resonance frequency & the baroreflex
The cardiovascular system has a resonance. The **baroreflex** (the blood-pressure feedback loop) has a
delay of ~5 s, so oscillating it at ~0.1 Hz (~6 br/min) produces the largest swing in heart rate —
maximal respiratory sinus arrhythmia (RSA). The exact peak — your **resonance frequency** — is
individual, typically 0.075–0.12 Hz (~4.5–7 br/min), set largely by body size / blood volume.
Breathing at *your* RF maximizes HRV amplitude and trains baroreflex gain; this is the mechanism behind
HRV biofeedback (Lehrer & Vaschillo). Clinically, RF is found by pacing a person through candidate
rates and watching which maximizes HRV. **Mode B automates exactly that** — plus an objective
verification step a clinician would do by watching the person breathe.

### 13.2 Why a dedicated objective (fast amplitude)
The §8 coherence score uses a 64-s window, so after a rate change it stays contaminated by the *old*
rate for up to a minute — useless for a hill-climb that moves every few breaths. Mode B therefore uses
a faster objective: `FastAmplitudeTracker.amplitude()` returns the **mean per-breath peak-to-trough RR**
over the last `ampWindowBreaths` (2.5) breaths. It chunks recent beats into per-breath windows
(`breathS = 60 / commandedBPM`) and averages each chunk's `(max − min)` RR. This responds *within a
breath* of a rate change, so the search can move quickly. It is the **only** objective the hill-climb
consumes.

### 13.3 The dwell — settle, estimate, accept
Mode B holds each candidate rate for a **dwell** of `dwellBreaths` (6 breaths), split into:
- **Settle** — the first `ceil(dwellBreaths · (1 − dwellEstimateFraction))` breaths (≈ 2–3) are
  discarded while the pacer slews to the new rate and your breathing catches up.
- **Estimate** — the remaining ~60% is where amplitude is collected and verification is scored.

A dwell is **accepted** only if *all* of: it was artifact-clean (no beats gated mid-dwell), it produced
amplitude samples, **and** a **majority** of its estimate-window breaths verified (§13.4). Otherwise it
is discarded, re-dwelled at the same rate, and `unverifiedDwells` increments.

### 13.4 Independent verification & the Mayer-wave defense
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
`|measured − paced| ≤ tolerance` proves you truly breathed where you were paced. If the ACC can't
confirm (you're moving, slouching, or the peak is low-confidence), the dwell doesn't count.

Persistent failure ⇒ a **"hold still / follow the cue"** hint, and after `maxUnverifiedDwells` (12)
consecutive unverifiable dwells the search **aborts** (`searchAborted`) and holds a steady pace rather
than chase un-trustable data.

### 13.5 The search state machine
A state machine whose `commandedBPM` is handed to the pacer to slew toward each dwell. States
(`SearchPhase`), with the plain-language `SearchProgress.phase` the UI shows in *italics*:

1. **`probe0`** *(baseline)* — dwell at the start rate (your warm-start RF, else 6 BPM); record its
   amplitude as the baseline.
2. **`findDir`** *(baseline)* — probe one `probeStepInitBPM` (0.4 BPM) step **down**; compare its
   amplitude to baseline to decide which direction is **uphill** (toward higher HRV amplitude).
3. **`bracketOut`** *(climbing)* — step in the uphill direction, `probeStepInitBPM` at a time, shifting
   the window while amplitude keeps rising, until it **drops** — yielding a 3-point bracket
   `[low, peak, high]` straddling the maximum. (If it climbs into a search-band edge first, it locks
   there — see §13.6.)
4. **`refine`** *(refining)* — **golden-section** narrowing inside the bracket: probe the larger
   sub-interval, keep the higher-amplitude side, repeat. When the bracket can no longer tighten on the
   0.2-BPM grid (`probeStepFloorBPM`), fit a **parabola** through the three points and **lock its
   vertex** → a sub-grid resonance frequency.

Hysteresis keeps noise from flipping decisions: a rate only counts as "better" if its amplitude beats
the incumbent by `ε = max(epsilonPctOfA · A, 1 SD of the dwell's amplitudes)`.

### 13.6 Boundary lock & parabolic vertex
- **Boundary lock** — if the best-so-far dwell sits at a search-band edge (`searchLoBPM` /
  `searchHiBPM`) and an interior sample is lower, the true peak is at/beyond the clamp; it locks at the
  edge and flags **`boundaryLimited`** (surfaced in the UI, so you know the band — not your physiology —
  set the answer; widen the band and retry).
- **Parabolic vertex** — at the finest bracket the lock is the vertex of the parabola through the three
  `(rate, amplitude)` points, not the best grid point, giving sub-0.2-BPM precision on the RF.

### 13.7 Maintain — drift tracking & sudden-loss re-probe
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

### 13.8 Warm start & abort
- **Warm start** — the converged RF is persisted per user (localStorage). Next session Mode B starts the
  pacer *at* that RF and runs a short re-confirm within `±confirmProbeBPM` instead of a cold hunt.
- **Abort** — `maxUnverifiedDwells` consecutive unverifiable dwells ⇒ `searchAborted`; it stops hunting
  and holds a steady comfortable pace. Sit still and re-enter Mode B to retry.

### 13.9 What you see (UI states)
- **Searching** — e.g. *"Pacing you at 6.0 br/min to read your baseline (breath 4 of 6)"*, then
  *climbing* / *refining*, with the best rate found so far and the count of rates tested.
- **Hold-still hint** — *"Hold still and follow the cue — the H10 couldn't confirm your breathing on the
  last N attempts at this rate, so they're re-measured"* (driven by `unverifiedDwells`).
- **Maintaining** — shows your **locked resonance frequency**; flags `boundaryLimited` if it locked at a
  band edge, or `searchAborted` if it gave up.
- The breathing cue + chime pace you through every dwell; the **Breathing-wave (H10 accelerometer)
  chart** shows the independent respiration the verifier is reading.

### 13.10 A worked timeline
Seated, still, H10 connected, no saved RF:
1. **probe0** — paced 6.0 for 6 breaths (~60 s); baseline amplitude recorded once verified.
2. **findDir** — paced 5.6; amplitude higher ⇒ uphill is *downward* in rate.
3. **bracketOut** — 5.2, 4.8 … amplitude rises then falls at 4.4 ⇒ bracket ≈ `[4.4, 4.8, 5.2]`.
4. **refine** — golden-section probes inside; tightens to the 0.2-BPM floor.
5. **lock** — parabola vertex ≈ **4.9 BPM** → `maintaining`; RF persisted.
6. **maintain** — dithers ±0.1 around 4.9, tracks drift; re-probes only if amplitude suddenly collapses.

If at any dwell the ACC says you breathed at a different rate than paced, that dwell is re-measured;
too many in a row and it aborts with the hold-still hint.

### 13.11 Parameters & tuning
- **`searchLoBPM` / `searchHiBPM`** — the searched range (4.0–7.5). If `boundaryLimited`, widen it.
- **`dwellBreaths` / `dwellEstimateFraction`** — reliability vs search speed.
- **`probeStepInitBPM` / `probeStepFloorBPM`** — coarse step / final resolution.
- **`respVerifyToleranceBPM`** — how strictly "you breathed where I paced" is enforced (raise toward 1.0
  if good dwells keep getting rejected).
- **`respConfidenceMin`, `respMinHz`** — the ACC verifier's strictness / sway rejection (§ ACC
  respiration) — the usual levers when Mode B "can't confirm".
- **`maxUnverifiedDwells`** — patience before aborting.
- Maintenance: `ditherAmpBPM/PeriodS`, `escGainBPM/MaxStepBPM/MeanAlpha`, `decayFastAlpha/decaySlowAlpha`,
  `reprobeDecayPct/SustainS/CapS`.

Mode B requires a Polar H10 (validated beats **and** the accelerometer channel).

---

## 14. Mode C — Standard (on-glasses)

The legacy behavior, kept as a selectable mode: the engine is **off**, the dashboard forwards beats to
the glasses (`0xCA`), and the **firmware** computes coherence and drives the lens with its own
programs (Heartbeat / Coherence-Breathe / Coherence-Lens / Breath+Strobe). Full pipeline in
[`coherence-algorithm-reference.md`](./coherence-algorithm-reference.md).

Because the firmware owns the lens phase on a clock the app cannot observe, the dashboard's on-screen
breathing cue + chime are **hidden** in Standard mode (showing them would drift out of sync with the
glasses). The glasses themselves are the cue.

---

## 15. Tuning

Every parameter above is live in the dashboard's **Coherence Engine** panel, grouped by section. Each
knob has a click-to-expand **ⓘ** explaining what it does, its effect, and the recommended tuning
direction. The shipped defaults are the recommended starting values; **reset-all** re-applies them.
Tunable sets save/load as named presets.

Quick-start tuning order: **`cohSquashK`** (overall difficulty) → difficulty gamma (lens curve) →
Mode B `respMinHz` / `respConfidenceMin` if the ACC verifier struggles → pacer `pacerJumpThresholdBPM`
/ `pacerJumpSustainBreaths` for catch-up feel.

---

## 16. Reference literature

- **Lomb (1976); Scargle (1982)** — least-squares spectral analysis of unevenly-sampled data; lets us
  analyze the beat series without resampling.
- **HeartMath — McCraty, Childre, et al.** — physiological *coherence* as the ratio of power in the
  dominant heart-rhythm peak to surrounding power; the basis of CR and the coh% squash.
- **Lehrer & Vaschillo; Vaschillo, Vaschillo & Lehrer** — resonance-frequency HRV biofeedback: each
  person has a breathing rate (~0.075–0.12 Hz, ~4.5–7 br/min) that maximizes baroreflex-driven HRV.
  Foundation of Mode B's search and the ~6 br/min default pace.
- **Lipponen & Tarvainen (2019)** — robust HRV artifact correction via successive-difference
  classification; basis of the adaptive dRR gate.
- **Task Force of the ESC/NASPE (1996)** — standards for HRV measurement (VLF/LF/HF bands).
- **Shaffer & Ginsberg (2017)** — overview of HRV metrics and norms.
- **Elgendi et al.** — systolic-peak detection in PPG (the earclip's beat detector).
- **Baroreflex / Mayer waves (~0.1 Hz)** — the low-frequency blood-pressure oscillation Mode B's
  accelerometer channel exists to distinguish from genuine breathing.

*(Citations at author/topic level; consult the originals for exact parameters.)*

---

## 17. Commercial / prior-art examples

- **HeartMath emWave Pro / Inner Balance** — the canonical coherence-biofeedback trainers; **Mode A**
  is the closest analog (coherence score + paced breathing).
- **Clinical HRV biofeedback / resonance-frequency assessment (Lehrer protocol)** — therapists sweep
  paced breathing rates and pick the one maximizing HRV; **Mode B** automates exactly this, with the
  accelerometer adding the verification a clinician would do by observation.
- **Resonance-breathing apps** — Elite HRV, Breathe (Apple Watch), and similar paced-breathing tools
  share the breathing-cue idea but without the closed-loop coherence/resonance feedback.
- **Adjacent neurofeedback wearables** — Muse (EEG), Apollo Neuro (HRV-adjacent) — different signals,
  same biofeedback-loop philosophy.

What is distinctive here is the **output device**: rather than a screen or audio, the feedback is the
Narbis Edge **electrochromic lens** clearing as your coherence rises — driven by an app-side engine
that treats the glasses as a display.
