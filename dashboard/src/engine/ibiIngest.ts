/*
 * ibiIngest.ts — beat buffer + bidirectional artifact gate (Lipponen–Tarvainen-inspired).
 *
 * Faithful port of Swift `IBIIngest`. Single-threaded (browser event loop), so the
 * NSLock machinery is dropped. The artifact decision lives in the shared `AdaptiveDRRGate`
 * (engine/adaptiveDrrGate.ts) so the engine and the H10 display/forward path can't diverge;
 * this class adds the time-stamped ring + windowing on top. Rejected beats are DROPPED.
 */
import type { CoherenceTunables } from './tunables';
import { AdaptiveDRRGate } from './adaptiveDrrGate';

export interface IBIEntry {
  beatTimeS: number;
  rrMs: number;
}

export class IBIIngest {
  private ring: IBIEntry[] = []; // gated (reject-only)
  private readonly gate: AdaptiveDRRGate;
  private readonly t: CoherenceTunables;

  constructor(t: CoherenceTunables) {
    this.t = t;
    this.gate = new AdaptiveDRRGate(t.dRRFloorMs, t.confThreshold);
  }

  /** Reset on source disconnect so a new session never inherits stale state. */
  reset(): void {
    this.ring = [];
    this.gate.reset();
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
    if (!this.gate.accept(rrMs, confidence)) return false;
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
}
