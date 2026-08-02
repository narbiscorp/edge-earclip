import { describe, expect, it } from 'vitest';
import { buildBody, leanDegFrom, normalise, sampleAt, HEAD, MAX_LEAN_DEG } from '../bodyPose';

/** Pull the numeric pairs out of a path string, in order. */
function points(d: string): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  const re = /(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d)) !== null) out.push({ x: Number(m[1]), y: Number(m[2]) });
  return out;
}

const maxX = (d: string): number => Math.max(...points(d).map((p) => p.x));

describe('sampleAt', () => {
  const t = [1000, 2000, 3000];
  const y = [0, 10, 20];

  it('interpolates between samples', () => {
    expect(sampleAt(t, y, 1500)).toBeCloseTo(5, 9);
    expect(sampleAt(t, y, 2750)).toBeCloseTo(17.5, 9);
  });

  it('clamps outside the range rather than extrapolating', () => {
    expect(sampleAt(t, y, 0)).toBe(0);
    expect(sampleAt(t, y, 99999)).toBe(20);
  });

  it('hits the knots exactly', () => {
    expect(sampleAt(t, y, 2000)).toBeCloseTo(10, 9);
  });

  it('returns null with no data', () => {
    expect(sampleAt([], [], 1000)).toBeNull();
  });
});

describe('normalise', () => {
  it('maps half the peak-to-peak to full scale', () => {
    // A p-p of 20 means an amplitude of 10, so +10 is a full inhale.
    expect(normalise(10, 20)).toBeCloseTo(1, 9);
    expect(normalise(-10, 20)).toBeCloseTo(-1, 9);
    expect(normalise(0, 20)).toBe(0);
  });

  it('clamps beyond full scale instead of distorting the figure', () => {
    expect(normalise(100, 20)).toBe(1);
    expect(normalise(-100, 20)).toBe(-1);
  });

  it('is zero when there is no measured amplitude', () => {
    expect(normalise(5, 0)).toBe(0);
    expect(normalise(null, 20)).toBe(0);
    expect(normalise(5, null)).toBe(0);
  });
});

describe('leanDegFrom', () => {
  /* Drawn lean is a scaled-down version of measured tilt, so these assert the
   * relationship rather than absolute degrees — the scale is a presentation
   * choice and should be free to change without rewriting the tests. */
  it('averages the two straps', () => {
    const both = leanDegFrom(10, 20);
    expect(both).toBeCloseTo(leanDegFrom(15, 15), 9);
  });

  it('uses whichever strap it has', () => {
    expect(leanDegFrom(12, null)).toBeCloseTo(leanDegFrom(12, 12), 9);
    expect(leanDegFrom(null, 8)).toBeCloseTo(leanDegFrom(8, 8), 9);
  });

  it('is upright with no posture data', () => {
    expect(leanDegFrom(null, null)).toBe(0);
  });

  it('grows with tilt and keeps its sign', () => {
    expect(leanDegFrom(10, 10)).toBeGreaterThan(leanDegFrom(5, 5));
    expect(leanDegFrom(-10, -10)).toBeLessThan(0);
  });

  it('caps extreme tilts so the figure stays legible', () => {
    expect(leanDegFrom(90, 90)).toBe(MAX_LEAN_DEG);
    expect(leanDegFrom(-90, -90)).toBe(-MAX_LEAN_DEG);
  });
});

describe('buildBody anatomy', () => {
  const rest = buildBody({ chest: 0, abdo: 0, leanDeg: 0 });

  it('produces a closed torso outline', () => {
    expect(rest.torso.startsWith('M ')).toBe(true);
    expect(rest.torso.trim().endsWith('Z')).toBe(true);
    expect(points(rest.torso).length).toBeGreaterThan(10);
    expect(rest.torso).not.toMatch(/NaN|undefined/);
  });

  it('moves the chest forward on a thoracic inhale, and barely the belly', () => {
    const inhale = buildBody({ chest: 1, abdo: 0, leanDeg: 0 });
    expect(inhale.chestStrap.x2).toBeGreaterThan(rest.chestStrap.x2);
    // The abdominal band should be essentially where it was.
    expect(Math.abs(inhale.abdoStrap.x2 - rest.abdoStrap.x2)).toBeLessThan(0.01);
  });

  it('moves the belly forward on an abdominal inhale, and barely the chest', () => {
    const inhale = buildBody({ chest: 0, abdo: 1, leanDeg: 0 });
    expect(inhale.abdoStrap.x2).toBeGreaterThan(rest.abdoStrap.x2);
    expect(Math.abs(inhale.chestStrap.x2 - rest.chestStrap.x2)).toBeLessThan(0.01);
  });

  it('gives the belly more travel than the chest — as diaphragmatic breathing does', () => {
    const full = buildBody({ chest: 1, abdo: 1, leanDeg: 0 });
    const chestTravel = full.chestStrap.x2 - rest.chestStrap.x2;
    const abdoTravel = full.abdoStrap.x2 - rest.abdoStrap.x2;
    expect(abdoTravel).toBeGreaterThan(chestTravel);
  });

  it('descends AND flattens the diaphragm on inhale', () => {
    // The defining anatomy: the diaphragm contracts downward to draw air in.
    // Getting this backwards would teach the opposite of the thing being trained.
    const restPts = points(rest.diaphragm);
    const inPts = points(buildBody({ chest: 0, abdo: 1, leanDeg: 0 }).diaphragm);
    const restApexY = Math.min(...restPts.map((p) => p.y));
    const inApexY = Math.min(...inPts.map((p) => p.y));
    // y grows downward in SVG, so a descending dome has a LARGER y.
    expect(inApexY).toBeGreaterThan(restApexY);

    const domeRise = (ps: Array<{ y: number }>): number =>
      Math.max(...ps.map((p) => p.y)) - Math.min(...ps.map((p) => p.y));
    expect(domeRise(inPts)).toBeLessThan(domeRise(restPts)); // flatter
  });

  it('raises the diaphragm on exhale', () => {
    const exhale = points(buildBody({ chest: 0, abdo: -1, leanDeg: 0 }).diaphragm);
    const restPts = points(rest.diaphragm);
    expect(Math.min(...exhale.map((p) => p.y))).toBeLessThan(Math.min(...restPts.map((p) => p.y)));
  });

  it('shows a paradoxical breath as chest and belly moving oppositely', () => {
    const paradox = buildBody({ chest: 1, abdo: -1, leanDeg: 0 });
    expect(paradox.chestStrap.x2).toBeGreaterThan(rest.chestStrap.x2); // chest out
    expect(paradox.abdoStrap.x2).toBeLessThan(rest.abdoStrap.x2); // belly in
  });

  it('keeps the front of the body ahead of the spine at every phase', () => {
    // A contour that crossed itself would render as a pinched knot.
    for (const chest of [-1, 0, 1]) {
      for (const abdo of [-1, 0, 1]) {
        const b = buildBody({ chest, abdo, leanDeg: 0 });
        expect(b.chestStrap.x2).toBeGreaterThan(b.chestStrap.x1 + 30);
        expect(b.abdoStrap.x2).toBeGreaterThan(b.abdoStrap.x1 + 30);
        expect(maxX(b.torso)).toBeLessThan(200); // stays inside the viewBox
        expect(b.torso).not.toMatch(/NaN/);
      }
    }
  });

  it('clamps out-of-range input rather than distorting', () => {
    const wild = buildBody({ chest: 12, abdo: -9, leanDeg: 0 });
    const full = buildBody({ chest: 1, abdo: -1, leanDeg: 0 });
    expect(wild.chestStrap.x2).toBeCloseTo(full.chestStrap.x2, 6);
    expect(wild.abdoStrap.x2).toBeCloseTo(full.abdoStrap.x2, 6);
  });

  it('emits a lung field and three ribs, all well-formed', () => {
    expect(rest.lung).toMatch(/^M /);
    expect(rest.lung.trim().endsWith('Z')).toBe(true);
    expect(rest.ribs).toHaveLength(3);
    for (const r of rest.ribs) {
      expect(r).toMatch(/^M /);
      expect(r).not.toMatch(/NaN/);
    }
  });
});

describe('layout safety', () => {
  /** Rotate a point about the hip, the way the SVG group transform does. */
  function rotate(x: number, y: number, deg: number): { x: number; y: number } {
    const r = (deg * Math.PI) / 180;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    const dx = x - 98;
    const dy = y - 236;
    return { x: 98 + dx * cos - dy * sin, y: 236 + dx * sin + dy * cos };
  }

  it('keeps the head clear of the callout labels at maximum lean', () => {
    // At 16 degrees the head landed at x~174 with r 24, overlapping labels that
    // start at x 199. Lean is now scaled and capped; check the worst case.
    for (const deg of [MAX_LEAN_DEG, -MAX_LEAN_DEG]) {
      const c = rotate(HEAD.x, HEAD.y, deg);
      expect(c.x + HEAD.r).toBeLessThan(200); // labels begin at 210
      expect(c.x - HEAD.r).toBeGreaterThan(0); // stays in the viewBox
      expect(c.y - HEAD.r).toBeGreaterThan(0);
    }
  });

  it('does not let the head protrude past the chest at rest', () => {
    // A profile where the face leads the sternum reads as a stoop regardless
    // of what the data says.
    const rest = buildBody({ chest: 0, abdo: 0, leanDeg: 0 });
    expect(HEAD.x + HEAD.r).toBeLessThanOrEqual(rest.chestStrap.x2 + 4);
  });

  it('scales measured tilt down rather than drawing a bow', () => {
    expect(Math.abs(leanDegFrom(20, 20))).toBeLessThan(20);
    expect(Math.abs(leanDegFrom(60, 60))).toBe(MAX_LEAN_DEG);
  });
});
