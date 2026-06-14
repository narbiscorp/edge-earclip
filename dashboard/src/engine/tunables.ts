/*
 * tunables.ts — every coherence-algorithm knob for the app-side Coherence Engine.
 *
 * Faithful TS port of `CoherenceTunables` in
 *   C:\CODE\EDGE Coherence Engine\updates\NarbisCoherenceEngine.swift
 * and the §8 table in the companion doc. Defaults are starting points; the ones
 * flagged "re-tune" in the doc are expected to move during the feel pass.
 *
 * Differences from the Swift struct (UI/serialization-friendly, no semantic change):
 *  - Swift tuples `lfBand`/`hfBand` are flattened to `lf/hfBandLo` + `lf/hfBandHi`.
 *  - Swift array `gammaTable` is flattened to four scalars (Easy/Medium/Hard/Expert).
 *  - `logGapToleranceFactor` (offline SessionLogger) is omitted — the dashboard has
 *    its own recording pipeline; on-device research export is out of scope here.
 *  - All UInt8/UInt16/UInt32/Double become `number`; clamping happens at the wire edge.
 */

/** Which engine drives the lens. `firmware` = the glasses' own coherence pipeline
 * (the existing on-glasses behavior); `modeA`/`modeB` = the ported app-side engine. */
export type EngineMode = 'firmware' | 'modeA' | 'modeB';

export interface CoherenceTunables {
  // --- Ingest / artifact ---
  confThreshold: number; // accept beats with quality >= this (0xE0); 0–100
  ringSize: number; // beats; ~5–10 min of headroom for the LS window + Mode B
  dRRFloorMs: number; // floor on the adaptive dRR reject threshold (gate can't fail-open at zero variability)

  // --- Analysis windows ---
  coherenceWindowS: number; // Mode A window — DO NOT change (sets ~0.0156 Hz resolution)

  // --- Lomb–Scargle (consumer live path) ---
  lsFreqLo: number; // analysis band low (also CR "total" band low)
  lsFreqHi: number; // analysis band high (CR "total" band high)
  lsDf: number; // grid density (dense sampling for peak localization)
  peakSearchLo: number; // CR peak search low (published HeartMath/registry)
  peakSearchHi: number; // CR peak search high (published HeartMath/registry)
  resonanceHz: number; // ± window around peak → 0.030 Hz integration window
  lfReadbackLo: number; // pacer resonance readback band low (LF only — NOT the CR search band)
  lfReadbackHi: number; // pacer resonance readback band high

  // --- Coherence → lens drive squash (Narbis design; bounded by construction) ---
  cohSquashK: number; // coh% = 100·CR/(CR+k). PRIMARY re-tuning knob.

  // --- LS band companions (dimensionless lf/hf, lfnu, hfnu off the live LS spectrum) ---
  lfBandLo: number;
  lfBandHi: number;
  hfBandLo: number;
  hfBandHi: number;

  // --- Mode A "Follow" pacer ---
  quintetMin: number; // 15 = 3.0 BPM (quintet = BPM × 5)
  quintetMax: number; // 60 = 12.0 BPM
  quintetDefault: number; // 30 = 6.0 BPM
  pacerAvgN: number; // resonance-freq averaging window
  pacerSlewQuintet: number; // slew limit: ±0.2 BPM per cycle boundary

  // --- Fast amplitude tracker (Mode B objective) ---
  ampWindowBreaths: number; // peak-to-trough RR over last N breaths

  // --- Mode B resonance controller ---
  dwellBreaths: number; // breaths per dwell
  dwellEstimateFraction: number; // estimate amplitude on last 60% (discard settling)
  probeStepInitBPM: number; // initial probe step
  probeStepFloorBPM: number; // resolution floor (native quintet)
  epsilonPctOfA: number; // hysteresis: max(5% of A, 1 SD of A)
  searchLoBPM: number; // resonance band low
  searchHiBPM: number; // resonance band high
  respVerifyToleranceBPM: number; // accept a dwell only if |measured−paced| ≤ this AND confidence ≥ min
  confirmProbeBPM: number; // cross-session re-confirm half-range
  maxUnverifiedDwells: number; // abort the search after this many consecutive unverified dwells

  // --- Mode B maintenance: extremum-seeking (drift) + sudden-loss re-probe ---
  ditherAmpBPM: number; // perturbation amplitude (sub-perceptual)
  ditherPeriodS: number; // perturbation period
  escGainBPM: number; // extremum-seeking integration gain (relative-gradient → BPM)
  escMaxStepBPM: number; // clamp per-cycle RF nudge
  escMeanAlpha: number; // high-pass EWMA on amplitude (fatigue immunity)
  decayFastAlpha: number; // fast amplitude EWMA (sudden-loss detector)
  decaySlowAlpha: number; // slow amplitude EWMA (reference)
  reprobeDecayPct: number; // re-probe if fastEWMA ≥ this fraction below slowEWMA
  reprobeSustainS: number; // …sustained this long…
  reprobeCapS: number; // …capped to 1 re-probe per this interval

  // --- Lens programs ---
  ewmaAlpha: number; // Program 2 smoothing (~2 s τ at 100 Hz)
  gammaEasy: number; // gammaTable[0]
  gammaMedium: number; // gammaTable[1]
  gammaHard: number; // gammaTable[2]
  gammaExpert: number; // gammaTable[3]
  dutyFloorPct: number; // breathing cue stays visible at peak coherence
  heartbeatPulseMs: number; // Program 0 flash width
  heartbeatPeakDuty: number; // Program 0 flash peak duty
  breatheInhalePct: number; // inhale fraction of the breathing cycle

  // --- Respiration from ACC (Mode B verification) ---
  accSampleHz: number; // H10 ACC stream rate
  respBandLo: number; // 0.05 Hz = 3 BPM
  respBandHi: number; // 0.50 Hz = 30 BPM
  respWindowS: number; // trailing window for the respiration estimate
  respConfidenceMin: number; // min spectral concentration to trust the estimate
}

export const DEFAULT_TUNABLES: CoherenceTunables = {
  // Ingest / artifact
  confThreshold: 50,
  ringSize: 600,
  dRRFloorMs: 180.0,
  // Analysis windows
  coherenceWindowS: 64.0,
  // Lomb–Scargle
  lsFreqLo: 0.0033,
  lsFreqHi: 0.4,
  lsDf: 0.002,
  peakSearchLo: 0.04,
  peakSearchHi: 0.26,
  resonanceHz: 0.015,
  lfReadbackLo: 0.04,
  lfReadbackHi: 0.15,
  // Coherence squash
  cohSquashK: 3.0,
  // LS band companions
  lfBandLo: 0.04,
  lfBandHi: 0.15,
  hfBandLo: 0.15,
  hfBandHi: 0.4,
  // Mode A pacer
  quintetMin: 15,
  quintetMax: 60,
  quintetDefault: 30,
  pacerAvgN: 15,
  pacerSlewQuintet: 1,
  // Fast amplitude
  ampWindowBreaths: 2.5,
  // Mode B resonance controller
  dwellBreaths: 6,
  dwellEstimateFraction: 0.6,
  probeStepInitBPM: 0.4,
  probeStepFloorBPM: 0.2,
  epsilonPctOfA: 0.05,
  searchLoBPM: 4.0,
  searchHiBPM: 7.5,
  respVerifyToleranceBPM: 0.5,
  confirmProbeBPM: 0.5,
  maxUnverifiedDwells: 12,
  // Mode B maintenance
  ditherAmpBPM: 0.1,
  ditherPeriodS: 180.0,
  escGainBPM: 0.15,
  escMaxStepBPM: 0.05,
  escMeanAlpha: 0.02,
  decayFastAlpha: 0.2,
  decaySlowAlpha: 0.02,
  reprobeDecayPct: 0.15,
  reprobeSustainS: 120.0,
  reprobeCapS: 180.0,
  // Lens programs
  ewmaAlpha: 0.005,
  gammaEasy: 1.0,
  gammaMedium: 1.5,
  gammaHard: 2.0,
  gammaExpert: 3.0,
  dutyFloorPct: 20.0,
  heartbeatPulseMs: 150.0,
  heartbeatPeakDuty: 80.0,
  breatheInhalePct: 40,
  // ACC respiration
  accSampleHz: 50.0,
  respBandLo: 0.05,
  respBandHi: 0.5,
  respWindowS: 45.0,
  respConfidenceMin: 0.4,
};

/** Recombine the four flattened gamma scalars into the difficulty table the lens uses. */
export function gammaTable(t: CoherenceTunables): number[] {
  return [t.gammaEasy, t.gammaMedium, t.gammaHard, t.gammaExpert];
}

export type CoherenceTunableKey = keyof CoherenceTunables;
