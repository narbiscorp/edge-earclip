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
  FALLBACK_BREATH_SEC,
  TOTAL_CALIBRATION_SEC,
  learnedThresholds,
  matchBreathing,
  matchPosture,
  mergeCalibration,
  stepSeconds,
  totalCalibrationSec,
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

  it('measures the real recording as ~23 degrees apart — which is NORMAL', () => {
    // Originally read as the cause of a false PARADOXICAL warning. It was not:
    // a sternal and an epigastric strap sit on differently-sloped surfaces and
    // are never parallel. The real cause was the axis, and then the sign.
    const deg = angleBetweenDeg(v(-903, 49, 426), v(-1016, 48, 36));
    expect(deg).not.toBeNull();
    expect(deg as number).toBeGreaterThan(20);
    expect(deg as number).toBeLessThan(26);
    expect(deg as number).toBeLessThan(STRAP_ALIGN_WARN_DEG);
  });
});

describe('assessPosture', () => {
  const ref: PostureReference = {
    chest: v(0, 0, 1000),
    abdo: v(0, 0, 1000),
    interStrapDeg: 0,
    capturedAt: 0,
  };

  it('flags a genuinely twisted strap ahead of anything else', () => {
    // 90 degrees apart cannot be anatomy; posture drift is beside the point.
    const s = assessPosture(v(0, 0, 1000), v(1000, 0, 0), ref);
    expect(s.state).toBe('misaligned');
    expect(s.interStrapDeg as number).toBeGreaterThan(STRAP_ALIGN_WARN_DEG);
    expect(postureAdvice(s)).toMatch(/twisted|upside down/i);
  });

  it('does not call a normally-worn pair misaligned', () => {
    const s = assessPosture(v(-903, 49, 426), v(-1016, 48, 36), ref);
    expect(s.state).not.toBe('misaligned');
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

describe('strap alignment threshold (regression: warning never cleared)', () => {
  /* Reported: "the misaligned message never goes away". It was right.
   *
   * A sternal strap and an epigastric one lie on surfaces that slope
   * differently — the chest is not a cylinder — so they are never parallel even
   * when both are worn correctly. Two independent sessions from a correctly
   * strapped subject, minutes and a day apart:
   *
   *   2026-07-31  chest (-903, 49, 426)  abdo (-1016, 48,  36)  ->  23.0 deg
   *   2026-08-01  chest (-927, 21, 401)  abdo ( -990, 66,  21)  ->  22.4 deg
   *
   * The original 15 deg threshold called both of those a fault, so it fired on
   * every good session. */
  const sessions: Array<[string, Vec3ish, Vec3ish]> = [
    ['2026-07-31', { x: -903, y: 49, z: 426 }, { x: -1016, y: 48, z: 36 }],
    ['2026-08-01', { x: -927, y: 21, z: 401 }, { x: -990, y: 66, z: 21 }],
  ];
  type Vec3ish = { x: number; y: number; z: number };

  it('measures both real sessions at 20-25 degrees', () => {
    for (const [, chest, abdo] of sessions) {
      const deg = angleBetweenDeg(chest, abdo) as number;
      expect(deg).toBeGreaterThan(20);
      expect(deg).toBeLessThan(26);
    }
  });

  it('does NOT call a correctly-worn pair misaligned', () => {
    for (const [label, chest, abdo] of sessions) {
      const s = assessPosture(chest, abdo, null);
      expect(s.state, `${label} should not be misaligned`).not.toBe('misaligned');
    }
  });

  it('still catches a strap that is genuinely twisted', () => {
    // 90 degrees apart is not anatomy.
    const s = assessPosture({ x: 0, y: 0, z: 1000 }, { x: 1000, y: 0, z: 0 }, null);
    expect(s.state).toBe('misaligned');
    expect(postureAdvice(s)).toMatch(/twisted|upside down/i);
  });

  it('reaches "aligned" once a reference exists at a realistic strap angle', () => {
    const [, chest, abdo] = sessions[1];
    const ref = { chest, abdo, interStrapDeg: null, capturedAt: 0 };
    expect(assessPosture(chest, abdo, ref).state).toBe('aligned');
  });
});

describe('step sizing by breath count', () => {
  const breathing = CALIBRATION_STEPS.find((s) => s.kind === 'breathing')!;
  const postureStep = CALIBRATION_STEPS.find((s) => s.kind === 'posture')!;

  it('gives a slow breather more time than a fast one for the same count', () => {
    // 20 s is two breaths at 6 br/min but four at 12, so a fixed duration
    // collected very different amounts of evidence depending on the subject.
    const slow = stepSeconds(breathing, 10, 4); // 10 s period
    const fast = stepSeconds(breathing, 3, 4); // 3 s period
    expect(slow).toBeGreaterThan(fast);
    expect(slow).toBe(40);
  });

  it('scales with the requested breath count', () => {
    expect(stepSeconds(breathing, 5, 6)).toBeGreaterThan(stepSeconds(breathing, 5, 3));
  });

  it('clamps so a step is never uselessly short or unbearably long', () => {
    expect(stepSeconds(breathing, 2, 2)).toBeGreaterThanOrEqual(12);
    expect(stepSeconds(breathing, 20, 8)).toBeLessThanOrEqual(75);
  });

  it('falls back to an assumed period before one has been measured', () => {
    expect(stepSeconds(breathing, null, 4)).toBe(4 * FALLBACK_BREATH_SEC);
  });

  it('ignores an implausible period rather than trusting it', () => {
    expect(stepSeconds(breathing, 0.2, 4)).toBe(4 * FALLBACK_BREATH_SEC);
    expect(stepSeconds(breathing, 900, 4)).toBe(4 * FALLBACK_BREATH_SEC);
  });

  it('leaves posture steps as a fixed hold', () => {
    expect(stepSeconds(postureStep, 12, 8)).toBe(postureStep.seconds);
  });

  it('reports a total that tracks the settings', () => {
    expect(totalCalibrationSec(6, 6)).toBeGreaterThan(totalCalibrationSec(6, 3));
  });
});

describe('mergeCalibration (redo one step)', () => {
  const sig = (id: 'chest' | 'diaphragm' | 'belly', ratio: number) => ({
    id,
    ratio,
    chestPtP: 40,
    abdoPtP: 40 * ratio,
    phaseDeg: 5,
    correlation: 0.9,
  });
  const base = {
    axis: 'y' as const,
    createdAt: 1,
    breathing: [sig('chest', 0.5), sig('diaphragm', 1.4), sig('belly', 3.0)],
    postures: [
      { id: 'upright' as const, chest: v(0, 0, 1000), abdo: v(0, 0, 1000) },
      { id: 'slouched' as const, chest: v(0, 500, 866), abdo: v(0, 500, 866) },
    ],
  };

  it('replaces just the redone demonstration and keeps the rest', () => {
    const merged = mergeCalibration(base, [sig('belly', 4.2)], [], 'y', 2);
    expect(merged.breathing).toHaveLength(3);
    expect(merged.breathing.find((b) => b.id === 'belly')!.ratio).toBe(4.2);
    expect(merged.breathing.find((b) => b.id === 'chest')!.ratio).toBe(0.5);
    expect(merged.breathing.find((b) => b.id === 'diaphragm')!.ratio).toBe(1.4);
  });

  it('replaces a single posture without disturbing the others', () => {
    const merged = mergeCalibration(base, [], [{ id: 'upright', chest: v(0, 0, 990), abdo: v(0, 0, 990) }], 'y', 2);
    expect(merged.postures).toHaveLength(2);
    expect(merged.postures.find((p) => p.id === 'upright')!.chest.z).toBe(990);
    expect(merged.postures.find((p) => p.id === 'slouched')).toBeDefined();
  });

  it('adds a step that had not been captured before', () => {
    const merged = mergeCalibration(base, [], [{ id: 'back', chest: v(0, -500, 866), abdo: v(0, -500, 866) }], 'y', 2);
    expect(merged.postures).toHaveLength(3);
  });

  it('keeps entries in the sequence order, not the order they were redone', () => {
    const merged = mergeCalibration(base, [sig('chest', 0.4)], [], 'y', 2);
    expect(merged.breathing.map((b) => b.id)).toEqual(['chest', 'diaphragm', 'belly']);
  });

  it('builds a fresh model when there was none', () => {
    const merged = mergeCalibration(null, [sig('chest', 0.6)], [], 'z', 5);
    expect(merged.breathing).toHaveLength(1);
    expect(merged.axis).toBe('z');
    expect(merged.createdAt).toBe(5);
  });
});
