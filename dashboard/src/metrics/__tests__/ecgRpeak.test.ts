import { describe, it, expect } from 'vitest';
import { RPeakDetector } from '../ecgRpeak';

const FS = 130;

/** Synthetic lead: P, Q, R, S, T as Gaussians around each beat time, baseline wander, noise. */
function ecg(beats: number[], seconds: number, opts: { sign?: number; wander?: number; noise?: number } = {}) {
  const { sign = 1, wander = 300, noise = 15 } = opts;
  let s = 12345;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32 - 0.5);
  const g = (t: number, mu: number, sd: number) => Math.exp(-0.5 * ((t - mu) / sd) ** 2);
  const out: Array<{ t: number; v: number }> = [];
  for (let i = 0; i < seconds * FS; i++) {
    const t = (i * 1000) / FS + 0.37; // samples not aligned to the beats
    let v = wander * Math.sin((2 * Math.PI * 0.3 * t) / 1000) + noise * rnd();
    for (const b of beats) {
      if (Math.abs(t - b) > 500) continue;
      v += sign * (120 * g(t, b - 160, 25) - 150 * g(t, b - 25, 8) + 1100 * g(t, b, 9) - 300 * g(t, b + 25, 9) + 260 * g(t, b + 280, 45));
    }
    out.push({ t, v });
  }
  return out;
}

function beatsFrom(rr: (k: number) => number, seconds: number): number[] {
  const b: number[] = [];
  for (let t = 600, k = 0; t < seconds * 1000 - 300; t += rr(k++)) b.push(t);
  return b;
}

function detect(samples: Array<{ t: number; v: number }>) {
  const d = new RPeakDetector();
  return samples.flatMap((x) => d.push(x.t, x.v, FS));
}

describe('R-peaks from the H10 raw ECG', () => {
  it('finds every R after its 1 s warm-up, to within 2 ms, through baseline wander', () => {
    const truth = beatsFrom((k) => 850 + 120 * Math.sin(k / 3), 60);
    const found = detect(ecg(truth, 60));
    const expected = truth.filter((t) => t > 1300);
    expect(found.length).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) expect(Math.abs(found[i].t - expected[i])).toBeLessThan(2);
    expect(found[3].rr).not.toBeNull();
    expect(Math.abs((found[3].rr as number) - (expected[3] - expected[2]))).toBeLessThan(3);
  });

  it('handles a lead whose QRS points down', () => {
    const truth = beatsFrom(() => 1000, 30);
    const found = detect(ecg(truth, 30, { sign: -1 }));
    const expected = truth.filter((t) => t > 1300);
    expect(found.length).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) expect(Math.abs(found[i].t - expected[i])).toBeLessThan(2);
    expect(found[0].amp).toBeLessThan(0);
  });

  it('does not count the T wave at a fast heart rate', () => {
    const truth = beatsFrom(() => 450, 30); // 133 bpm
    const found = detect(ecg(truth, 30)).filter((p) => p.t > 1300);
    const expected = truth.filter((t) => t > 1300);
    expect(found.length).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) expect(Math.abs(found[i].t - expected[i])).toBeLessThan(2);
  });

  it('starts over after a gap in the samples', () => {
    const truth = beatsFrom(() => 900, 20);
    const s = ecg(truth, 20);
    const gapped = [...s.slice(0, 5 * FS), ...s.slice(10 * FS).map((x) => ({ ...x }))];
    const found = detect(gapped);
    const afterGap = found.filter((p) => p.t > 10_000);
    expect(afterGap[0].t).toBeGreaterThan(11_000); // warm-up again
    expect(afterGap[0].rr).toBeNull();
  });
});
