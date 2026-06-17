/*
 * coherenceFieldSchema.ts — UI schema for the app-side Coherence Engine tunables.
 *
 * Parallel to the firmware config's fieldSchema.ts, but float-aware and gated by engine
 * mode rather than the firmware integer-wire constraints. Every coherence tunable is a
 * scalar number, so the only field kind is `numeric`. The Firmware/Mode A/Mode B selector
 * is a separate control (it edits engineMode, not a tunable).
 *
 * A field is visible when the selected engine mode is in its `modes` list — so each mode's
 * tunables only appear when that mode is selected (shared tunables list both A and B).
 */
import type { ActiveEngineMode, EngineMode } from '../../engine/coherenceEngine';
import type { CoherenceTunableKey, CoherenceTunables } from '../../engine/tunables';

export type CohSectionId =
  | 'ingest'
  | 'lombscargle'
  | 'spectral'
  | 'lens'
  | 'modeC'
  | 'pacer'
  | 'fastAmp'
  | 'resonance'
  | 'acc';

export interface CohSectionDef {
  id: CohSectionId;
  label: string;
  modes: ActiveEngineMode[];
  defaultExpanded: boolean;
}

export const COH_SECTIONS: CohSectionDef[] = [
  { id: 'ingest', label: 'Ingest & artifact gate', modes: ['modeA', 'modeB'], defaultExpanded: false },
  { id: 'lombscargle', label: 'Lomb–Scargle & coherence', modes: ['modeA', 'modeB'], defaultExpanded: true },
  { id: 'spectral', label: 'Detrend & spectral averaging', modes: ['modeA', 'modeB'], defaultExpanded: false },
  { id: 'lens', label: 'Lens program', modes: ['modeA', 'modeB'], defaultExpanded: false },
  { id: 'modeC', label: 'Mode C — settle & find', modes: ['modeC'], defaultExpanded: true },
  { id: 'pacer', label: 'Mode A — follow pacer', modes: ['modeA'], defaultExpanded: true },
  { id: 'fastAmp', label: 'Mode B — fast amplitude', modes: ['modeB'], defaultExpanded: true },
  { id: 'resonance', label: 'Mode B — resonance search', modes: ['modeB'], defaultExpanded: true },
  { id: 'acc', label: 'Mode B — ACC respiration', modes: ['modeB'], defaultExpanded: false },
];

export interface CohNumericField {
  key: CoherenceTunableKey;
  section: CohSectionId;
  modes: ActiveEngineMode[];
  label: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
  help?: string;
}

const f = (spec: CohNumericField): CohNumericField => spec;

export const COH_FIELDS: CohNumericField[] = [
  // --- Ingest & artifact gate (shared) ---
  f({ key: 'confThreshold', section: 'ingest', modes: ['modeA', 'modeB'], label: 'Confidence threshold', min: 0, max: 100, step: 1, help: 'Min beat-quality to accept.' }),
  f({ key: 'ringSize', section: 'ingest', modes: ['modeA', 'modeB'], label: 'Beat buffer', min: 256, max: 1024, step: 1, unit: 'beats', help: 'Sized for the LS window + Mode B headroom.' }),
  f({ key: 'dRRFloorMs', section: 'ingest', modes: ['modeA', 'modeB'], label: 'dRR floor', min: 50, max: 400, step: 5, unit: 'ms', help: 'Floor on the adaptive artifact threshold (stops it failing open at zero variability).' }),

  // --- Lomb–Scargle & coherence (shared) ---
  f({ key: 'coherenceWindowS', section: 'lombscargle', modes: ['modeA', 'modeB'], label: 'Coherence window', min: 32, max: 128, step: 1, unit: 's', help: 'FIXED at 64 — sets the ~0.0156 Hz resolution. Change with care.' }),
  f({ key: 'lsFreqLo', section: 'lombscargle', modes: ['modeA', 'modeB'], label: 'Analysis band low', min: 0.001, max: 0.02, step: 0.0001, unit: 'Hz' }),
  f({ key: 'lsFreqHi', section: 'lombscargle', modes: ['modeA', 'modeB'], label: 'Analysis band high', min: 0.2, max: 0.5, step: 0.01, unit: 'Hz' }),
  f({ key: 'lsDf', section: 'lombscargle', modes: ['modeA', 'modeB'], label: 'Grid density', min: 0.001, max: 0.005, step: 0.0005, unit: 'Hz' }),
  f({ key: 'peakSearchLo', section: 'lombscargle', modes: ['modeA', 'modeB'], label: 'CR peak search low', min: 0.02, max: 0.1, step: 0.005, unit: 'Hz', help: 'Published value 0.04.' }),
  f({ key: 'peakSearchHi', section: 'lombscargle', modes: ['modeA', 'modeB'], label: 'CR peak search high', min: 0.15, max: 0.35, step: 0.005, unit: 'Hz', help: 'Published value 0.26.' }),
  f({ key: 'resonanceHz', section: 'lombscargle', modes: ['modeA', 'modeB'], label: 'CR integration ±window', min: 0.005, max: 0.03, step: 0.001, unit: 'Hz' }),
  f({ key: 'lfReadbackLo', section: 'lombscargle', modes: ['modeA', 'modeB'], label: 'Pacer readback low', min: 0.02, max: 0.1, step: 0.005, unit: 'Hz' }),
  f({ key: 'lfReadbackHi', section: 'lombscargle', modes: ['modeA', 'modeB'], label: 'Pacer readback high', min: 0.1, max: 0.25, step: 0.005, unit: 'Hz' }),
  f({ key: 'cohSquashK', section: 'lombscargle', modes: ['modeA', 'modeB'], label: 'Squash k', min: 1.0, max: 8.0, step: 0.1, help: 'coh% = 100·CR/(CR+k). PRIMARY tuning knob.' }),
  f({ key: 'lfBandLo', section: 'lombscargle', modes: ['modeA', 'modeB'], label: 'LF band low', min: 0.02, max: 0.1, step: 0.005, unit: 'Hz' }),
  f({ key: 'lfBandHi', section: 'lombscargle', modes: ['modeA', 'modeB'], label: 'LF band high', min: 0.1, max: 0.2, step: 0.005, unit: 'Hz' }),
  f({ key: 'hfBandLo', section: 'lombscargle', modes: ['modeA', 'modeB'], label: 'HF band low', min: 0.1, max: 0.2, step: 0.005, unit: 'Hz' }),
  f({ key: 'hfBandHi', section: 'lombscargle', modes: ['modeA', 'modeB'], label: 'HF band high', min: 0.3, max: 0.5, step: 0.01, unit: 'Hz' }),

  // --- Detrend & spectral averaging (shared; Mode A LS upgrade) ---
  f({ key: 'detrendEnabled', section: 'spectral', modes: ['modeA', 'modeB'], label: 'Detrend on/off', min: 0, max: 1, step: 1, help: '1 = smoothness-priors detrend before the LS; 0 = legacy mean-only.' }),
  f({ key: 'detrendLambda', section: 'spectral', modes: ['modeA', 'modeB'], label: 'Detrend λ', min: 100, max: 1000, step: 50, help: 'Tarvainen smoothness-priors λ. Higher removes only slower drift.' }),
  f({ key: 'spectralSegments', section: 'spectral', modes: ['modeA', 'modeB'], label: 'Welch segments', min: 1, max: 5, step: 1, help: '1 = single periodogram; ≥2 averages overlapping sub-windows to cut variance.' }),
  f({ key: 'spectralOverlapPct', section: 'spectral', modes: ['modeA', 'modeB'], label: 'Welch overlap', min: 0, max: 75, step: 5, unit: '%', help: 'Overlap between the averaged sub-windows.' }),

  // --- Lens program (shared) ---
  f({ key: 'ewmaAlpha', section: 'lens', modes: ['modeA', 'modeB'], label: 'Program-2 EWMA α', min: 0.002, max: 0.02, step: 0.001 }),
  f({ key: 'gammaEasy', section: 'lens', modes: ['modeA', 'modeB'], label: 'Gamma — Easy', min: 0.5, max: 4.0, step: 0.1 }),
  f({ key: 'gammaMedium', section: 'lens', modes: ['modeA', 'modeB'], label: 'Gamma — Medium', min: 0.5, max: 4.0, step: 0.1 }),
  f({ key: 'gammaHard', section: 'lens', modes: ['modeA', 'modeB'], label: 'Gamma — Hard', min: 0.5, max: 4.0, step: 0.1 }),
  f({ key: 'gammaExpert', section: 'lens', modes: ['modeA', 'modeB'], label: 'Gamma — Expert', min: 0.5, max: 5.0, step: 0.1 }),
  f({ key: 'dutyFloorPct', section: 'lens', modes: ['modeA', 'modeB'], label: 'Duty floor', min: 0, max: 50, step: 1, unit: '%', help: 'Breathing cue stays visible at peak coherence.' }),
  f({ key: 'heartbeatPulseMs', section: 'lens', modes: ['modeA', 'modeB'], label: 'Heartbeat pulse width', min: 100, max: 300, step: 10, unit: 'ms' }),
  f({ key: 'heartbeatPeakDuty', section: 'lens', modes: ['modeA', 'modeB'], label: 'Heartbeat peak duty', min: 0, max: 100, step: 1, unit: '%' }),
  f({ key: 'breatheInhalePct', section: 'lens', modes: ['modeA', 'modeB'], label: 'Inhale fraction', min: 20, max: 70, step: 1, unit: '%' }),

  // --- Mode A follow pacer ---
  f({ key: 'quintetMin', section: 'pacer', modes: ['modeA'], label: 'Pacer floor', min: 10, max: 30, step: 1, help: 'Quintet (BPM×5); 15 = 3.0 BPM.' }),
  f({ key: 'quintetMax', section: 'pacer', modes: ['modeA'], label: 'Pacer ceiling', min: 40, max: 70, step: 1, help: 'Quintet; 60 = 12.0 BPM.' }),
  f({ key: 'quintetDefault', section: 'pacer', modes: ['modeA'], label: 'Pacer start', min: 15, max: 60, step: 1, help: 'Quintet; 30 = 6.0 BPM.' }),
  f({ key: 'pacerAvgN', section: 'pacer', modes: ['modeA'], label: 'Readback averaging', min: 8, max: 30, step: 1, unit: 'samples' }),
  f({ key: 'pacerSlewQuintet', section: 'pacer', modes: ['modeA'], label: 'Slew limit', min: 1, max: 3, step: 1, help: 'Quintet/cycle; 1 = ±0.2 BPM per breath (the gentle glide).' }),
  f({ key: 'pacerJumpThresholdBPM', section: 'pacer', modes: ['modeA'], label: 'Jump threshold', min: 0.4, max: 3, step: 0.1, unit: 'BPM', help: 'Snap (not glide) toward the detected rate when it is at least this far from the current pace.' }),
  f({ key: 'pacerJumpSustainBreaths', section: 'pacer', modes: ['modeA'], label: 'Jump sustain', min: 1, max: 6, step: 1, unit: 'breaths', help: 'Require the gap to persist this many breaths before snapping — guards against a transient false reading.' }),

  // --- Mode B fast amplitude ---
  f({ key: 'ampWindowBreaths', section: 'fastAmp', modes: ['modeB'], label: 'Amplitude window', min: 2.0, max: 3.0, step: 0.1, unit: 'breaths' }),

  // --- Mode B resonance search ---
  f({ key: 'dwellBreaths', section: 'resonance', modes: ['modeB'], label: 'Dwell length', min: 4, max: 8, step: 1, unit: 'breaths' }),
  f({ key: 'dwellEstimateFraction', section: 'resonance', modes: ['modeB'], label: 'Estimate fraction', min: 0.5, max: 0.7, step: 0.05, help: 'Estimate on the last fraction (discard settling).' }),
  f({ key: 'probeStepInitBPM', section: 'resonance', modes: ['modeB'], label: 'Initial probe step', min: 0.3, max: 0.6, step: 0.05, unit: 'BPM' }),
  f({ key: 'probeStepFloorBPM', section: 'resonance', modes: ['modeB'], label: 'Step floor', min: 0.1, max: 0.3, step: 0.05, unit: 'BPM' }),
  f({ key: 'epsilonPctOfA', section: 'resonance', modes: ['modeB'], label: 'Hysteresis ε (frac of A)', min: 0.03, max: 0.1, step: 0.01 }),
  f({ key: 'searchLoBPM', section: 'resonance', modes: ['modeB'], label: 'Search band low', min: 3.5, max: 4.5, step: 0.1, unit: 'BPM' }),
  f({ key: 'searchHiBPM', section: 'resonance', modes: ['modeB'], label: 'Search band high', min: 7.0, max: 8.0, step: 0.1, unit: 'BPM' }),
  f({ key: 'respVerifyToleranceBPM', section: 'resonance', modes: ['modeB'], label: 'Verify tolerance', min: 0.2, max: 1.0, step: 0.05, unit: 'BPM' }),
  f({ key: 'confirmProbeBPM', section: 'resonance', modes: ['modeB'], label: 'Cross-session re-confirm', min: 0.3, max: 0.7, step: 0.05, unit: 'BPM' }),
  f({ key: 'maxUnverifiedDwells', section: 'resonance', modes: ['modeB'], label: 'Max unverified dwells', min: 4, max: 24, step: 1, help: 'Abort the search after this many consecutive unverified dwells.' }),
  f({ key: 'ditherAmpBPM', section: 'resonance', modes: ['modeB'], label: 'Dither amplitude', min: 0.05, max: 0.15, step: 0.01, unit: 'BPM' }),
  f({ key: 'ditherPeriodS', section: 'resonance', modes: ['modeB'], label: 'Dither period', min: 120, max: 300, step: 10, unit: 's' }),
  f({ key: 'escGainBPM', section: 'resonance', modes: ['modeB'], label: 'Extremum-seek gain', min: 0.05, max: 0.3, step: 0.01 }),
  f({ key: 'escMaxStepBPM', section: 'resonance', modes: ['modeB'], label: 'Extremum-seek max step', min: 0.02, max: 0.1, step: 0.01, unit: 'BPM' }),
  f({ key: 'escMeanAlpha', section: 'resonance', modes: ['modeB'], label: 'High-pass EWMA α', min: 0.01, max: 0.05, step: 0.005 }),
  f({ key: 'decayFastAlpha', section: 'resonance', modes: ['modeB'], label: 'Fast EWMA α', min: 0.1, max: 0.4, step: 0.05 }),
  f({ key: 'decaySlowAlpha', section: 'resonance', modes: ['modeB'], label: 'Slow EWMA α', min: 0.01, max: 0.05, step: 0.005 }),
  f({ key: 'reprobeDecayPct', section: 'resonance', modes: ['modeB'], label: 'Re-probe drop threshold', min: 0.1, max: 0.2, step: 0.01 }),
  f({ key: 'reprobeSustainS', section: 'resonance', modes: ['modeB'], label: 'Re-probe sustain', min: 60, max: 180, step: 10, unit: 's' }),
  f({ key: 'reprobeCapS', section: 'resonance', modes: ['modeB'], label: 'Re-probe cooldown', min: 120, max: 300, step: 10, unit: 's' }),

  // --- Mode B ACC respiration ---
  f({ key: 'accSampleHz', section: 'acc', modes: ['modeB'], label: 'ACC sample rate', min: 25, max: 200, step: 25, unit: 'Hz', help: 'Must match the PMD stream config.' }),
  f({ key: 'respBandLo', section: 'acc', modes: ['modeB'], label: 'Resp band low', min: 0.02, max: 0.1, step: 0.01, unit: 'Hz' }),
  f({ key: 'respBandHi', section: 'acc', modes: ['modeB'], label: 'Resp band high', min: 0.3, max: 0.6, step: 0.05, unit: 'Hz' }),
  f({ key: 'respWindowS', section: 'acc', modes: ['modeB'], label: 'Resp window', min: 30, max: 60, step: 5, unit: 's' }),
  f({ key: 'respConfidenceMin', section: 'acc', modes: ['modeB'], label: 'Min confidence', min: 0.3, max: 0.6, step: 0.05 }),
  f({ key: 'respMinHz', section: 'acc', modes: ['modeB'], label: 'Sway floor', min: 0.05, max: 0.12, step: 0.005, unit: 'Hz', help: 'ACC peaks below this are de-weighted as postural sway. Raise if a low-freq wobble reads as breathing; lower for very slow breathers.' }),
  f({ key: 'respNearPeakHz', section: 'acc', modes: ['modeB'], label: 'Peak window', min: 0.02, max: 0.08, step: 0.005, unit: 'Hz', help: '± band treated as the breathing peak (confidence numerator).' }),
  f({ key: 'respHarmonicExcludeMult', section: 'acc', modes: ['modeB'], label: 'Harmonic cutoff', min: 1.3, max: 2.5, step: 0.1, unit: '×', help: 'Confidence ignores power above this × the peak, so breathing harmonics do not deflate it.' }),

  // --- Mode C settle & find (warm-up gate) ---
  f({ key: 'modeCWarmupS', section: 'modeC', modes: ['modeC'], label: 'Warm-up minimum', min: 30, max: 300, step: 5, unit: 's', help: 'Min Follow warm-up before the gate can pass.' }),
  f({ key: 'modeCWarmupMaxS', section: 'modeC', modes: ['modeC'], label: 'Warm-up cap', min: 60, max: 600, step: 5, unit: 's', help: 'Relaxes ONLY the stability gate; confident ACC is always required.' }),
  f({ key: 'modeCStabilityWindowS', section: 'modeC', modes: ['modeC'], label: 'Stability window', min: 10, max: 60, step: 5, unit: 's', help: 'Window for the detected-rate SD + ACC-confidence fraction.' }),
  f({ key: 'modeCStabilityBpmSd', section: 'modeC', modes: ['modeC'], label: 'Stability SD', min: 0.2, max: 1.5, step: 0.1, unit: 'BPM', help: 'Detected-rate SD must be ≤ this to transition before the cap.' }),
];

/** Click-to-expand detail for each knob (the ⓘ button on the field). Says what the parameter
 * does, its effect, and the recommended tuning direction where one exists. Apostrophe-free to keep
 * the single-quoted strings simple. */
export const COH_FIELD_INFO: Partial<Record<CoherenceTunableKey, string>> = {
  // Ingest & artifact gate
  confThreshold: 'Beats whose quality score is below this are dropped before analysis. The Polar H10 reports 100, so this mainly gates noisier sources. Higher = stricter. Leave at 50 for H10.',
  ringSize: 'How many recent beats are held in memory. Must cover the coherence window plus the Mode B dwell history (~600 is roughly 8-10 min at rest). Rarely needs changing.',
  dRRFloorMs: 'Floor on the adaptive artifact gate: a beat is rejected when its interval jumps more than max(5.2 x recent variability, this floor) from the previous one. The floor stops the gate over-rejecting when breathing is very regular. Raise toward 250 if real beats are dropped; lower toward 120 to catch subtler ectopics.',
  // Lomb-Scargle & coherence
  coherenceWindowS: 'Trailing window the Lomb-Scargle spectrum runs over. Fixed at 64 s, which sets the ~0.0156 Hz resolution the whole engine assumes. Changing it shifts every band - leave it unless you know why.',
  lsFreqLo: 'Low edge of the full analysis band (also the CR total-power band). Default 0.0033 Hz. Widen only to chase unusual signals.',
  lsFreqHi: 'High edge of the analysis band. Default 0.4 Hz spans up through the HF range.',
  lsDf: 'Frequency-grid spacing for the spectrum. Denser (smaller) sharpens peak localization at some CPU cost. 0.002 Hz is a good balance.',
  peakSearchLo: 'Low edge of the band the coherence peak is searched in (the published resonance range starts at 0.04 Hz = 2.4 br/min).',
  peakSearchHi: 'High edge of the coherence peak search (0.26 Hz = 15.6 br/min). CR = peak power divided by the rest of the band.',
  resonanceHz: 'Half-width of the integration window around the coherence peak (default +/-0.015 Hz). Wider captures a broader resonance hump and raises the score; narrower is stricter.',
  lfReadbackLo: 'Low edge of the LF-only band the Follow pacer reads your resonance rate back from (0.04 Hz). Kept separate from the CR search band so the pacer tracks breathing.',
  lfReadbackHi: 'High edge of the pacer readback band (0.15 Hz = 9 br/min).',
  cohSquashK: 'THE primary feel knob. Maps the raw coherence ratio to the 0-100 score: coh% = 100 x CR / (CR + k). LOWER k (toward 1) is easier - the score climbs fast and saturates. HIGHER k (toward 8) is harder - you must hold strong coherence for a high score. Tune this first.',
  lfBandLo: 'Low edge of the LF band for the LF and LF/HF readouts (display only - does not drive the lens). Standard 0.04 Hz.',
  lfBandHi: 'High edge of the LF band (0.15 Hz).',
  hfBandLo: 'Low edge of the HF band for the HF readout (0.15 Hz).',
  hfBandHi: 'High edge of the HF band (0.4 Hz).',
  // Detrend & spectral averaging
  detrendEnabled: 'Turns on smoothness-priors detrending (the Kubios method) before the coherence spectrum. 1 = on (removes slow drift and very-low-frequency trend so it cannot inflate the total-power term and depress the score), 0 = the legacy mean-only removal. Leave on.',
  detrendLambda: 'Stiffness of the detrend trend line (Tarvainen lambda). HIGHER (toward 1000) removes only the slowest drift and keeps more low-frequency content; LOWER (toward 100) removes faster wander too. 500 puts the cutoff near 0.035 Hz, below the LF band, so it cleans drift without touching the breathing peak.',
  spectralSegments: 'How many overlapping sub-windows the spectrum is averaged over (Welch averaging). 1 is a single periodogram (sharpest resolution, noisiest score). 3 averages three sub-windows, which steadies the live score at the cost of coarser resolution within each. 2-3 is a good balance; above 4 the LF band under-resolves.',
  spectralOverlapPct: 'How much the averaged sub-windows overlap. More overlap forms more sub-windows from the same data (steadier) at the cost of correlated segments. 50 percent is standard.',
  // Lens program
  ewmaAlpha: 'Legacy smoothing for the old app-rendered lens. The firmware now renders the cycle and depth tracks live coherence, so this has little effect. Leave at default.',
  gammaEasy: 'Difficulty curve for Easy: lens depth = brightness x (1 - (coh/100)^gamma). Gamma 1.0 is linear (50% coherence = 50% clear).',
  gammaMedium: 'Difficulty curve for Medium (~1.5): the lens demands somewhat higher coherence before clearing than Easy.',
  gammaHard: 'Difficulty curve for Hard (~2.0): clears noticeably slower - you hold higher coherence to open the lens.',
  gammaExpert: 'Difficulty curve for Expert (~3.0): the lens only clears near peak coherence. Pick the level in the main controls; these set what each level means.',
  dutyFloorPct: 'Minimum lens darkness at peak coherence for the legacy app-rendered breathe cue, so it never fully vanishes. With the firmware rendering the cycle now this has limited effect; 0 lets the lens clear fully at perfect coherence.',
  heartbeatPulseMs: 'Width of the per-beat flash in the Heartbeat program. ~150 ms reads as a gentle pulse.',
  heartbeatPeakDuty: 'Peak darkness of the Heartbeat flash (0-100%). 80% is a soft pulse.',
  breatheInhalePct: 'Inhale fraction of each breath cycle. 40 = inhale 40% / exhale 60%; the longer exhale is the standard resonance-breathing shape. Sent to the glasses as the breathe inhale ratio.',
  // Mode A follow pacer
  quintetMin: 'Lowest pace the engine will set, in quintets (BPM x 5): 15 = 3.0 BPM. The pace is clamped to this floor.',
  quintetMax: 'Highest pace, in quintets: 60 = 12.0 BPM. The pace is clamped to this ceiling.',
  quintetDefault: 'Starting pace before the engine has tracked your rate, in quintets: 30 = 6.0 BPM.',
  pacerAvgN: 'How many 1 Hz resonance readings are averaged to set the pacer target. More (toward 30) is smoother but laggier; fewer (toward 8) is snappier but jumpier. Keep it fairly smooth - the two-speed jump handles fast catch-up.',
  pacerSlewQuintet: 'The gentle glide rate when the pace is near target: 1 = +/-0.2 BPM per breath. Intentionally slow so the cue does not lurch. Big gaps are handled by the jump below, not by raising this.',
  pacerJumpThresholdBPM: 'Two-speed pacer: when your detected breathing rate is at least this far from the current pace AND stays that far for the Jump sustain breaths, the pace SNAPS straight to it instead of crawling. Lower jumps more eagerly; raise toward 2 if it over-reacts.',
  pacerJumpSustainBreaths: 'How many breaths in a row the gap must persist before the pace snaps - the wall against a transient bad reading causing a jump. 1 snaps almost immediately; 2-3 is safer. If catch-up feels too slow, lower this.',
  // Mode B fast amplitude
  ampWindowBreaths: 'Mode B averages HRV amplitude over this many recent breaths per dwell. ~2.5 balances responsiveness against noise.',
  // Mode B resonance search
  dwellBreaths: 'How many breaths Mode B holds each candidate rate before scoring it. Longer is more reliable but slows the search. 6 is a good balance.',
  dwellEstimateFraction: 'Fraction at the END of each dwell used for the amplitude estimate; the start is discarded as settling while the pace slews. 0.6 = last 60%.',
  probeStepInitBPM: 'Initial step size as Mode B brackets the resonance peak (0.4 BPM). Bigger is faster but coarser.',
  probeStepFloorBPM: 'Finest step the search resolves on the grid (0.2 BPM). The peak is then refined by a parabolic fit below this.',
  epsilonPctOfA: 'Hysteresis: how much higher one rate amplitude must be (as a fraction of A) to count as better, so noise does not flip the bracket. 5%.',
  searchLoBPM: 'Low end of the breathing-rate range Mode B searches (4.0 br/min). Narrow the range if you know roughly where your resonance is.',
  searchHiBPM: 'High end of the search range (7.5 br/min). Most adults resonate around 5.5-6 br/min.',
  respVerifyToleranceBPM: 'How close the accelerometer breathing rate must be to the paced rate for a dwell to count as followed (+/-0.8 BPM). The 45 s respiration window can only resolve rate to ~0.7-1.3 br/min, so values much below 0.8 reject real breathing. RAISE toward 1.0 if good dwells keep being rejected; lower only if sway is being accepted.',
  confirmProbeBPM: 'On a warm start from a saved resonance frequency, the half-range re-checked around it before re-locking.',
  maxUnverifiedDwells: 'Mode B aborts the search after this many dwells in a row it cannot verify against the accelerometer (you are moving or not following). RAISE if it gives up too readily; the hold-still hint appears as this climbs.',
  ditherAmpBPM: 'While holding lock, the pace is nudged by this much (sub-perceptual, 0.1 BPM) to keep tracking a drifting resonance.',
  ditherPeriodS: 'Period of the maintenance dither (180 s).',
  escGainBPM: 'How aggressively the held lock follows a drifting resonance. Higher tracks faster but can wander.',
  escMaxStepBPM: 'Per-cycle cap on how far the lock can move (0.05 BPM), so a noisy reading cannot yank it.',
  escMeanAlpha: 'High-pass on the amplitude objective so a uniform fade (fatigue) is not mistaken for a gradient. Lower = longer memory.',
  decayFastAlpha: 'Fast amplitude average for the sudden-loss detector. A sudden drop of the fast average below the slow one triggers a re-probe.',
  decaySlowAlpha: 'Slow amplitude average (the reference) for the sudden-loss detector.',
  reprobeDecayPct: 'If HRV amplitude falls at least this fraction below its slow average and stays there, Mode B re-probes around the lock. 0.15 = 15%.',
  reprobeSustainS: 'How long the amplitude drop must persist before a re-probe (120 s).',
  reprobeCapS: 'Minimum time between re-probes (180 s), so it cannot thrash.',
  // Mode B ACC respiration
  accSampleHz: 'Polar accelerometer sample rate. MUST match the rate the PMD stream is started at (50 Hz) - changing only this desyncs the timing.',
  respBandLo: 'Low edge of the band the breathing peak is searched for in the accelerometer (0.05 Hz = 3 br/min). The Sway floor further de-weights the very low end.',
  respBandHi: 'High edge of the accelerometer breathing band (0.4 Hz = 24 br/min). Excludes higher-frequency motion.',
  respWindowS: 'Trailing window the accelerometer respiration estimate runs over. 45 s gives a clean peak but lags rate changes slightly.',
  respConfidenceMin: 'Minimum spectral peakiness for the accelerometer breathing estimate to be trusted for verification. If Mode B keeps saying it cannot confirm your breathing even when you hold still, LOWER toward 0.3; raise if sway is being accepted.',
  respMinHz: 'Accelerometer peaks below this (~4.8 br/min) are treated as body sway and de-weighted, so the verifier locks onto real breathing (~6) instead of postural drift (~3.9). RAISE if a slow wobble still reads as breathing; LOWER for genuinely slow (under 5 br/min) breathers.',
  respNearPeakHz: 'The +/- window around the detected peak counted as the breath when scoring confidence. Wider tolerates a slightly spread peak (higher confidence); narrower is stricter.',
  respHarmonicExcludeMult: 'Confidence ignores spectral power above this multiple of the breathing rate, so the 2nd and 3rd harmonics of a non-sinusoidal breath do not drag the score down. 1.6 cuts just below the 2x harmonic.',
  // Mode C settle & find
  modeCWarmupS: 'Minimum time in the Follow warm-up before Mode C hands off to the resonance search, even if your breathing is already steady and confirmed. Gives you time to settle in. 120 s default.',
  modeCWarmupMaxS: 'Upper bound on the warm-up. Past this, Mode C transitions on confident breathing alone without waiting for the steadiness test, so a naturally variable breather is not trapped in warm-up. It NEVER relaxes the accelerometer-confirmation requirement.',
  modeCStabilityWindowS: 'Trailing window over which Mode C measures how steady your detected breathing rate is, and how consistently the accelerometer can see your breath. 30 s.',
  modeCStabilityBpmSd: 'How steady your breathing must be to hand off before the cap: the detected rate must vary no more than this (standard deviation, BPM) over the stability window. LOWER is stricter. 0.4 is tight, so many steady breathers still transition on the cap; raise toward 0.6 to 0.8 if it rarely passes the real gate.',
};

const FIELDS_BY_KEY: Record<string, CohNumericField> = (() => {
  const m: Record<string, CohNumericField> = {};
  for (const fld of COH_FIELDS) m[fld.key] = fld;
  return m;
})();

export function cohFieldFor(key: CoherenceTunableKey): CohNumericField {
  return FIELDS_BY_KEY[key];
}

/**
 * Does a `modes` list apply to the selected engine mode? Mode C runs the Mode A Follow warm-up
 * THEN the exact Mode B search, so it uses every Mode A and Mode B tunable plus its own warm-up
 * gate — a field/section tagged for modeA OR modeB OR modeC is therefore visible in Mode C.
 * Mode A and Mode B are unaffected (plain membership).
 */
function appliesTo(modes: ActiveEngineMode[], mode: EngineMode): boolean {
  if (mode === 'firmware') return false;
  if (mode === 'modeC') {
    return modes.includes('modeA') || modes.includes('modeB') || modes.includes('modeC');
  }
  return modes.includes(mode);
}

/** A tunable section is shown only when the selected mode is one it applies to. */
export function sectionVisible(section: CohSectionDef, mode: EngineMode): boolean {
  return appliesTo(section.modes, mode);
}

export function fieldsForSection(section: CohSectionId, mode: EngineMode): CohNumericField[] {
  return COH_FIELDS.filter((fld) => fld.section === section && appliesTo(fld.modes, mode));
}

/** Every tunable key (for validation / preset round-trips). */
export const ALL_COH_KEYS = COH_FIELDS.map((fld) => fld.key) as CoherenceTunableKey[];

export type { CoherenceTunables };
