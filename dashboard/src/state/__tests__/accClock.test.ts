import { describe, it, expect } from 'vitest';
import { stampAccPacket } from '../accClock';

/** Emulate the store's accReceived loop over a sequence of frames, returning every emitted
 * per-sample timestamp in order (this is exactly what accMagBuffer is fed). */
function emit(frames: Array<{ lastSampleMs: number; n: number }>, stepMs: number): number[] {
  let prevLast = 0;
  const out: number[] = [];
  for (const f of frames) {
    const { firstMs, lastMs } = stampAccPacket(prevLast, f.lastSampleMs, f.n, stepMs);
    for (let i = 0; i < f.n; i++) out.push(firstMs + i * stepMs);
    prevLast = lastMs;
  }
  return out;
}

const strictlyIncreasing = (xs: number[]): boolean => xs.every((x, i) => i === 0 || x > xs[i - 1]);

describe('stampAccPacket', () => {
  it('first frame anchors so the last sample lands on lastSampleMs', () => {
    const { firstMs, lastMs } = stampAccPacket(0, 5000, 250, 20);
    expect(lastMs).toBe(5000);
    expect(firstMs).toBe(5000 - 249 * 20);
  });

  it('contiguous frames track the device clock exactly (no clamp)', () => {
    // Each frame is 250 samples @ 50 Hz = 5000 ms; device advances 5000 ms/frame.
    const frames = [5000, 10000, 15000, 20000].map((lastSampleMs) => ({ lastSampleMs, n: 250 }));
    let prevLast = 0;
    for (const f of frames) {
      const s = stampAccPacket(prevLast, f.lastSampleMs, f.n, 20);
      expect(s.lastMs).toBe(f.lastSampleMs); // not shifted — naive seam already clears prevLast
      prevLast = s.lastMs;
    }
  });

  it('keeps the stream strictly monotonic when device frames overlap (the skew fix)', () => {
    // Frame 2 overlaps frame 1: device advanced only 4800 ms for a 5000 ms (250-sample) frame.
    const out = emit(
      [
        { lastSampleMs: 5000, n: 250 },
        { lastSampleMs: 9800, n: 250 }, // overlap → naive start (4820) is before prev last (5000)
        { lastSampleMs: 14800, n: 250 },
      ],
      20,
    );
    expect(strictlyIncreasing(out)).toBe(true);
  });

  it('stays monotonic under a bursty back-to-back delivery with barely-advancing device time', () => {
    // Three frames whose device timestamps barely move (BLE delivered them in a burst).
    const out = emit(
      [
        { lastSampleMs: 5000, n: 250 },
        { lastSampleMs: 5040, n: 250 },
        { lastSampleMs: 5080, n: 250 },
        { lastSampleMs: 10100, n: 250 },
      ],
      20,
    );
    expect(strictlyIncreasing(out)).toBe(true);
  });

  it('handles a single-sample packet and a post-reconnect forward jump', () => {
    // n=1 packet, then a large forward jump (prevLast reset to 0 emulates reconnect re-anchor).
    expect(stampAccPacket(5000, 5020, 1, 20)).toEqual({ firstMs: 5020, lastMs: 5020 });
    const reanchor = stampAccPacket(0, 999000, 250, 20); // prevLast 0 → accept device time as-is
    expect(reanchor.lastMs).toBe(999000);
  });
});
