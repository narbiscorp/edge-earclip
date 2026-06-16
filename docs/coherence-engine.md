# Narbis Coherence Engine — Algorithm & Architecture

> **What this is.** The app-side **Coherence Engine** that runs inside the Narbis earclip dashboard
> (`dashboard/src/engine/`). It computes heart-rate-variability (HRV) coherence, paces your
> breathing, and drives the Edge glasses' electrochromic lens — entirely on the app side, with the
> glasses acting as a display.
>
> **Companion docs.**
> - [`coherence-algorithm-reference.md`](./coherence-algorithm-reference.md) — the **firmware** coherence
>   pipeline that runs *on the glasses* (FFT-based). Used by the Standard / on-glasses mode below.
> - [`bluetooth-protocol.md`](./bluetooth-protocol.md) — the BLE surface (opcodes, relay frames) the
>   engine commands the glasses through (§4.3, §4.7).
>
> **Source of truth.** The engine is a faithful TypeScript port of the Swift `NarbisCoherenceEngine`.
> Every stage below maps to a file in `dashboard/src/engine/`; the per-knob defaults and ranges live
> in `tunables.ts` and are exposed (with a click-to-expand ⓘ on each) in the dashboard's Coherence
> Engine panel.

---

## Table of contents
1. [Why an app-side engine](#1-why-an-app-side-engine)
2. [The three modes](#2-the-three-modes)
3. [Data flow](#3-data-flow)
4. [Calculation methodology](#4-calculation-methodology)
5. [Driving the lens](#5-driving-the-lens)
6. [Mode A — Follow](#6-mode-a--follow)
7. [Mode B — Resonance](#7-mode-b--resonance)
8. [Mode C — Standard (on-glasses)](#8-mode-c--standard-on-glasses)
9. [Tuning](#9-tuning)
10. [Reference literature](#10-reference-literature)
11. [Commercial / prior-art examples](#11-commercial--prior-art-examples)

---

## 1. Why an app-side engine

Historically the **glasses firmware** computed coherence (FFT on the incoming inter-beat intervals)
and drove the lens itself — see the companion firmware reference. That works, but the firmware is
constrained: a fixed 256-point FFT, integer breathing rates, no independent respiration sensor, and
no easy way to iterate the math.

The Coherence Engine moves **all signal processing into the app**:

- **Richer math** — a dense Lomb–Scargle periodogram (handles the unevenly-sampled beat series
  directly, no resampling artifacts), a field-standard coherence ratio, an adaptive
  Lipponen–Tarvainen artifact gate, and an independent accelerometer respiration channel.
- **Fast iteration** — every constant is a live, unit-tested tunable.
- **The glasses become a display.** The engine computes *what the lens should do* and commands the
  firmware's own smooth breathe / static / strobe program over BLE (it does **not** stream per-tick
  PWM — see [§5](#5-driving-the-lens)).

The engine is a main-thread singleton (`coherenceEngine`, an `EventTarget`) that mirrors the
`edgeDevice` / `polarH10` device objects: it ingests beats + accelerometer samples from the existing
device events, ticks itself, and publishes status (coherence, CR, pacer BPM, Mode B state) via events.

---

## 2. The three modes

The dashboard's engine selector is mutually exclusive — exactly one mode is active:

| Mode | Name | Who computes | Who paces | Who drives the lens |
|---|---|---|---|---|
| **A** | **Follow** | app (engine) | app — follows *your* drifting resonance | engine → firmware breathe program |
| **B** | **Resonance** | app (engine) | app — *searches* for your resonance frequency | engine → firmware breathe program |
| **C** | **Standard (on-glasses)** | **firmware** | firmware adaptive pacer | firmware (its own coherence pipeline) |

- **Mode A / Mode B** are the app-side engine. The glasses are a dumb display.
- **Mode C (Standard)** is the legacy on-glasses behavior: the dashboard forwards beats to the
  firmware (`0xCA`) and the firmware does everything. The engine is OFF; the dashboard's on-screen
  breathing cue + chime are hidden in this mode (the firmware owns the lens phase and the app cannot
  observe it — see [§8](#8-mode-c--standard-on-glasses)).

Switching modes is a lifecycle action: entering A/B starts the engine and sets the firmware aside;
returning to C stops the engine and restores the firmware program.

---

## 3. Data flow

```
   Polar H10 (RR + monotonic beat timestamps)        H10 accelerometer (Mode B only)
   or earclip beats                                          │
            │                                                │  x/y/z @ 50 Hz (Polar PMD)
            ▼                                                ▼
   ┌─────────────────────┐                        ┌────────────────────────────┐
   │ Artifact gate       │  adaptive dRR,          │ RespirationFromACC          │
   │ (AdaptiveDRRGate /  │  drop-not-interpolate   │ |x,y,z| → detrend+Hann →    │
   │  IBIIngest)         │                         │ periodogram → prominence    │
   └─────────┬───────────┘                         │ peak + confidence           │
             │ clean beat ring                      └─────────────┬──────────────┘
             ▼                                                     │ measured breathing BPM
   ┌─────────────────────┐                                         │ + confidence
   │ LombScargleCore     │  1 Hz                                   │
   │ Lomb–Scargle PSD →  │────────► CR, coh%, resp peak            │
   │ CR + squash         │            │            │               │
   └─────────────────────┘            │            │               ▼
                                       │            ▼        ┌─────────────────────┐
                                       │     ┌────────────┐  │ ResonanceController │ (Mode B)
                                       │     │ FollowPacer │  │ hill-climb + per-   │
                                       │     │ slew + jump │◄─┤ dwell verification  │
                                       │     └─────┬──────┘  └─────────────────────┘
                          coh% (depth) │           │ pacer BPM
                                       ▼           ▼
                              ┌────────────────────────────┐
                              │ Lens command (LensState)    │  ~1 Hz + per breath boundary
                              │ → edgeDevice.driveLens       │
                              └─────────────┬───────────────┘
                                            ▼
                              firmware breathe / static program (renders the smooth cycle)
                                            ▼
                                  on-screen cue + chime lock to the engine breath clock
```

Cadences: beats ingest per notification; the Lomb–Scargle compute + pacer push run at **1 Hz**; the
pacer latches + Mode B controller advance at each **breath-cycle boundary**; lens params are pushed
~1 Hz (and on each boundary), **not** per render tick.

---

## 4. Calculation methodology

### 4.1 Artifact gate — `adaptiveDrrGate.ts` / `ibiIngest.ts`
The single source of truth for rejecting bad beats, shared by every beat path (H10, engine,
earclip-relay). An adaptive bidirectional **successive-difference (dRR)** gate (Lipponen–Tarvainen
basis): a beat is rejected when

```
|RR_n − RR_{n−1}|  >  max( 5.2 × quartileDeviation(recent dRR),  dRRFloorMs )
```

after a physiological bounds check (250–2500 ms). Rejected beats are **dropped, never interpolated**,
and the gate does **not** advance its reference on a reject (so one artifact cannot cascade into the
next good beat). There is no fixed ±band — that would clip legitimate large respiratory-sinus-
arrhythmia swings at high coherence. The floor stops the gate failing open when variability ≈ 0.

### 4.2 Coherence — `lombScargleCore.ts`
A dense **Lomb–Scargle periodogram** over the clean beat series (no resampling — it handles the
uneven beat spacing natively). From it:

- **CR (coherence ratio)** — the field-standard HeartMath-style ratio: power concentrated in the
  dominant peak within the resonance band (0.04–0.26 Hz, ±0.015 Hz integration) relative to the rest
  of the band. High CR = the heart rate is oscillating strongly at one frequency = strong
  parasympathetic/baroreflex resonance.
- **coh% (the 0–100 lens drive)** — a bounded squash of CR: `coh% = 100 · CR / (CR + k)`, where `k`
  (`cohSquashK`) is the primary feel knob (lower = easier, saturates fast; higher = harder).
- **Resonance read-back** — the LF-only peak (0.04–0.15 Hz) the Follow pacer tracks, plus LF/HF
  companions for the display.

### 4.3 Respiration from the accelerometer — `respirationFromAcc.ts` (Mode B only)
An **independent** breathing channel, immune to the Mayer-wave confound that corrupts RSA-based rate
estimates off-resonance. Vector-magnitude of the H10 accelerometer → detrend + Hann window →
periodogram → **prominence-based** peak pick (a sharp breathing peak beats a broad postural-sway hump
even when the sway carries more raw power), with a low-frequency **sway floor** and a harmonic-robust
confidence metric. Outputs a measured breathing rate + a 0–1 confidence used to *verify* Mode B dwells.

### 4.4 Pacer — `followPacer.ts`
Converts the resonance read-back into the breathing rate shown + commanded. Two-speed: it **glides**
±0.2 BPM/breath when near target, but **snaps** to the detected rate once it has been ≥ a threshold
away for several consecutive breaths (the sustain count is the wall against a transient false
reading). Native resolution is 0.2 BPM ("quintets" = BPM × 5).

---

## 5. Driving the lens

The engine reduces the lens to a small **`LensState`** ( `{ style, bpm, depthPct, inhalePct, … }` )
that it pushes ~1 Hz. The host (`edgeDevice.driveLens`) coalesces it into the firmware's existing
commands — writing an opcode only when its value changed:

| Lens style | Firmware command | Depth source |
|---|---|---|
| **breathingGuide** | `0xB0` BREATHE + `0xB1` rate + `0xA2` brightness + `0xBA` phase sync | engine coherence → `depthPct` |
| **coherenceLens** | `0xA5` static-duty setpoint (slow, ~1 Hz) | engine coherence |
| **breatheStrobe** | breathe + `0xAB`/`0xAC` strobe *(strobe overlay pending a firmware opcode)* |

The firmware renders the smooth 100 Hz cosine breathe waveform locally, so the link carries only
occasional parameter writes — **never per-tick PWM** (which is choppy over BLE). Depth is computed
**app-side** from the engine's coherence (`depth = brightness · (1 − (coh/100)^γ)`, γ = the
difficulty curve), so the glasses never compute coherence in Mode A/B.

**Cue sync.** The on-screen breathing orb + audio chime read the engine's breath-cycle position
directly (single clock authority), so the screen rate matches the lens. The glasses are phase-locked
to that same clock: at each cycle boundary — and on Mode A/B start / glasses-connect — the engine
sends the firmware a **`0xBA` BREATHE_SYNC** (`[cycle_ms u16 LE][inhale_pct u8]`), which restarts the
firmware's breathe cosine at the on-screen inhale boundary and renders at the *exact* cycle length, so
orb, chime, and lens share one clock. Re-anchoring only at the boundary (where the waveform is ~0)
plus a firmware lens slew-rate limiter (~250 ms fade) means resyncs never snap, even as the pacer
drifts. Glasses on firmware **< 4.15.5** ignore `0xBA` and stay rate-synced only (the prior behavior —
no regression).

See [`bluetooth-protocol.md` §4.7](./bluetooth-protocol.md) for the opcode-level detail.

---

## 6. Mode A — Follow

**Coherence biofeedback that paces you toward your own drifting resonance.** The engine measures the
frequency at which your HRV is currently strongest (the LF read-back), and the Follow pacer guides
your breathing toward it — gently gliding, snapping when you have clearly moved. The lens depth
tracks your coherence (clears as you get more coherent). This is the everyday training mode: breathe
with the cue, watch the lens clear.

---

## 7. Mode B — Resonance

**An automated Lehrer/Vaschillo resonance-frequency search.** Resonance frequency — the breathing
rate that maximizes HRV amplitude via the baroreflex, typically ~4.5–6.5 br/min — varies per person.
Mode B finds yours:

1. **Baseline → hill-climb.** It paces you at a series of candidate rates, holding each for a *dwell*
   (default 6 breaths), measuring the resulting HRV amplitude, and bracketing the peak with adaptive
   steps + a parabolic vertex lock.
2. **Independent verification.** Each dwell only counts if the **accelerometer** confirms you actually
   breathed at the paced rate (confidence ≥ min AND |measured − paced| ≤ tolerance). This defends
   against the Mayer wave — a ~0.1 Hz baroreflex oscillation that can masquerade as breathing in the
   RSA peak but is absent from real chest motion. Persistent unverified dwells surface a "hold still"
   hint and eventually abort the search.
3. **Maintain.** Once locked, an extremum-seeking dither tracks slow drift, and a sudden-loss detector
   re-probes if HRV amplitude collapses. The converged resonance frequency is persisted per user for a
   warm start next session.

Mode B requires a Polar H10 (validated beats **and** its accelerometer).

---

## 8. Mode C — Standard (on-glasses)

The legacy behavior, kept as a selectable mode: the engine is **off**, the dashboard forwards beats to
the glasses (`0xCA`), and the **firmware** computes coherence and drives the lens with its own
programs (Heartbeat / Coherence-Breathe / Coherence-Lens / Breath+Strobe). Full detail in
[`coherence-algorithm-reference.md`](./coherence-algorithm-reference.md).

Because the firmware owns the lens phase on a clock the app cannot observe, the dashboard's on-screen
breathing cue + chime are **hidden** in Standard mode (showing them would drift out of sync with the
glasses). The glasses themselves are the cue.

---

## 9. Tuning

Every parameter is live-tunable in the dashboard's **Coherence Engine** panel, grouped by section
(Ingest, Lomb–Scargle, Lens, Mode A pacer, Mode B fast-amplitude / resonance / ACC respiration). Each
knob has a click-to-expand **ⓘ** explaining what it does, its effect, and the recommended tuning
direction. The shipped defaults are the recommended starting values; **reset-all** re-applies them.
Tunable sets save/load as named presets.

The single most impactful knob is **Squash k** (`cohSquashK`) — the difficulty of the 0–100 score.

---

## 10. Reference literature

- **Lomb (1976); Scargle (1982)** — least-squares spectral analysis of unevenly-sampled data (the
  Lomb–Scargle periodogram), which lets us spectrum-analyze the beat series without resampling.
- **HeartMath — McCraty, Childre, et al.** — physiological *coherence* as the ratio of power in the
  dominant heart-rhythm peak to surrounding power; the basis of the CR metric and the coh% squash.
- **Lehrer & Vaschillo; Vaschillo et al.** — resonance-frequency HRV biofeedback: each person has a
  breathing rate (~0.075–0.12 Hz, ~4.5–7 br/min) that maximizes baroreflex-driven HRV amplitude. The
  foundation of Mode B's search and the ~6 br/min default pace.
- **Lipponen & Tarvainen (2019)** — robust HRV time-series artifact correction via successive-
  difference classification; the basis of the adaptive dRR gate.
- **Task Force of the ESC/NASPE (1996)** — standards for HRV measurement (VLF/LF/HF bands).
- **Shaffer & Ginsberg (2017)** — overview of HRV metrics and norms.
- **Elgendi et al.** — systolic-peak detection in PPG (the earclip's beat detector).
- **Baroreflex / Mayer waves (~0.1 Hz)** — the low-frequency blood-pressure oscillation Mode B's
  accelerometer channel exists to distinguish from genuine breathing.

*(Citations are given at author/topic level; consult the originals for exact parameters.)*

---

## 11. Commercial / prior-art examples

- **HeartMath emWave Pro / Inner Balance** — the canonical coherence-biofeedback trainers; Mode A is
  the closest analog (coherence score + paced breathing).
- **Clinical HRV biofeedback / resonance-frequency assessment (Lehrer protocol)** — therapists sweep
  paced breathing rates and pick the one maximizing HRV; Mode B automates exactly this.
- **Resonance-breathing apps** — Elite HRV, Breathe (Apple Watch), and similar paced-breathing tools
  share the breathing-cue idea but without the closed-loop coherence/resonance feedback.
- **Adjacent neurofeedback wearables** — Muse (EEG), Apollo Neuro (HRV-adjacent) — different signals,
  same biofeedback-loop philosophy.

What is distinctive here is the **output device**: rather than a screen or audio, the feedback is the
Narbis Edge **electrochromic lens** clearing as your coherence rises — driven by an app-side engine
that treats the glasses as a display.
