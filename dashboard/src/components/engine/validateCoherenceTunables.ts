/*
 * validateCoherenceTunables.ts — float-aware range + cross-field validation.
 *
 * Unlike the firmware validateConfig (which enforces integers + wire ranges), coherence
 * tunables are floats; we only check finiteness, the schema [min,max], and a few ordering
 * invariants the engine relies on.
 */
import type { CoherenceTunableKey, CoherenceTunables } from '../../engine/tunables';
import { COH_FIELDS } from './coherenceFieldSchema';

export type CohValidationErrors = Partial<Record<CoherenceTunableKey, string>>;

export function validateCoherenceTunables(t: CoherenceTunables): CohValidationErrors {
  const errors: CohValidationErrors = {};

  for (const f of COH_FIELDS) {
    const v = t[f.key];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      errors[f.key] = 'must be a number';
      continue;
    }
    if (v < f.min || v > f.max) {
      errors[f.key] = `out of range (${f.min}–${f.max})`;
    }
  }

  // Ordering invariants the engine relies on.
  const lt = (lo: CoherenceTunableKey, hi: CoherenceTunableKey, msg: string) => {
    if (errors[lo] || errors[hi]) return;
    if (t[lo] >= t[hi]) {
      errors[lo] = msg;
    }
  };
  lt('lsFreqLo', 'lsFreqHi', 'must be < analysis band high');
  lt('peakSearchLo', 'peakSearchHi', 'must be < CR peak search high');
  lt('lfReadbackLo', 'lfReadbackHi', 'must be < pacer readback high');
  lt('lfBandLo', 'lfBandHi', 'must be < LF band high');
  lt('hfBandLo', 'hfBandHi', 'must be < HF band high');
  lt('quintetMin', 'quintetMax', 'must be < pacer ceiling');
  lt('searchLoBPM', 'searchHiBPM', 'must be < search band high');
  lt('respBandLo', 'respBandHi', 'must be < resp band high');

  return errors;
}

export function isCohValid(errors: CohValidationErrors): boolean {
  return Object.keys(errors).length === 0;
}
