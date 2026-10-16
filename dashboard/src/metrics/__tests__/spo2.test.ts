import { describe, it, expect } from 'vitest';
import {
  Spo2Tracker, computeSpo2Series, fitSpo2Cal, pairWithReference, sampleRateFromTimestamps, spo2FromR,
  SPO2_CAL_TEXTBOOK, type Spo2Estimate,
} from '../spo2';

const FS = 100;

/** A pulse wave with harmonics (not a sine), peak-to-peak ~2, at [hz]. */
function pulse(t: number, hz = 1.2): number {
  const w = 2 * Math.PI * hz * t;
  return Math.sin(w) + 0.5 * Math.sin(2 * w + 0.6) + 0.2 * Math.sin(3 * w + 1.1);
}

interface Synth {
  seconds: number;
  dcIr?: number;
  dcRed?: number;
  /** pulse depth as a fraction of DC, per unit of pulse() */
  mIr?: number;
  mRed?: number;
  /** extra per-sample terms */
  irExtra?: (t: number, i: number) => number;
  redExtra?: (t: number, i: number) => number;
  /** multiplies both channels (an AGC gain step, breathing) */
  gain?: (t: number) => number;
}

/** Transmissive PPG: more blood, less light, in both channels with the same wave. */
function synth(o: Synth): Array<{ timestamp: number; sample: { ir: number; red: number } }> {
  const { seconds, dcIr = 1_100_000, dcRed = 1_000_000, mIr = 0.005, mRed = 0.003 } = o;
  const out = [];
  for (let i = 0; i < seconds * FS; i++) {
    const t = i / FS;
    const g = o.gain ? o.gain(t) : 1;
    const p = pulse(t);
    out.push({
      timestamp: 1_000_000 + i * (1000 / FS),
      sample: {
        ir: g * dcIr * (1 - mIr * p) + (o.irExtra ? o.irExtra(t, i) : 0),
        red: g * dcRed * (1 - mRed * p) + (o.redExtra ? o.redExtra(t, i) : 0),
      },
    });
  }
  return out;
}

function run(samples: ReturnType<typeof synth>): Array<{ t: number; e: Spo2Estimate }> {
  return computeSpo2Series(samples).map((s) => ({ t: (s.timestamp - 1_000_000) / 1000, e: s.value }));
}

/** Seeded noise, so a failure reproduces. */
function noise(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32 - 0.5;
  };
}

describe('SpO2 from the red / IR ratio of ratios', () => {
  it('maps R on the textbook line, clamped to 0..100', () => {
    expect(spo2FromR(0.6)).toBeCloseTo(95, 6);
    expect(spo2FromR(0.4)).toBe(100);
    expect(spo2FromR(1.0)).toBeCloseTo(85, 6);
    expect(spo2FromR(10)).toBe(0);
    expect(spo2FromR(0.6, { a: 104, b: 17 })).toBeCloseTo(93.8, 6);
    expect(SPO2_CAL_TEXTBOOK).toEqual({ a: 110, b: 25 });
  });

  it('recovers R = (AC/DC red) / (AC/DC IR) on a clean pulse, once its 2 s + 8 s window fills', () => {
    const est = run(synth({ seconds: 30, mIr: 0.005, mRed: 0.003 }));
    expect(est.filter((x) => x.t < 9.9).every((x) => x.e.reject === 'warming')).toBe(true);
    const shown = est.filter((x) => x.e.reject === null);
    expect(shown[0].t).toBeCloseTo(10, 1);
    expect(shown.length).toBeGreaterThanOrEqual(20);
    for (const { e } of shown) {
      expect(e.r).toBeCloseTo(0.6, 2);
      expect(e.corr).toBeGreaterThan(0.999);
      expect(e.piIr / e.piRed).toBeCloseTo((0.005 * 1_100_000) / 1_100_000 / ((0.003 * 1_000_000) / 1_000_000), 1);
    }
    expect(spo2FromR(shown[shown.length - 1].e.r)).toBeCloseTo(95, 0);
  });

  it('is one estimate a second, and the ratio does not care about the two channels\' gains', () => {
    const a = run(synth({ seconds: 20, dcIr: 1_400_000, dcRed: 600_000, mIr: 0.008, mRed: 0.004 }));
    const shown = a.filter((x) => x.e.reject === null);
    expect(shown.length).toBe(11);
    for (let i = 1; i < shown.length; i++) expect(shown[i].t - shown[i - 1].t).toBeCloseTo(1, 6);
    for (const { e } of shown) expect(e.r).toBeCloseTo(0.5, 2);
  });

  it('rides through breathing in the DC (±1 % at 0.25 Hz)', () => {
    const est = run(synth({ seconds: 40, gain: (t) => 1 + 0.01 * Math.sin(2 * Math.PI * 0.25 * t) }));
    const shown = est.filter((x) => x.e.reject === null);
    expect(shown.length).toBeGreaterThanOrEqual(28);
    for (const { e } of shown) expect(Math.abs(e.r - 0.6)).toBeLessThan(0.02);
  });

  it('withholds a window whose red and IR waves stop agreeing (motion), and says so', () => {
    const rnd = noise(7);
    const est = run(synth({ seconds: 30, redExtra: () => 8000 * rnd() }));
    const late = est.filter((x) => x.t >= 10);
    expect(late.length).toBeGreaterThan(15);
    for (const { e } of late) {
      expect(e.reject).toBe('motion');
      expect(e.corr).toBeLessThan(0.98);
    }
  });

  it('starts over at the new level after an LED / gain step, instead of reading the ring as R ~1', () => {
    const est = run(synth({ seconds: 45, gain: (t) => (t < 20 ? 1 : 1.5) }));
    expect(est.filter((x) => x.t > 10 && x.t < 19.95).every((x) => x.e.reject === null)).toBe(true);
    const after = est.filter((x) => x.t >= 20 && x.t < 29.95);
    expect(after.length).toBeGreaterThanOrEqual(9);
    expect(after.every((x) => x.e.reject === 'warming')).toBe(true);
    const back = est.filter((x) => x.t >= 30.5 && x.e.reject === null);
    expect(back.length).toBeGreaterThanOrEqual(14);
    for (const { e } of back) expect(e.r).toBeCloseTo(0.6, 2);
  });

  it('withholds the windows over a big slow level change (the clip creeping); the rest stay close', () => {
    // +20 % over 4 s: 0.05 % a sample, far under the jump that restarts the tracker. The windows
    // whose halves differ by over 10 % are withheld; the ones either side read R up to ~0.04 high.
    const ramp = (t: number) => (t < 20 ? 1 : t < 24 ? 1 + 0.05 * (t - 20) : 1.2);
    const est = run(synth({ seconds: 40, gain: ramp }));
    const during = est.filter((x) => x.t > 20 && x.t < 33);
    expect(during.filter((x) => x.e.reject === 'level_step').length).toBeGreaterThanOrEqual(3);
    for (const { e } of during.filter((x) => x.e.reject === null)) expect(Math.abs(e.r - 0.6)).toBeLessThan(0.05);
  });

  it('withholds clipped windows, a missing red channel, and a pulse too weak to read', () => {
    const rail = run(synth({ seconds: 15, dcIr: 2_090_000 }));
    expect(rail.filter((x) => x.t >= 10).every((x) => x.e.reject === 'clipped')).toBe(true);

    const noRed = run(synth({ seconds: 15, dcRed: 0, mRed: 0 }));
    expect(noRed.filter((x) => x.t >= 10).every((x) => x.e.reject === 'no_signal')).toBe(true);

    const flat = run(synth({ seconds: 15, mIr: 0.0001, mRed: 0.00006 }));
    expect(flat.filter((x) => x.t >= 10).every((x) => x.e.reject === 'weak')).toBe(true);
  });

  it('restarts on a gap in the timestamps, and on time going backwards (a replay seek)', () => {
    const t = new Spo2Tracker();
    const s = synth({ seconds: 30 });
    let last: Spo2Estimate | null = null;
    for (let i = 0; i < 1500; i++) {
      const e = t.push(s[i].timestamp, s[i].sample.ir, s[i].sample.red, FS);
      if (e) last = e;
    }
    expect(last?.reject).toBe(null);
    // 2 s of nothing, then the stream resumes: warming again.
    const e1 = [];
    for (let i = 1700; i < 1900; i++) {
      const e = t.push(s[i].timestamp, s[i].sample.ir, s[i].sample.red, FS);
      if (e) e1.push(e);
    }
    expect(e1.length).toBe(2);
    expect(e1.every((e) => e.reject === 'warming')).toBe(true);
    // Back to the start.
    const e2 = [];
    for (let i = 0; i < 200; i++) {
      const e = t.push(s[i].timestamp, s[i].sample.ir, s[i].sample.red, FS);
      if (e) e2.push(e);
    }
    expect(e2.every((e) => e.reject === 'warming')).toBe(true);
  });

  it('reads the sample rate off the timestamps, ignoring gaps', () => {
    const ts = Array.from({ length: 500 }, (_, i) => i * 10 + (i > 250 ? 2000 : 0));
    expect(sampleRateFromTimestamps(ts)).toBeCloseTo(100, 6);
    expect(sampleRateFromTimestamps([])).toBe(0);
  });
});

describe('calibrating the earclip against a reference oximeter', () => {
  const est = (t: number, r: number, reject: Spo2Estimate['reject'] = null) =>
    ({ timestamp: t, value: { r, corr: 0.99, piIr: 1, piRed: 0.6, reject } });

  it('pairs each shown estimate with the nearest reference second, within 1.5 s', () => {
    const e = [est(1000, 0.6), est(2000, 0.61), est(3000, 0.62, 'motion'), est(9000, 0.6)];
    const ref = [{ timestamp: 1400, spo2: 97 }, { timestamp: 2300, spo2: 98 }, { timestamp: 3000, spo2: 96 }, { timestamp: 5000, spo2: null }];
    expect(pairWithReference(e, ref)).toEqual([{ r: 0.6, ref: 97 }, { r: 0.61, ref: 98 }]);
    expect(pairWithReference(e, [])).toEqual([]);
  });

  it('fits only a when the reference barely moves (rest), keeping b', () => {
    // True line 112 - 25 R; at rest the reference sits at 96-98.
    const pairs = Array.from({ length: 60 }, (_, i) => {
      const r = 0.58 + 0.01 * (i % 3);
      return { r, ref: Math.round(112 - 25 * r) };
    });
    const fit = fitSpo2Cal(pairs, SPO2_CAL_TEXTBOOK);
    expect(fit?.mode).toBe('offset');
    expect(fit?.cal.b).toBe(25);
    expect(fit?.cal.a).toBeCloseTo(112, 0);
    expect(fit?.n).toBe(60);
    expect(fit?.rmse).toBeLessThan(0.6);
  });

  it('fits a and b when the reference spans 4+ points (a desaturation)', () => {
    // True line 104 - 17 R across 90-97 %.
    const pairs = Array.from({ length: 80 }, (_, i) => {
      const r = 0.4 + (0.8 - 0.4) * (i / 79);
      return { r, ref: 104 - 17 * r };
    });
    const fit = fitSpo2Cal(pairs, SPO2_CAL_TEXTBOOK);
    expect(fit?.mode).toBe('line');
    expect(fit?.cal.a).toBeCloseTo(104, 0);
    expect(fit?.cal.b).toBeCloseTo(17, 0);
    expect(fit?.rmse).toBeLessThan(0.1);
  });

  it('keeps b when a fitted slope is implausible, and needs 30 pairs at all', () => {
    const flatRatio = Array.from({ length: 40 }, (_, i) => ({ r: 0.6 + (i % 2) * 1e-4, ref: 90 + (i % 10) }));
    const fit = fitSpo2Cal(flatRatio, { a: 110, b: 25 });
    expect(fit?.mode).toBe('offset');
    expect(fit?.cal.b).toBe(25);
    expect(fitSpo2Cal(flatRatio.slice(0, 29), SPO2_CAL_TEXTBOOK)).toBeNull();
  });
});
