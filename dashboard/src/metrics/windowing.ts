import {
  NARBIS_BEAT_FLAG_ARTIFACT,
  NARBIS_BEAT_FLAG_LOW_SQI,
  NARBIS_BEAT_FLAG_LOW_CONFIDENCE,
} from '../ble/parsers';
import type { NarbisBeatEvent } from '../ble/narbisDevice';

export type WindowType = 'rect' | 'hann' | 'hamming' | 'blackman';

export function applyWindow(samples: Float64Array, type: WindowType): Float64Array {
  const n = samples.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  if (type === 'rect') {
    out.set(samples);
    return out;
  }
  const denom = n > 1 ? n - 1 : 1;
  for (let i = 0; i < n; i++) {
    const x = (2 * Math.PI * i) / denom;
    let w: number;
    switch (type) {
      case 'hann':
        w = 0.5 * (1 - Math.cos(x));
        break;
      case 'hamming':
        w = 0.54 - 0.46 * Math.cos(x);
        break;
      case 'blackman':
        w = 0.42 - 0.5 * Math.cos(x) + 0.08 * Math.cos(2 * x);
        break;
    }
    out[i] = samples[i] * w;
  }
  return out;
}

const ARTIFACT_FLAGS =
  NARBIS_BEAT_FLAG_ARTIFACT | NARBIS_BEAT_FLAG_LOW_SQI | NARBIS_BEAT_FLAG_LOW_CONFIDENCE;

export function isArtifactBeat(beat: NarbisBeatEvent): boolean {
  return (beat.flags & ARTIFACT_FLAGS) !== 0;
}

export function filterArtifacts(beats: NarbisBeatEvent[]): NarbisBeatEvent[] {
  return beats.filter((b) => !isArtifactBeat(b));
}

export interface IbiWindow {
  times_s: Float64Array;
  ibis_ms: Float64Array;
}

export function extractIbiWindow(
  beats: NarbisBeatEvent[],
  windowSec: number,
  nowMs: number,
): IbiWindow {
  const cutoff = nowMs - windowSec * 1000;
  const filtered: NarbisBeatEvent[] = [];
  for (const b of beats) {
    if (b.timestamp >= cutoff && !isArtifactBeat(b) && b.ibi_ms > 0) {
      filtered.push(b);
    }
  }
  const n = filtered.length;
  const times_s = new Float64Array(n);
  const ibis_ms = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    times_s[i] = filtered[i].timestamp / 1000;
    ibis_ms[i] = filtered[i].ibi_ms;
  }
  return { times_s, ibis_ms };
}
