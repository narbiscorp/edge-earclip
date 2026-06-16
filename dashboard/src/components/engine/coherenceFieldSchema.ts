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
  | 'lens'
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
  { id: 'lens', label: 'Lens program', modes: ['modeA', 'modeB'], defaultExpanded: false },
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
];

const FIELDS_BY_KEY: Record<string, CohNumericField> = (() => {
  const m: Record<string, CohNumericField> = {};
  for (const fld of COH_FIELDS) m[fld.key] = fld;
  return m;
})();

export function cohFieldFor(key: CoherenceTunableKey): CohNumericField {
  return FIELDS_BY_KEY[key];
}

/** A tunable section is shown only when the selected mode is one it applies to. */
export function sectionVisible(section: CohSectionDef, mode: EngineMode): boolean {
  return mode !== 'firmware' && section.modes.includes(mode);
}

export function fieldsForSection(section: CohSectionId, mode: EngineMode): CohNumericField[] {
  if (mode === 'firmware') return [];
  return COH_FIELDS.filter((fld) => fld.section === section && fld.modes.includes(mode));
}

/** Every tunable key (for validation / preset round-trips). */
export const ALL_COH_KEYS = COH_FIELDS.map((fld) => fld.key) as CoherenceTunableKey[];

export type { CoherenceTunables };
