/*
 * ptt.ts — pulse arrival time: from the heart's R-peak (H10 raw ECG, metrics/ecgRpeak.ts) to the
 * pulse reaching the earclip (its beat time, sub-sample, from the firmware's detector).
 *
 * Strictly this is PAT, not PTT: it includes the pre-ejection period, the delay between the
 * ECG's R and the aortic valve opening. It is the standard ECG + one-PPG-site measure and moves
 * with PTT (blood pressure, vascular tone), ~150-400 ms. The baseline depends on the site
 * (a finger reads longer than an ear).
 *
 * Clocks. Both devices stamp their samples on their own clocks; the dashboard pins each to the
 * PC's on the FIRST packet it gets, which can be hundreds of ms old (2026-10-14: the earclip
 * ~450 ms late, the H10's heart-rate beats ~1.1 s). ClockCorrector moves a device's mapped
 * times onto the fastest packet seen in the last minute (the lower envelope of arrival − mapped
 * time), which also follows slow drift. What remains is the difference between the two links'
 * fastest packets, a few ms, constant: it shifts the baseline, not the changes.
 */

/** Sliding lower envelope of (arrival − mapped) per device. */
export class ClockCorrector {
  private q: Array<{ at: number; d: number }> = []; // increasing d: a monotonic deque
  constructor(private readonly windowMs = 60_000) {}

  /** A packet whose newest sample maps to `mappedMs` arrived at `arrivalMs`. */
  observe(mappedMs: number, arrivalMs: number): void {
    const d = arrivalMs - mappedMs;
    while (this.q.length && this.q[this.q.length - 1].d >= d) this.q.pop();
    this.q.push({ at: arrivalMs, d });
    while (this.q.length && this.q[0].at < arrivalMs - this.windowMs) this.q.shift();
  }

  /** Add to a mapped time to put it on the fastest packet's timing; null before any packet. */
  offset(): number | null {
    return this.q.length ? this.q[0].d : null;
  }

  reset(): void {
    this.q = [];
  }
}

export const PAT_RANGE_MS: [number, number] = [80, 600];

/** PAT of a beat at time t: from the latest R-peak at least PAT_RANGE_MS[0] earlier (R times
 * ascending). null when none lies in PAT_RANGE_MS. */
export function patFor(t: number, rTimes: ReadonlyArray<number>, range = PAT_RANGE_MS): number | null {
  let lo = 0, hi = rTimes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rTimes[mid] <= t - range[0]) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return null;
  const pat = t - rTimes[lo - 1];
  return pat <= range[1] ? pat : null;
}

export interface PatSample {
  /** Earclip beat time (ms, corrected clock). */
  t: number;
  pat: number;
  /** The earclip beat was found during light motion (proto 1.4 MOTION flag). */
  motion: boolean;
}

/** Median of the last n values (n odd or even). */
export function recentMedian(values: ReadonlyArray<number>, n: number): number | null {
  const s = values.slice(-n).sort((a, b) => a - b);
  if (s.length === 0) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
