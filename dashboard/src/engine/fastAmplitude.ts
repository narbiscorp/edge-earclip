/*
 * fastAmplitude.ts — Mode B objective: peak-to-trough RR over the last few breaths.
 *
 * Faithful port of Swift `FastAmplitudeTracker`. Responds within a breath, unlike the
 * 64 s spectral power (which stays contaminated by the old rate after a step). This is
 * the ONLY objective the Mode B hill-climb consumes.
 */
import type { CoherenceTunables } from './tunables';
import type { IBIEntry } from './ibiIngest';

export class FastAmplitudeTracker {
  private readonly t: CoherenceTunables;

  constructor(t: CoherenceTunables) {
    this.t = t;
  }

  /** Returns mean per-breath (max−min) RR in ms, or null if insufficient data. */
  amplitude(beats: IBIEntry[], commandedBPM: number): number | null {
    if (commandedBPM <= 0 || beats.length === 0) return null;
    const last = beats[beats.length - 1];
    const breathS = 60.0 / commandedBPM;
    const cutoff = last.beatTimeS - breathS * this.t.ampWindowBreaths;
    const seg = beats.filter((b) => b.beatTimeS >= cutoff);
    if (seg.length < 4) return null;

    const amps: number[] = [];
    let chunkStart = seg[0].beatTimeS;
    let chunk: number[] = [];
    for (const e of seg) {
      if (e.beatTimeS - chunkStart > breathS) {
        if (chunk.length >= 2) amps.push(Math.max(...chunk) - Math.min(...chunk));
        chunk = [];
        chunkStart = e.beatTimeS;
      }
      chunk.push(e.rrMs);
    }
    if (chunk.length >= 2) amps.push(Math.max(...chunk) - Math.min(...chunk));
    if (amps.length === 0) return null;
    return amps.reduce((s, v) => s + v, 0) / amps.length;
  }
}
