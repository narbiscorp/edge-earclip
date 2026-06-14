/*
 * lensPrograms.ts — all lens output is a 0–100 duty (sent via opcode 0xA5).
 *
 * Faithful port of Swift `Program2Lens`, `heartbeatDuty`, `breatheFraction`, `breatheDuty`.
 */
import { type CoherenceTunables, gammaTable } from './tunables';

/** Program 2: EWMA-smoothed coherence with gamma difficulty. Consumes the squashed cohPercent. */
export class Program2Lens {
  private readonly t: CoherenceTunables;
  private smooth = 0;
  private entered = false;

  constructor(t: CoherenceTunables) {
    this.t = t;
  }

  onEnter(coh: number): void {
    this.smooth = coh;
    this.entered = true;
  } // snap on mode entry

  /** ~100 Hz tick → lens duty 0..100. `difficulty` indexes the gamma table. */
  duty(coh: number, brightness: number, difficulty: number): number {
    if (!this.entered) this.onEnter(coh);
    this.smooth += (coh - this.smooth) * this.t.ewmaAlpha;
    const s = Math.max(0, Math.min(100, this.smooth));
    const table = gammaTable(this.t);
    const g = table[Math.max(0, Math.min(table.length - 1, difficulty))];
    const clearPct = Math.pow(s / 100.0, g) * 100.0;
    const duty = (brightness * (100.0 - clearPct)) / 100.0;
    return Math.max(0, Math.min(100, duty));
  }
}

/** Program 0: 150 ms cosine flash on each accepted beat. */
export function heartbeatDuty(sinceBeatMs: number, brightness: number, t: CoherenceTunables): number {
  if (sinceBeatMs >= t.heartbeatPulseMs) return 0;
  const p = sinceBeatMs / t.heartbeatPulseMs;
  const env = (1 + Math.cos(Math.PI * p)) / 2;
  return Math.max(0, Math.min(100, (env * t.heartbeatPeakDuty * brightness) / 100.0));
}

/** Programs 1/3: breathing pacer fraction (0→1→0 over a cycle). */
export function breatheFraction(elapsedMs: number, cycleMs: number, t: CoherenceTunables): number {
  const inhale = Math.floor((cycleMs * t.breatheInhalePct) / 100);
  if (elapsedMs < inhale) {
    const p = elapsedMs / Math.max(1, inhale);
    return (1 - Math.cos(Math.PI * p)) / 2;
  }
  const p = (elapsedMs - inhale) / Math.max(1, cycleMs - inhale);
  return (1 + Math.cos(Math.PI * p)) / 2;
}

/** Programs 1/3: breathing fraction × coherence scale, with the duty floor so the cue stays visible. */
export function breatheDuty(
  frac: number,
  cohPercent: number,
  brightness: number,
  t: CoherenceTunables,
): number {
  const coh = Math.max(0, Math.min(100, cohPercent));
  const cohScale = 1.0 - (coh / 100.0) * (1.0 - t.dutyFloorPct / 100.0); // 1.0 → floor as coh 0→100
  return Math.max(0, Math.min(100, frac * cohScale * brightness));
}
