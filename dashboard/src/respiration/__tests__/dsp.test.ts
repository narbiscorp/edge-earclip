import { describe, expect, it } from 'vitest';
import {
  decimateLTTB,
  ewmaZeroPhase,
  medianFilter,
  movingAverage,
  pchipResample,
  savitzkyGolay,
  shapeSeries,
  DEFAULT_SHAPING,
} from '../dsp';

describe('movingAverage', () => {
  it('returns the input unchanged for n <= 1', () => {
    expect(movingAverage([1, 2, 3], 1)).toEqual([1, 2, 3]);
    expect(movingAverage([1, 2, 3], 0)).toEqual([1, 2, 3]);
  });

  it('preserves length and uses partial windows at the edges', () => {
    const out = movingAverage([0, 0, 3, 0, 0], 3);
    expect(out).toHaveLength(5);
    expect(out[0]).toBeCloseTo(0, 10); // mean of [0,0]
    expect(out[2]).toBeCloseTo(1, 10); // mean of [0,3,0]
  });

  it('leaves a constant signal exactly constant', () => {
    const out = movingAverage([5, 5, 5, 5, 5, 5, 5], 5);
    for (const v of out) expect(v).toBeCloseTo(5, 10);
  });
});

describe('medianFilter', () => {
  it('removes an isolated spike entirely', () => {
    const out = medianFilter([10, 10, 900, 10, 10], 3);
    expect(out[2]).toBe(10);
  });

  it('does not smear the spike into its neighbours, unlike an average', () => {
    const sig = [10, 10, 900, 10, 10];
    const med = medianFilter(sig, 3);
    const avg = movingAverage(sig, 3);
    expect(med[1]).toBe(10);
    expect(avg[1]).toBeGreaterThan(300); // the average drags the neighbour up
  });
});

describe('ewmaZeroPhase', () => {
  it('does not shift a peak in time (the whole reason for the reverse pass)', () => {
    // Symmetric triangular pulse — a filter with group delay moves the apex.
    const sig: number[] = [];
    for (let i = 0; i < 41; i++) sig.push(20 - Math.abs(i - 20));
    const out = ewmaZeroPhase(sig, 0.3);
    let peak = 0;
    for (let i = 1; i < out.length; i++) if (out[i] > out[peak]) peak = i;
    expect(peak).toBe(20);
  });

  it('holds a constant signal constant', () => {
    const out = ewmaZeroPhase(new Array(20).fill(7), 0.25);
    for (const v of out) expect(v).toBeCloseTo(7, 8);
  });
});

describe('savitzkyGolay', () => {
  it('reproduces a quadratic exactly when order >= 2', () => {
    // The defining property: a polynomial of degree <= order passes through
    // untouched. If the kernel is wrong this fails immediately.
    const sig = Array.from({ length: 31 }, (_, i) => 3 * i * i - 5 * i + 2);
    const out = savitzkyGolay(sig, 9, 2);
    for (let i = 0; i < sig.length; i++) expect(out[i]).toBeCloseTo(sig[i], 6);
  });

  it('reproduces a straight line exactly', () => {
    const sig = Array.from({ length: 25 }, (_, i) => 2 * i + 1);
    const out = savitzkyGolay(sig, 11, 2);
    for (let i = 0; i < sig.length; i++) expect(out[i]).toBeCloseTo(sig[i], 6);
  });

  it('preserves peak height far better than a moving average', () => {
    const sig = Array.from({ length: 61 }, (_, i) => Math.exp(-((i - 30) ** 2) / 18));
    const sg = savitzkyGolay(sig, 11, 2);
    const ma = movingAverage(sig, 11);
    expect(sg[30]).toBeGreaterThan(0.92);
    expect(ma[30]).toBeLessThan(0.85);
    expect(sg[30]).toBeGreaterThan(ma[30]);
  });

  it('reduces white noise on a flat signal', () => {
    let seed = 12345;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff - 0.5;
    };
    const sig = Array.from({ length: 400 }, () => rnd());
    const out = savitzkyGolay(sig, 15, 2);
    const varOf = (a: number[]): number => {
      const m = a.reduce((s, v) => s + v, 0) / a.length;
      return a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length;
    };
    expect(varOf(out)).toBeLessThan(varOf(sig) * 0.5);
  });
});

describe('pchipResample', () => {
  it('passes through the original knots', () => {
    const x = [0, 1000, 2000, 3000];
    const y = [800, 900, 850, 870];
    const r = pchipResample(x, y, 1); // 1 Hz grid lands exactly on the knots
    for (let i = 0; i < r.x.length; i++) {
      const k = x.indexOf(r.x[i]);
      if (k >= 0) expect(r.y[i]).toBeCloseTo(y[k], 6);
    }
  });

  it('never overshoots the data range — the reason for the monotone limiter', () => {
    // A plain cubic spline rings on this step and invents values outside [800, 1200].
    const x = [0, 500, 1000, 1500, 2000, 2500, 3000];
    const y = [800, 800, 800, 1200, 1200, 1200, 1200];
    const r = pchipResample(x, y, 20);
    const lo = Math.min(...y);
    const hi = Math.max(...y);
    for (const v of r.y) {
      expect(v).toBeGreaterThanOrEqual(lo - 1e-9);
      expect(v).toBeLessThanOrEqual(hi + 1e-9);
    }
  });

  it('stays monotone on monotone input', () => {
    const x = [0, 100, 200, 300, 400, 500];
    const y = [1, 2, 5, 6, 20, 21];
    const r = pchipResample(x, y, 50);
    for (let i = 1; i < r.y.length; i++) {
      expect(r.y[i]).toBeGreaterThanOrEqual(r.y[i - 1] - 1e-9);
    }
  });

  it('produces a uniform grid at the requested rate', () => {
    const x = [0, 337, 1201, 1999, 3050];
    const y = [1, 2, 3, 4, 5];
    const r = pchipResample(x, y, 4); // 250 ms spacing
    for (let i = 1; i < r.x.length; i++) expect(r.x[i] - r.x[i - 1]).toBeCloseTo(250, 6);
  });

  it('bails out rather than lying when x is not sorted', () => {
    const x = [0, 500, 300];
    const y = [1, 2, 3];
    const r = pchipResample(x, y, 10);
    expect(r.x).toEqual(x);
    expect(r.y).toEqual(y);
  });
});

describe('decimateLTTB', () => {
  it('is a no-op below the threshold', () => {
    const x = [1, 2, 3];
    const y = [4, 5, 6];
    const r = decimateLTTB(x, y, 100);
    expect(r.x).toEqual(x);
    expect(r.y).toEqual(y);
  });

  it('respects the threshold and keeps both endpoints', () => {
    const x = Array.from({ length: 5000 }, (_, i) => i);
    const y = x.map((v) => Math.sin(v / 40));
    const r = decimateLTTB(x, y, 500);
    expect(r.x).toHaveLength(500);
    expect(r.x[0]).toBe(0);
    expect(r.x[r.x.length - 1]).toBe(4999);
  });

  it('keeps a narrow spike that plain striding would drop', () => {
    const x = Array.from({ length: 4000 }, (_, i) => i);
    const y = x.map(() => 0);
    y[1234] = 500; // one-sample spike, invisible to every 10th-sample stride
    const r = decimateLTTB(x, y, 200);
    expect(Math.max(...r.y)).toBe(500);
  });
});

describe('shapeSeries', () => {
  it('handles an empty series', () => {
    expect(shapeSeries([], [], DEFAULT_SHAPING)).toEqual({ x: [], y: [] });
  });

  it('applies resample then filter then decimate, in that order', () => {
    const x = Array.from({ length: 200 }, (_, i) => i * 1000);
    const y = x.map((_, i) => (i % 2 === 0 ? 0 : 10));
    const out = shapeSeries(x, y, {
      ...DEFAULT_SHAPING,
      resampleHz: 1,
      filter: 'movavg',
      filterN: 5,
      maxPoints: 50,
    });
    expect(out.x.length).toBeLessThanOrEqual(50);
    // The alternating signal averages toward its mean of 5 in the interior.
    const mid = out.y[Math.floor(out.y.length / 2)];
    expect(mid).toBeGreaterThan(2);
    expect(mid).toBeLessThan(8);
  });

  it('leaves data untouched when nothing is configured', () => {
    const x = [0, 1000, 2000];
    const y = [700, 800, 900];
    const out = shapeSeries(x, y, DEFAULT_SHAPING);
    expect(out.x).toEqual(x);
    expect(out.y).toEqual(y);
  });
});
