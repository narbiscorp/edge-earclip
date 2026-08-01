import { describe, expect, it } from 'vitest';
import {
  angleBetweenDeg,
  assessPosture,
  magnitude,
  meanVector,
  postureAdvice,
  STRAP_ALIGN_WARN_DEG,
  type PostureReference,
} from '../posture';
import {
  CALIBRATION_STEPS,
  TOTAL_CALIBRATION_SEC,
  learnedThresholds,
  matchBreathing,
  matchPosture,
  type CalibrationModel,
} from '../calibration';

const v = (x: number, y: number, z: number) => ({ x, y, z });

describe('angleBetweenDeg', () => {
  it('is zero for parallel vectors and 90 for perpendicular', () => {
    expect(angleBetweenDeg(v(0, 0, 1000), v(0, 0, 500))).toBeCloseTo(0, 6);
    expect(angleBetweenDeg(v(1000, 0, 0), v(0, 1000, 0))).toBeCloseTo(90, 6);
    expect(angleBetweenDeg(v(0, 0, 1000), v(0, 0, -1000))).toBeCloseTo(180, 6);
  });

  it('returns null rather than NaN for a zero vector', () => {
    expect(angleBetweenDeg(v(0, 0, 0), v(0, 0, 1))).toBeNull();
  });

  it('measures the real recording as ~23 degrees apart', () => {
    // The two straps from the session that produced the false PARADOXICAL
    // warning. This is the number the whole feature exists to catch.
    const deg = angleBetweenDeg(v(-903, 49, 426), v(-1016, 48, 36));
    expect(deg).not.toBeNull();
    expect(deg as number).toBeGreaterThan(20);
    expect(deg as number).toBeLessThan(26);
    expect(deg as number).toBeGreaterThan(STRAP_ALIGN_WARN_DEG);
  });
});

describe('assessPosture', () => {
  const ref: PostureReference = {
    chest: v(0, 0, 1000),
    abdo: v(0, 0, 1000),
    interStrapDeg: 0,
    capturedAt: 0,
  };

  it('flags straps rotated differently, ahead of anything else', () => {
    const s = assessPosture(v(-903, 49, 426), v(-1016, 48, 36), ref);
    expect(s.state).toBe('misaligned');
    expect(s.interStrapDeg as number).toBeGreaterThan(STRAP_ALIGN_WARN_DEG);
    expect(postureAdvice(s)).toMatch(/rotated differently/i);
  });

  it('asks for calibration when there is no reference', () => {
    expect(assessPosture(v(0, 0, 1000), v(0, 0, 1000), null).state).toBe('uncalibrated');
  });

  it('reports aligned when the straps agree and match the reference', () => {
    const s = assessPosture(v(0, 10, 1000), v(0, -10, 1000), ref);
    expect(s.state).toBe('aligned');
  });

  it('reports drift once posture moves away from the reference', () => {
    // Both straps tilted ~25 degrees forward, still agreeing with each other.
    const tilted = v(0, 420, 910);
    const s = assessPosture(tilted, tilted, ref);
    expect(s.interStrapDeg).toBeCloseTo(0, 4);
    expect(s.state).toBe('drifted');
    expect(postureAdvice(s)).toMatch(/slouch|lean|recalibrate/i);
  });

  it('notices the subject is moving, so the vector is not a posture reading', () => {
    const s = assessPosture(v(0, 0, 1600), v(0, 0, 1000), ref);
    expect(s.moving).toBe(true);
  });

  it('returns unknown with only one strap', () => {
    expect(assessPosture(v(0, 0, 1000), null, ref).state).toBe('unknown');
  });
});

describe('meanVector / magnitude', () => {
  it('averages a window', () => {
    expect(meanVector([1, 3], [0, 0], [10, 20])).toEqual({ x: 2, y: 0, z: 15 });
  });
  it('returns null on empty', () => {
    expect(meanVector([], [], [])).toBeNull();
  });
  it('measures length', () => {
    expect(magnitude(v(3, 4, 0))).toBeCloseTo(5, 9);
  });
});

describe('calibration steps', () => {
  it('captures the upright reference before the breathing demonstrations', () => {
    // The breathing ratios are only comparable to each other if they were all
    // produced from the same posture.
    const ids = CALIBRATION_STEPS.map((s) => s.id);
    expect(ids[0]).toBe('upright');
    expect(ids.indexOf('chest')).toBeGreaterThan(ids.indexOf('upright'));
    expect(ids.indexOf('slouched')).toBeGreaterThan(ids.indexOf('belly'));
  });

  it('is short enough to actually complete', () => {
    expect(TOTAL_CALIBRATION_SEC).toBeLessThanOrEqual(120);
    expect(CALIBRATION_STEPS).toHaveLength(6);
  });
});

const model = (ratios: [number, number, number]): CalibrationModel => ({
  axis: 'y',
  createdAt: 0,
  breathing: [
    { id: 'chest', ratio: ratios[0], chestPtP: 40, abdoPtP: 40 * ratios[0], phaseDeg: 5, correlation: 0.9 },
    { id: 'diaphragm', ratio: ratios[1], chestPtP: 30, abdoPtP: 30 * ratios[1], phaseDeg: 5, correlation: 0.9 },
    { id: 'belly', ratio: ratios[2], chestPtP: 20, abdoPtP: 20 * ratios[2], phaseDeg: 5, correlation: 0.9 },
  ],
  postures: [
    { id: 'upright', chest: v(0, 0, 1000), abdo: v(0, 0, 1000) },
    { id: 'slouched', chest: v(0, 500, 866), abdo: v(0, 500, 866) },
    { id: 'back', chest: v(0, -500, 866), abdo: v(0, -500, 866) },
  ],
});

describe('matchBreathing', () => {
  const m = model([0.5, 1.4, 3.0]);

  it('names the demonstration the current ratio resembles', () => {
    expect(matchBreathing(m, 0.55)?.id).toBe('chest');
    expect(matchBreathing(m, 1.4)?.id).toBe('diaphragm');
    expect(matchBreathing(m, 2.9)?.id).toBe('belly');
  });

  it('compares in log space, so 0.5 and 2.0 are equally far from 1.0', () => {
    const sym = model([0.5, 1.0, 2.0]);
    const lo = matchBreathing(sym, 0.7);
    const hi = matchBreathing(sym, 1 / 0.7);
    expect(lo?.distance).toBeCloseTo(hi?.distance as number, 9);
  });

  it('reports low confidence when the demonstrations were too alike', () => {
    const vague = model([1.0, 1.05, 1.1]);
    const match = matchBreathing(vague, 1.02);
    expect(match).not.toBeNull();
    expect(match!.confidence).toBeLessThan(0.6);
  });

  it('returns null without a model or a ratio', () => {
    expect(matchBreathing(null, 1.5)).toBeNull();
    expect(matchBreathing(m, null)).toBeNull();
    expect(matchBreathing(m, 0)).toBeNull();
  });
});

describe('matchPosture', () => {
  const m = model([0.5, 1.4, 3.0]);
  it('recognises which calibrated posture the subject is in', () => {
    expect(matchPosture(m, v(0, 0, 1000), v(0, 0, 1000))?.id).toBe('upright');
    expect(matchPosture(m, v(0, 480, 870), v(0, 480, 870))?.id).toBe('slouched');
    expect(matchPosture(m, v(0, -480, 870), v(0, -480, 870))?.id).toBe('back');
  });
  it('returns null without both straps', () => {
    expect(matchPosture(m, null, v(0, 0, 1000))).toBeNull();
  });
});

describe('learnedThresholds', () => {
  it('places boundaries between the demonstrations, in log space', () => {
    const t = learnedThresholds(model([0.5, 2.0, 8.0]));
    expect(t).not.toBeNull();
    expect(t!.thoracic).toBeCloseTo(1.0, 6); // sqrt(0.5 * 2)
    expect(t!.diaphragmatic).toBeCloseTo(4.0, 6); // sqrt(2 * 8)
  });

  it('declines when the demonstrations were not distinct', () => {
    // Keeping the population defaults beats inventing a personal boundary from
    // two demonstrations that were the same.
    expect(learnedThresholds(model([1.5, 1.5, 1.5]))).toBeNull();
    expect(learnedThresholds(null)).toBeNull();
  });

  it('produces an ordered pair of boundaries', () => {
    const t = learnedThresholds(model([0.4, 1.2, 2.6]));
    expect(t!.diaphragmatic).toBeGreaterThan(t!.thoracic);
  });
});
