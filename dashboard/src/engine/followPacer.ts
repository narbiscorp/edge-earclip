/*
 * followPacer.ts — Mode A "Follow" pacer (slew limiter on the LS resonance readback).
 *
 * Faithful port of Swift `FollowPacer`. Quintet = BPM × 5 (native 0.2-BPM resolution).
 * Single-threaded, so the NSLock is dropped.
 */
import type { CoherenceTunables } from './tunables';

export class FollowPacer {
  private readonly t: CoherenceTunables;
  private ring: number[] = []; // mHz
  private _currentQuintet: number;

  constructor(t: CoherenceTunables) {
    this.t = t;
    this._currentQuintet = t.quintetDefault;
  }

  /** Current pace (quintet = BPM × 5). */
  get currentQuintet(): number {
    return this._currentQuintet;
  }

  /** Push once per LS compute (1 Hz). Only in-range values (3–12 BPM = 50–200 mHz). */
  push(respMhz: number): void {
    if (respMhz < 50 || respMhz > 200) return;
    this.ring.push(respMhz);
    if (this.ring.length > this.t.pacerAvgN) this.ring.shift();
  }

  private targetQuintet(): number {
    if (this.ring.length === 0) return 0;
    const sum = this.ring.reduce((s, v) => s + v, 0);
    const avg = Math.floor(sum / this.ring.length); // mHz
    const q = Math.floor((avg * 3 + 5) / 10); // round(BPM/0.2)
    return Math.min(this.t.quintetMax, Math.max(this.t.quintetMin, q));
  }

  /** Call at each breathing-cycle boundary. Slew-limited ±0.2 BPM. Returns cycle ms. */
  latch(): number {
    const target = this.targetQuintet();
    if (target > 0) {
      let prev = this._currentQuintet;
      if (prev === 0) prev = target;
      const delta = Math.max(-this.t.pacerSlewQuintet, Math.min(this.t.pacerSlewQuintet, target - prev));
      const nq = Math.min(this.t.quintetMax, Math.max(this.t.quintetMin, prev + delta));
      this._currentQuintet = nq;
    }
    return Math.floor(300_000 / this._currentQuintet); // 60000 / (quintet/5)
  }

  /** External set, e.g. Mode B handing back a commanded rate to slew toward. */
  setTargetBPM(bpm: number): void {
    const mhz = Math.round(Math.max(50, Math.min(200, (bpm * 1000.0) / 60.0)));
    this.ring = [mhz]; // collapse to the new target
  }

  /** Snap the CURRENT pace to `bpm` with NO slew — used at Mode B entry so the first dwell starts on-rate. */
  snapToBPM(bpm: number): void {
    const mhz = Math.round(Math.max(50, Math.min(200, (bpm * 1000.0) / 60.0)));
    const q = Math.floor((mhz * 3 + 5) / 10);
    this._currentQuintet = Math.min(this.t.quintetMax, Math.max(this.t.quintetMin, q));
    this.ring = [mhz];
  }
}
