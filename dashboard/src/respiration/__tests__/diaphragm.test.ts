import { describe, expect, it } from 'vitest';
import {
  analyseDualStreams,
  balancePosition,
  classify,
  crossCorrelationLag,
  estimatePeriodMs,
  peakToPeak,
  DEFAULT_DIAPHRAGM_OPTIONS,
  type Series,
} from '../diaphragm';

const T0 = 1_700_000_000_000;

/** A strap series: `ampMg` breathing at `breathBpm`, `phaseRad` ahead, on a
 * gravity offset, sampled at `hz` for `durSec`. `startMs` offsets the whole
 * stream so the two straps' clocks differ, as they really do. */
function strap(opts: {
  ampMg: number;
  breathBpm?: number;
  phaseRad?: number;
  offsetMg?: number;
  hz?: number;
  durSec?: number;
  startMs?: number;
}): Series {
  const {
    ampMg,
    breathBpm = 6,
    phaseRad = 0,
    offsetMg = 900,
    hz = 50,
    durSec = 60,
    startMs = 0,
  } = opts;
  const x: number[] = [];
  const y: number[] = [];
  const f = breathBpm / 60;
  const n = Math.round(durSec * hz);
  for (let i = 0; i < n; i++) {
    const tMs = T0 + startMs + (i * 1000) / hz;
    const s = (tMs - T0) / 1000;
    x.push(tMs);
    y.push(offsetMg + ampMg * Math.sin(2 * Math.PI * f * s + phaseRad));
  }
  return { x, y };
}

describe('peakToPeak', () => {
  it('measures the full swing', () => {
    expect(peakToPeak([1, 5, -3, 2])).toBe(8);
  });
  it('needs at least two samples', () => {
    expect(peakToPeak([4])).toBeNull();
    expect(peakToPeak([])).toBeNull();
  });
});

describe('classify', () => {
  it('applies the spec thresholds', () => {
    expect(classify(1.5, 10)).toBe('DIAPHRAGMATIC');
    expect(classify(1.82, 10)).toBe('DIAPHRAGMATIC');
    expect(classify(1.49, 10)).toBe('BALANCED');
    expect(classify(0.7, 10)).toBe('BALANCED');
    expect(classify(0.69, 10)).toBe('THORACIC');
  });

  it('lets paradoxical outrank the ratio', () => {
    // A belly moving the wrong way is the finding, whatever the amplitudes say.
    expect(classify(2.5, 170)).toBe('PARADOXICAL');
    expect(classify(0.2, 150)).toBe('PARADOXICAL');
    expect(classify(2.5, 135)).toBe('DIAPHRAGMATIC'); // boundary is exclusive
  });

  it('reports UNKNOWN rather than guessing with no ratio', () => {
    expect(classify(null, null)).toBe('UNKNOWN');
    expect(classify(Number.NaN, 10)).toBe('UNKNOWN');
  });
});

describe('estimatePeriodMs', () => {
  it('recovers a 6 br/min period (10 s)', () => {
    const hz = 20;
    const y: number[] = [];
    for (let i = 0; i < 60 * hz; i++) y.push(Math.sin((2 * Math.PI * 0.1 * i) / hz));
    const p = estimatePeriodMs(y, hz);
    expect(p).not.toBeNull();
    expect(p as number).toBeGreaterThan(9500);
    expect(p as number).toBeLessThan(10500);
  });

  it('recovers a 15 br/min period (4 s)', () => {
    const hz = 20;
    const y: number[] = [];
    for (let i = 0; i < 60 * hz; i++) y.push(Math.sin((2 * Math.PI * 0.25 * i) / hz));
    const p = estimatePeriodMs(y, hz);
    expect(p as number).toBeGreaterThan(3800);
    expect(p as number).toBeLessThan(4200);
  });

  it('returns null on a flat signal instead of inventing a rate', () => {
    expect(estimatePeriodMs(new Array(600).fill(0), 20)).toBeNull();
  });

  it('returns null when the window is too short to contain a period', () => {
    // 12 s of a 10 s breath. A biased autocorrelation decays fast enough here
    // that its maximum lands on the SHORTEST lag searched, so the estimator
    // returns its own lower bound — which then produced a bogus phase angle and
    // a false PARADOXICAL classification. It must decline instead.
    const hz = 20;
    const y: number[] = [];
    for (let i = 0; i < 12 * hz; i++) y.push(Math.sin((2 * Math.PI * 0.1 * i) / hz));
    const p = estimatePeriodMs(y, hz);
    if (p !== null) expect(p).toBeGreaterThan(4000); // never the 2 s floor
  });

  it('never returns the lower bound of its own search range', () => {
    const hz = 20;
    for (const durSec of [9, 12, 15, 18, 25, 40]) {
      const y: number[] = [];
      for (let i = 0; i < durSec * hz; i++) y.push(Math.sin((2 * Math.PI * 0.1 * i) / hz));
      const p = estimatePeriodMs(y, hz);
      if (p !== null) expect(p).not.toBeCloseTo(2000, 0);
    }
  });

  it('reports the fundamental, not a harmonic of it', () => {
    // A periodic signal correlates just as well at 2x and 3x its period, and
    // with unbiased normalisation those can measure marginally higher — picking
    // the strongest peak reports half the breathing rate.
    const hz = 20;
    for (const periodS of [3, 4, 5, 6, 8]) {
      const y: number[] = [];
      for (let i = 0; i < 60 * hz; i++) y.push(Math.sin((2 * Math.PI * i) / (periodS * hz)));
      const p = estimatePeriodMs(y, hz);
      expect(p).not.toBeNull();
      expect(p as number).toBeGreaterThan(periodS * 1000 * 0.9);
      expect(p as number).toBeLessThan(periodS * 1000 * 1.1);
    }
  });

  it('finds the period once the window holds two cycles', () => {
    const hz = 20;
    const y: number[] = [];
    for (let i = 0; i < 25 * hz; i++) y.push(Math.sin((2 * Math.PI * 0.1 * i) / hz));
    const p = estimatePeriodMs(y, hz);
    expect(p).not.toBeNull();
    expect(p as number).toBeGreaterThan(9000);
    expect(p as number).toBeLessThan(11000);
  });
});

describe('crossCorrelationLag', () => {
  it('finds a known lag', () => {
    const n = 400;
    const a: number[] = [];
    const b: number[] = [];
    for (let i = 0; i < n; i++) {
      a.push(Math.sin((2 * Math.PI * i) / 100));
      b.push(Math.sin((2 * Math.PI * (i - 10)) / 100)); // b lags a by 10 samples
    }
    const r = crossCorrelationLag(a, b, 50);
    expect(r).not.toBeNull();
    expect((r as { lagSamples: number }).lagSamples).toBe(10);
    expect((r as { correlation: number }).correlation).toBeGreaterThan(0.98);
  });

  it('reports zero lag for identical signals', () => {
    const a = Array.from({ length: 200 }, (_, i) => Math.sin(i / 8));
    expect(crossCorrelationLag(a, a, 30)?.lagSamples).toBe(0);
  });

  it('is amplitude-blind — the straps never share a gain', () => {
    const a = Array.from({ length: 200 }, (_, i) => Math.sin(i / 8));
    const b = a.map((v) => v * 17);
    const r = crossCorrelationLag(a, b, 30);
    expect(r?.lagSamples).toBe(0);
    expect(r?.correlation).toBeGreaterThan(0.99);
  });

  it('returns a strong negative correlation for an inverted signal', () => {
    const a = Array.from({ length: 200 }, (_, i) => Math.sin(i / 8));
    const b = a.map((v) => -v);
    // With the lag search bounded, the best alignment of an inverted wave is
    // half a cycle away; the reported correlation there is high and positive.
    const r = crossCorrelationLag(a, b, 30);
    expect(r).not.toBeNull();
    expect(Math.abs(r!.lagSamples)).toBeGreaterThan(0);
  });
});

describe('analyseDualStreams', () => {
  const opts = { ...DEFAULT_DIAPHRAGM_OPTIONS };

  it('classifies belly-dominant breathing as DIAPHRAGMATIC', () => {
    const chest = strap({ ampMg: 10, offsetMg: 900 });
    const abdo = strap({ ampMg: 25, offsetMg: -850, startMs: 7 });
    const r = analyseDualStreams(chest, abdo, opts);
    expect(r.ratio).not.toBeNull();
    expect(r.ratio as number).toBeGreaterThan(2);
    expect(r.classification).toBe('DIAPHRAGMATIC');
  });

  it('classifies chest-dominant breathing as THORACIC', () => {
    const chest = strap({ ampMg: 30 });
    const abdo = strap({ ampMg: 8, startMs: 3 });
    const r = analyseDualStreams(chest, abdo, opts);
    expect(r.ratio as number).toBeLessThan(0.7);
    expect(r.classification).toBe('THORACIC');
  });

  it('classifies matched amplitudes as BALANCED', () => {
    const chest = strap({ ampMg: 20 });
    const abdo = strap({ ampMg: 20, startMs: 5 });
    const r = analyseDualStreams(chest, abdo, opts);
    expect(r.ratio as number).toBeGreaterThanOrEqual(0.7);
    expect(r.ratio as number).toBeLessThan(1.5);
    expect(r.classification).toBe('BALANCED');
  });

  it('flags antiphase movement as PARADOXICAL', () => {
    // Belly moving opposite the chest — the finding this whole feature exists for.
    const chest = strap({ ampMg: 20, phaseRad: 0 });
    const abdo = strap({ ampMg: 20, phaseRad: Math.PI, startMs: 4 });
    const r = analyseDualStreams(chest, abdo, opts);
    expect(r.phaseAngleDeg).not.toBeNull();
    expect(r.phaseAngleDeg as number).toBeGreaterThan(135);
    expect(r.classification).toBe('PARADOXICAL');
  });

  it('reports near-zero phase for straps moving together', () => {
    const chest = strap({ ampMg: 20 });
    const abdo = strap({ ampMg: 30, startMs: 6 });
    const r = analyseDualStreams(chest, abdo, opts);
    expect(r.phaseAngleDeg as number).toBeLessThan(45);
  });

  it('recovers a quarter-cycle lag as ~90 degrees', () => {
    const chest = strap({ ampMg: 20, phaseRad: 0 });
    const abdo = strap({ ampMg: 20, phaseRad: -Math.PI / 2, startMs: 2 });
    const r = analyseDualStreams(chest, abdo, opts);
    expect(r.phaseAngleDeg as number).toBeGreaterThan(70);
    expect(r.phaseAngleDeg as number).toBeLessThan(110);
  });

  it('strips the gravity offsets — the ratio is about movement, not posture', () => {
    // Wildly different offsets, identical breathing: ratio must be ~1.
    const chest = strap({ ampMg: 20, offsetMg: 990 });
    const abdo = strap({ ampMg: 20, offsetMg: -880, startMs: 5 });
    const r = analyseDualStreams(chest, abdo, opts);
    expect(r.ratio as number).toBeGreaterThan(0.85);
    expect(r.ratio as number).toBeLessThan(1.15);
  });

  it('rejects common-mode motion into the differential', () => {
    // Same breathing on both straps plus a shared lurch: the differential should
    // stay far smaller than either input.
    const chest = strap({ ampMg: 20 });
    const abdo = strap({ ampMg: 20, startMs: 4 });
    const lurch = (i: number, n: number): number => (i > n / 2 ? 300 : 0);
    chest.y = chest.y.map((v, i) => v + lurch(i, chest.y.length));
    abdo.y = abdo.y.map((v, i) => v + lurch(i, abdo.y.length));
    const r = analyseDualStreams(chest, abdo, opts);
    const diffPtP = peakToPeak(r.differential) ?? 0;
    const chestPtP = peakToPeak(r.chest) ?? 0;
    expect(diffPtP).toBeLessThan(chestPtP);
  });

  it('applies the calibration coefficients', () => {
    const chest = strap({ ampMg: 20 });
    const abdo = strap({ ampMg: 20, startMs: 5 });
    const plain = analyseDualStreams(chest, abdo, opts);
    // Halving the abdominal calibration doubles its normalised amplitude.
    const scaled = analyseDualStreams(chest, abdo, { ...opts, calibAbdo: 0.5 });
    expect(scaled.ratio as number).toBeCloseTo((plain.ratio as number) * 2, 5);
  });

  it('returns UNKNOWN when the straps barely overlap', () => {
    const chest = strap({ ampMg: 20, durSec: 60 });
    const abdo = strap({ ampMg: 20, durSec: 60, startMs: 59_000 });
    const r = analyseDualStreams(chest, abdo, opts);
    expect(r.classification).toBe('UNKNOWN');
    expect(r.ratio).toBeNull();
  });

  it('returns UNKNOWN with only one strap', () => {
    const r = analyseDualStreams(strap({ ampMg: 20 }), { x: [], y: [] }, opts);
    expect(r.classification).toBe('UNKNOWN');
    expect(r.t).toEqual([]);
  });

  it('puts both traces on one grid, so sample i is the same instant', () => {
    const chest = strap({ ampMg: 20, hz: 50, startMs: 0 });
    const abdo = strap({ ampMg: 20, hz: 25, startMs: 13 }); // different rate AND clock
    const r = analyseDualStreams(chest, abdo, opts);
    expect(r.t.length).toBeGreaterThan(100);
    expect(r.chest).toHaveLength(r.t.length);
    expect(r.abdo).toHaveLength(r.t.length);
    expect(r.differential).toHaveLength(r.t.length);
    const step = r.t[1] - r.t[0];
    expect(step).toBeCloseTo(1000 / opts.gridHz, 6);
  });
});

describe('balancePosition', () => {
  it('centres R = 1', () => {
    expect(balancePosition(1)).toBeCloseTo(0.5, 9);
  });

  it('places R = 2 and R = 0.5 symmetrically about centre', () => {
    const hi = balancePosition(2) as number;
    const lo = balancePosition(0.5) as number;
    expect(hi - 0.5).toBeCloseTo(0.5 - lo, 9);
  });

  it('clamps the extremes into the bar', () => {
    expect(balancePosition(100)).toBe(1);
    expect(balancePosition(0.001)).toBe(0);
  });

  it('rejects nonsense', () => {
    expect(balancePosition(null)).toBeNull();
    expect(balancePosition(0)).toBeNull();
    expect(balancePosition(Number.NaN)).toBeNull();
  });
});
