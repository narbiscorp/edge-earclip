import { describe, it, expect } from 'vitest';
import { extractIbiWindow, filterArtifacts, isArtifactBeat } from '../windowing';
import {
  NARBIS_BEAT_FLAG_ARTIFACT, NARBIS_BEAT_FLAG_LOW_CONFIDENCE, NARBIS_BEAT_FLAG_LOW_SQI,
} from '../../ble/parsers';
import {
  IBIF_AGC_SETTLING, IBIF_ARTIFACT, IBIF_GATED, IBIF_INTERPOLATED,
} from '../../ble/v2/protocol';
import type { NarbisBeatEvent } from '../../ble/narbisDevice';

function beat(timestamp: number, ibi_ms: number, flags = 0): NarbisBeatEvent {
  return { bpm: Math.round(60000 / ibi_ms), ibi_ms, confidence: 90, flags, sqi: null, timestamp };
}

describe('which earclip beats HRV skips', () => {
  it('skips V2 ARTIFACT beats (proto 1.3) the same as GATED / AGC_SETTLING ones', () => {
    expect(isArtifactBeat(beat(0, 800, IBIF_ARTIFACT))).toBe(true);
    expect(isArtifactBeat(beat(0, 800, IBIF_INTERPOLATED | IBIF_ARTIFACT))).toBe(true);
    expect(isArtifactBeat(beat(0, 800, IBIF_GATED))).toBe(true);
    expect(isArtifactBeat(beat(0, 800, IBIF_AGC_SETTLING))).toBe(true);
  });

  it('keeps INTERPOLATED-only beats: sub-sample peak timing, set on nearly every good beat', () => {
    expect(isArtifactBeat(beat(0, 800, IBIF_INTERPOLATED))).toBe(false);
    expect(isArtifactBeat(beat(0, 800, 0))).toBe(false);
  });

  it('still reads v1 flags as before', () => {
    for (const f of [NARBIS_BEAT_FLAG_ARTIFACT, NARBIS_BEAT_FLAG_LOW_SQI, NARBIS_BEAT_FLAG_LOW_CONFIDENCE]) {
      expect(isArtifactBeat(beat(0, 800, f))).toBe(true);
    }
  });

  it('leaves ARTIFACT beats out of the HRV window (and filterArtifacts)', () => {
    const now = 100_000;
    const beats = [
      beat(now - 3000, 800), beat(now - 2200, 810, IBIF_INTERPOLATED),
      beat(now - 700, 1510, IBIF_INTERPOLATED | IBIF_ARTIFACT), beat(now - 0, 790),
    ];
    const w = extractIbiWindow(beats, 60, now);
    expect(Array.from(w.ibis_ms)).toEqual([800, 810, 790]);
    expect(filterArtifacts(beats)).toHaveLength(3);
  });
});
