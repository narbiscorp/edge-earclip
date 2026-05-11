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
  /** Absolute ms timestamps aligned with ibis_ms — needed by the firmware
   * coherence port which restricts to a trailing 64-second window using
   * wall-clock anchors (not just the Lomb-Scargle's relative time_s). */
  beat_ms: Float64Array;
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
  const beat_ms = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    times_s[i] = filtered[i].timestamp / 1000;
    ibis_ms[i] = filtered[i].ibi_ms;
    beat_ms[i] = filtered[i].timestamp;
  }
  return { times_s, ibis_ms, beat_ms };
}

/**
 * Polar H10 beats arrive as a notification carrying 0..N R-R intervals
 * with a single notify-time timestamp. To feed the same FFT pipeline the
 * earclip uses we explode each RR back to its own beat timestamp by
 * walking backwards from the notify time summing the RR values — the
 * same convention BeatChart and the aggregator use.
 */
export interface PolarBeatSample {
  timestamp: number;
  bpm: number;
  rr: number[];
}

export function extractH10IbiWindow(
  beats: PolarBeatSample[],
  windowSec: number,
  nowMs: number,
): IbiWindow {
  const cutoff = nowMs - windowSec * 1000;
  const pairs: Array<{ t: number; ibi: number }> = [];
  for (const p of beats) {
    if (!p.rr || p.rr.length === 0) continue;
    let totalRemaining = 0;
    for (let i = 0; i < p.rr.length; i++) totalRemaining += p.rr[i];
    let acc = 0;
    for (let i = 0; i < p.rr.length; i++) {
      const t = p.timestamp - (totalRemaining - acc);
      if (t >= cutoff && p.rr[i] > 0) {
        pairs.push({ t, ibi: p.rr[i] });
      }
      acc += p.rr[i];
    }
  }
  pairs.sort((a, b) => a.t - b.t);
  const n = pairs.length;
  const times_s = new Float64Array(n);
  const ibis_ms = new Float64Array(n);
  const beat_ms = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    times_s[i] = pairs[i].t / 1000;
    ibis_ms[i] = pairs[i].ibi;
    beat_ms[i] = pairs[i].t;
  }
  return { times_s, ibis_ms, beat_ms };
}
