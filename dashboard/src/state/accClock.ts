/*
 * accClock.ts — per-sample timestamping for the Polar H10 accelerometer (ACC) stream.
 *
 * The H10 batches ~5 s of ACC per PMD notification and exposes only the LAST sample's time
 * (`acc.lastSampleMs`, derived from the device's own monotonic clock and anchored to wall-clock on
 * the first frame — jitter-free). We reconstruct per-sample times by walking back `stepMs` per
 * sample from there.
 *
 * The seam guard keeps the emitted stream STRICTLY MONOTONIC. Device frames can overlap by a few
 * samples (count vs. rate mismatch), and a backward seam makes the breathing-wave chart draw back
 * over itself (the "doubling-back" / time-skew artifact) and corrupts the engine's respiration
 * buffer. When a frame would begin at or before the previous frame's last emitted sample, we shift
 * the whole frame forward, preserving its intra-frame spacing.
 *
 * This replaced a free-running synthetic clock that advanced `+= n*stepMs` per batch and re-anchored
 * with a hard jump whenever it drifted >2 s from wall-clock — on bursty BLE delivery that re-anchor
 * could step BACKWARD, which is what produced the skew.
 */
export interface AccStamp {
  /** Timestamp (ms) of the packet's FIRST sample. */
  firstMs: number;
  /** Timestamp (ms) of the packet's LAST sample. */
  lastMs: number;
}

export function stampAccPacket(
  prevLastTs: number,
  lastSampleMs: number,
  n: number,
  stepMs: number,
): AccStamp {
  let firstMs = lastSampleMs - (n - 1) * stepMs;
  // Seam guard: a frame may never begin at/before the previous frame's last emitted sample.
  // prevLastTs === 0 means "no prior frame yet" (or post-reconnect re-anchor) — accept as-is.
  if (prevLastTs !== 0 && firstMs <= prevLastTs) firstMs = prevLastTs + stepMs;
  return { firstMs, lastMs: firstMs + (n - 1) * stepMs };
}
