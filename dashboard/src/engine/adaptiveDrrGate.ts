/*
 * adaptiveDrrGate.ts — the SINGLE source of truth for IBI artifact rejection.
 *
 * Adaptive bidirectional successive-difference (dRR) gate — the Lipponen–Tarvainen
 * basis. A beat is rejected only when its dRR jumps beyond `max(5.2 · QD, floorMs)`
 * of the signal's OWN recent variability, so a legitimate large RSA swing passes
 * while a missed-beat double (+) or ectopic short (−) is caught. There is NO fixed
 * ±band — that clips real RSA at high coherence (the bug this module exists to kill).
 *
 * Stateful + chronological: feed beats oldest-first. Rejected beats are DROPPED;
 * the caller never interpolates a replacement value.
 *
 * Faithful port of Swift `IBIIngest.push`. Used by BOTH the engine (ibiIngest.ts)
 * and the H10 display/forward path (store.ts) so the two can never diverge again.
 */

const RR_MIN_MS = 250; // 240 bpm — below this is a detection glitch, not a heartbeat
const RR_MAX_MS = 2500; // 24 bpm — above this is a dropped/missed beat
const QD_SCALE = 5.2; // Lipponen–Tarvainen scaling on the quartile deviation
const WARMUP = 8; // dRR samples required before the adaptive gate engages
const HISTORY = 64; // trailing dRR window the quartile-deviation estimate runs over

export class AdaptiveDRRGate {
  private recentDRR: number[] = [];
  private lastRR = 0;

  /**
   * @param floorMs       floor on the adaptive threshold so it can't fail OPEN at
   *                      near-zero variability (calm regular breathing → QD→0).
   * @param confThreshold reject beats whose confidence is below this (0–100).
   */
  constructor(
    private readonly floorMs: number,
    private readonly confThreshold = 0,
  ) {}

  /** Forget all history (call on source disconnect / strap swap). */
  reset(): void {
    this.recentDRR = [];
    this.lastRR = 0;
  }

  /** True if the beat is accepted (and advances state). `confidence` is 0–100. */
  accept(rrMs: number, confidence = 100): boolean {
    if (confidence < this.confThreshold || rrMs <= RR_MIN_MS || rrMs >= RR_MAX_MS) return false;
    if (this.lastRR === 0) this.lastRR = rrMs;

    const drr = rrMs - this.lastRR;
    if (this.recentDRR.length >= WARMUP) {
      const thr = Math.max(QD_SCALE * quartileDeviation(this.recentDRR), this.floorMs);
      if (Math.abs(drr) > thr) {
        // Reject WITHOUT advancing lastRR — measuring the next dRR from an artifact
        // value would cascade a false rejection onto the next (good) beat.
        return false;
      }
    }

    this.recentDRR.push(drr);
    if (this.recentDRR.length > HISTORY) this.recentDRR.shift();
    this.lastRR = rrMs;
    return true;
  }
}

function quartileDeviation(x: number[]): number {
  const s = x.map((v) => Math.abs(v)).sort((a, b) => a - b);
  return s[Math.floor((3 * s.length) / 4)] - s[Math.floor(s.length / 4)];
}
