/*
 * ibiIngest.ts — beat buffer + bidirectional artifact gate (Lipponen–Tarvainen-inspired).
 *
 * Faithful port of Swift `IBIIngest`. Single-threaded (browser event loop), so the
 * NSLock machinery is dropped. The bidirectional dRR gate catches missed-beat doubles
 * (+) AND extra/ectopic shorts (−); rejected beats are DROPPED, not interpolated.
 */
import type { CoherenceTunables } from './tunables';

export interface IBIEntry {
  beatTimeS: number;
  rrMs: number;
}

export class IBIIngest {
  private ring: IBIEntry[] = []; // gated (reject-only)
  private recentDRR: number[] = [];
  private lastRR = 0.0;
  private readonly t: CoherenceTunables;

  constructor(t: CoherenceTunables) {
    this.t = t;
  }

  /** Reset on source disconnect so a new session never inherits stale state. */
  reset(): void {
    this.ring = [];
    this.recentDRR = [];
    this.lastRR = 0;
  }

  /**
   * Polar H10 path. RR arrives in 1/1024 s units — convert to ms here. A single BLE
   * notification can carry MULTIPLE RR intervals; we reconstruct each beat's end-time
   * from the batch (newest lands exactly at `nowS`, each earlier beat precedes its
   * successor by that successor's RR). Returns the per-batch accept/reject tally so the
   * engine can derive Mode B's cycle-clean signal from its own gate.
   *
   * Assumes the notification's RR intervals are OLDEST-FIRST (BLE HRM spec order).
   */
  pushH10(
    rr1024: number[],
    confidence: number,
    nowS: number,
  ): { accepted: number; rejected: number } {
    const rrMs = rr1024.map((r) => (r * 1000.0) / 1024.0);
    let beatEnd = nowS - rrMs.reduce((s, v) => s + v, 0) / 1000.0; // batch start
    let acc = 0;
    let rej = 0;
    for (const r of rrMs) {
      beatEnd += r / 1000.0;
      if (this.push(r, confidence, beatEnd)) acc += 1;
      else rej += 1;
    }
    return { accepted: acc, rejected: rej };
  }

  /** Generic push. `confidence` 0–100; `nowS` monotonic seconds. Returns true if accepted. */
  push(rrMs: number, confidence: number, nowS: number): boolean {
    if (confidence < this.t.confThreshold || rrMs <= 250 || rrMs >= 2500) return false; // 24–240 bpm
    if (this.lastRR === 0) this.lastRR = rrMs;

    // Adaptive successive-difference (dRR) gate — the actual Lipponen–Tarvainen basis.
    // No fixed ±band (that clips legitimate large RSA swings). The adaptive threshold
    // widens with the signal's own variability; the floor stops it failing OPEN when
    // recent variability ≈ 0 (calm regular breathing → QD→0).
    const drr = rrMs - this.lastRR;
    if (this.recentDRR.length >= 8) {
      const thr = Math.max(5.2 * this.quartileDeviation(this.recentDRR), this.t.dRRFloorMs);
      if (Math.abs(drr) > thr) {
        // Reject WITHOUT advancing lastRR — measuring the next dRR from an artifact
        // value would cascade a false rejection onto the next (good) beat.
        return false;
      }
    }

    this.recentDRR.push(drr);
    if (this.recentDRR.length > 64) this.recentDRR.shift();
    this.lastRR = rrMs;
    this.ring.push({ beatTimeS: nowS, rrMs });
    if (this.ring.length > this.t.ringSize) this.ring.shift();
    return true;
  }

  /** Copy of the beats within the last `seconds`. */
  window(seconds: number): IBIEntry[] {
    if (this.ring.length === 0) return [];
    const last = this.ring[this.ring.length - 1];
    const cutoff = last.beatTimeS - seconds;
    return this.ring.filter((e) => e.beatTimeS >= cutoff);
  }

  private quartileDeviation(x: number[]): number {
    const s = x.map((v) => Math.abs(v)).sort((a, b) => a - b);
    return s[Math.floor((3 * s.length) / 4)] - s[Math.floor(s.length / 4)];
  }
}
