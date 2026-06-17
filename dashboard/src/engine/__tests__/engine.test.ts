/*
 * engine.test.ts — port of the key SyntheticSignals / NarbisCoherenceEngineTests cases.
 * Validates the math port: coherence ratio on a known signal, the bidirectional artifact
 * gate, ACC respiration recovery, and Mode B convergence + the verification gate.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_TUNABLES } from '../tunables';
import { IBIIngest, type IBIEntry } from '../ibiIngest';
import { AdaptiveDRRGate } from '../adaptiveDrrGate';
import { LombScargleCore } from '../lombScargleCore';
import { RespirationFromACC } from '../respirationFromAcc';
import { ResonanceController } from '../resonanceController';
import { FollowPacer } from '../followPacer';
import { smoothnessPriorsDetrend, welchCoherence } from '../dsp';
import { computeBreathHeartCoherence } from '../breathHeartCoherence';

/** Beats whose RR is sinusoidally modulated at `freqHz` (a clean RSA tone). */
function modulatedBeats(meanRrMs: number, ampMs: number, freqHz: number, durationS: number): IBIEntry[] {
  const beats: IBIEntry[] = [];
  let t = 0;
  while (t < durationS) {
    const rr = meanRrMs + ampMs * Math.sin(2 * Math.PI * freqHz * t);
    t += rr / 1000;
    beats.push({ beatTimeS: t, rrMs: rr });
  }
  return beats;
}

const mean = (a: number[]): number => a.reduce((s, v) => s + v, 0) / a.length;
const variance = (a: number[]): number => {
  const m = mean(a);
  return a.reduce((s, v) => s + (v - m) * (v - m), 0) / a.length;
};
const std = (a: number[]): number => Math.sqrt(variance(a));

/** Deterministic LCG so the "noisy" series is identical every run (no Math.random flakiness). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0x100000000; // [0,1)
  };
}

/** modulatedBeats with a small white jitter (±noiseMs) added to each RR, seeded for determinism. */
function modulatedBeatsNoisy(
  meanRrMs: number,
  ampMs: number,
  freqHz: number,
  durationS: number,
  noiseMs: number,
  seed: number,
): IBIEntry[] {
  const rnd = lcg(seed);
  const beats: IBIEntry[] = [];
  let t = 0;
  while (t < durationS) {
    const rr = meanRrMs + ampMs * Math.sin(2 * Math.PI * freqHz * t) + (rnd() - 0.5) * 2 * noiseMs;
    t += rr / 1000;
    beats.push({ beatTimeS: t, rrMs: rr });
  }
  return beats;
}

/** RR whose VALUE at each beat time is exactly in phase with sin(2π f t) — so the cross-phase vs an
 * ACC window built on the same clock is ~0. (modulatedBeats evaluates the sine at the PRE-step time,
 * which adds a ~1-beat lag that would bias the cross-spectrum phase readout.) Uniform spacing is fine
 * here: the cross-spectrum resamples to a uniform grid regardless. */
function inPhaseBeats(meanRrMs: number, ampMs: number, freqHz: number, durationS: number): IBIEntry[] {
  const beats: IBIEntry[] = [];
  let t = 0;
  while (t < durationS) {
    t += meanRrMs / 1000;
    if (t >= durationS) break;
    beats.push({ beatTimeS: t, rrMs: meanRrMs + ampMs * Math.sin(2 * Math.PI * freqHz * t) });
  }
  return beats;
}

/** Absolute-time ACC vector-magnitude window oscillating at `freqHz` (mag stays positive). Same
 * shape RespirationFromACC.magnitudeWindow() returns. */
function accWindow(
  freqHz: number,
  durationS: number,
  fs: number,
  t0: number,
): { s: number[]; mag: number[] } {
  const s: number[] = [];
  const mag: number[] = [];
  const N = Math.floor(durationS * fs);
  for (let i = 0; i < N; i++) {
    const tS = t0 + i / fs;
    s.push(tS);
    mag.push(1000 + 50 * Math.sin(2 * Math.PI * freqHz * tS));
  }
  return { s, mag };
}

describe('LombScargleCore — coherence ratio', () => {
  const ls = new LombScargleCore(DEFAULT_TUNABLES);

  it('recovers a pure 0.1 Hz peak with a high coherence ratio', () => {
    const r = ls.compute(modulatedBeats(1000, 60, 0.1, 70));
    expect(r).not.toBeNull();
    expect(r!.respPeakHz).toBeGreaterThan(0.08);
    expect(r!.respPeakHz).toBeLessThan(0.12);
    expect(r!.cr).toBeGreaterThan(0.5);
    expect(r!.cohPercent).toBeGreaterThan(10);
  });

  it('reports a much lower CR for a non-oscillating (flat) series', () => {
    const tone = ls.compute(modulatedBeats(1000, 60, 0.1, 70))!;
    const flat: IBIEntry[] = [];
    let t = 0;
    for (let i = 0; i < 70; i++) {
      const rr = 1000 + (i % 2 ? 1 : -1); // tiny alternation → power near Nyquist, not in LF
      t += rr / 1000;
      flat.push({ beatTimeS: t, rrMs: rr });
    }
    const r = ls.compute(flat)!;
    expect(r.cr).toBeLessThan(tone.cr);
  });
});

describe('IBIIngest — bidirectional artifact gate', () => {
  it('rejects a missed-beat double and an ectopic short, keeps clean beats', () => {
    const ing = new IBIIngest(DEFAULT_TUNABLES);
    let nowS = 0;
    for (let i = 0; i < 30; i++) {
      nowS += 1.0;
      ing.push(1000, 100, nowS);
    }
    const before = ing.window(10_000).length;
    expect(before).toBe(30);

    nowS += 2.0;
    expect(ing.push(2000, 100, nowS)).toBe(false); // missed-beat double
    nowS += 0.5;
    expect(ing.push(500, 100, nowS)).toBe(false); // ectopic short
    nowS += 1.0;
    expect(ing.push(1000, 100, nowS)).toBe(true); // clean beat still admitted

    expect(ing.window(10_000).length).toBe(before + 1);
  });

  it('rejects out-of-bounds and low-confidence beats', () => {
    const ing = new IBIIngest(DEFAULT_TUNABLES);
    expect(ing.push(100, 100, 1)).toBe(false); // < 250 ms
    expect(ing.push(3000, 100, 2)).toBe(false); // > 2500 ms
    expect(ing.push(1000, 10, 3)).toBe(false); // confidence < threshold
  });

  it('does NOT reject a smooth large RSA swing (the false-positive bug this gate fixes)', () => {
    // 900 ± 150 ms at 0.1 Hz — a big but physiological deep-breathing swing (≈57–80 bpm).
    // The old fixed [0.6,1.4]×median de-spiker mislabeled these as "ectopic"; the adaptive
    // gate must pass every one because the per-beat dRR stays well under the threshold.
    const ing = new IBIIngest(DEFAULT_TUNABLES);
    const beats = modulatedBeats(900, 150, 0.1, 60);
    for (const b of beats) ing.push(b.rrMs, 100, b.beatTimeS);
    expect(ing.window(10_000).length).toBe(beats.length);
  });
});

describe('AdaptiveDRRGate — shared artifact gate', () => {
  it('passes a smooth large RSA swing but still catches a lone double / ectopic short', () => {
    const gate = new AdaptiveDRRGate(DEFAULT_TUNABLES.dRRFloorMs);
    let rejected = 0;
    for (const b of modulatedBeats(900, 150, 0.1, 60)) {
      if (!gate.accept(b.rrMs)) rejected += 1;
    }
    expect(rejected).toBe(0); // no RSA clipping

    expect(gate.accept(1700)).toBe(false); // missed-beat double
    expect(gate.accept(400)).toBe(false); // ectopic short (lastRR not advanced by the reject)
    expect(gate.accept(900)).toBe(true); // clean beat resumes
  });
});

describe('RespirationFromACC — independent respiration channel', () => {
  it('recovers a 0.1 Hz (6 BPM) magnitude oscillation', () => {
    const resp = new RespirationFromACC(DEFAULT_TUNABLES);
    const fs = DEFAULT_TUNABLES.accSampleHz;
    const f = 0.1; // 6 breaths/min
    for (let i = 0; i < fs * 45; i++) {
      const tS = i / fs;
      const x = 1000 + 50 * Math.sin(2 * Math.PI * f * tS); // stays positive → |mag| oscillates at f
      resp.push(x, 0, 0, tS);
    }
    const est = resp.estimate();
    expect(est).not.toBeNull();
    expect(est!.bpm).toBeGreaterThan(5.5);
    expect(est!.bpm).toBeLessThan(6.5);
    expect(est!.confidence).toBeGreaterThan(0.3);
  });

  it('locks onto the breathing peak, not low-frequency body sway (Mode B baseline fix)', () => {
    const resp = new RespirationFromACC(DEFAULT_TUNABLES);
    const fs = DEFAULT_TUNABLES.accSampleHz;
    // Broadband postural sway below the breathing rate (many small low-freq components, like real
    // drift) under a clean 6 br/min (0.1 Hz) tone. Total sway energy exceeds the breathing tone but
    // is spread thin — the old max-power picker latched onto it (~3.9 br/min); prominence returns ~6.
    const swayFreqs = [0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.075];
    for (let i = 0; i < fs * 45; i++) {
      const tS = i / fs;
      let sway = 0;
      for (const sf of swayFreqs) sway += 22 * Math.sin(2 * Math.PI * sf * tS);
      resp.push(1000 + sway + 34 * Math.sin(2 * Math.PI * 0.1 * tS), 0, 0, tS);
    }
    const est = resp.estimate();
    expect(est).not.toBeNull();
    expect(est!.bpm).toBeGreaterThan(5.0);
    expect(est!.bpm).toBeLessThan(7.0);
    expect(est!.confidence).toBeGreaterThanOrEqual(DEFAULT_TUNABLES.respConfidenceMin);
  });
});

describe('ResonanceController — Mode B', () => {
  it('hill-climbs to the resonance peak and locks (maintaining)', () => {
    const ctrl = new ResonanceController(DEFAULT_TUNABLES);
    const RF = 5.5;
    const curve = (b: number) => 100 - 8 * (b - RF) * (b - RF); // unimodal, max at RF
    let nowS = 0;
    for (let i = 0; i < 600 && ctrl.state !== 'maintaining'; i++) {
      nowS += 10;
      const b = ctrl.commandedBPM;
      ctrl.onBreathCycle({
        cycleAmplitude: curve(b),
        measuredBPM: b, // user follows the cue exactly
        respConfidence: 1,
        pacedBPM: b,
        dwellArtifactClean: true,
        nowS,
      });
    }
    expect(ctrl.state).toBe('maintaining');
    expect(Math.abs(ctrl.lockedRF - RF)).toBeLessThan(0.6);
  });

  it('aborts the search when respiration can never be verified (Mayer-wave defense)', () => {
    const ctrl = new ResonanceController(DEFAULT_TUNABLES);
    let nowS = 0;
    for (let i = 0; i < 200 && !ctrl.searchAborted; i++) {
      nowS += 10;
      const b = ctrl.commandedBPM;
      ctrl.onBreathCycle({
        cycleAmplitude: 50,
        measuredBPM: b + 1.0, // measured rate always off by 1 BPM (> tolerance)
        respConfidence: 1,
        pacedBPM: b,
        dwellArtifactClean: true,
        nowS,
      });
    }
    expect(ctrl.searchAborted).toBe(true);
    expect(ctrl.unverifiedDwells).toBeGreaterThanOrEqual(DEFAULT_TUNABLES.maxUnverifiedDwells);
  });
});

describe('FollowPacer — two-speed slew', () => {
  it('snaps to the target after a sustained large error instead of crawling', () => {
    const pacer = new FollowPacer(DEFAULT_TUNABLES);
    pacer.snapToBPM(6); // current = 6 BPM (quintet 30)
    pacer.setTargetBPM(9); // 3 BPM away — ≥ jump threshold
    pacer.latch(); // breath 1 — still gliding (sustain not yet met)
    expect(pacer.currentQuintet).toBeLessThan(45);
    pacer.setTargetBPM(9);
    pacer.latch(); // breath 2 — sustain met → snap straight to 9 BPM
    expect(pacer.currentQuintet).toBe(45);
  });

  it('does NOT snap on a single-breath spike (glides by the slew limit only)', () => {
    const pacer = new FollowPacer(DEFAULT_TUNABLES);
    pacer.snapToBPM(6); // quintet 30
    pacer.setTargetBPM(9); // a one-breath jump-sized error
    pacer.latch();
    expect(pacer.currentQuintet).toBe(30 + DEFAULT_TUNABLES.pacerSlewQuintet);
  });
});

describe('smoothnessPriorsDetrend (#1) — trend removal + LS detrend path', () => {
  it('removes a slow linear+DC trend while preserving a 0.1 Hz tone', () => {
    const N = 100;
    const z: number[] = [];
    for (let i = 0; i < N; i++) z.push(800 + 1.5 * i + 40 * Math.sin(2 * Math.PI * 0.1 * i));
    const d = smoothnessPriorsDetrend(z, 500);
    expect(d.length).toBe(N);
    expect(Math.abs(mean(d))).toBeLessThan(1); // ramp + DC removed (a line is in D2's null space)
    expect(std(d)).toBeGreaterThan(0.85 * (40 / Math.SQRT2)); // 0.1 Hz tone preserved (RMS ≈ amp/√2)
    expect(Number.isFinite(d[0]) && Number.isFinite(d[N - 1])).toBe(true); // boundary rows stable
  });

  it('raises the coherence ratio vs the mean-only path when the RR has slow wander', () => {
    // RSA tone + a slow linear ramp on RR (drift). Detrending removes the ramp's VLF leakage that
    // would otherwise inflate the CR `total` term and depress CR. Single-segment isolates #1 from #2.
    const trended = modulatedBeats(1000, 60, 0.1, 80).map((b, i) => ({
      beatTimeS: b.beatTimeS,
      rrMs: b.rrMs + 0.9 * i,
    }));
    const on = new LombScargleCore({ ...DEFAULT_TUNABLES, detrendEnabled: 1, spectralSegments: 1 }).compute(trended);
    const off = new LombScargleCore({ ...DEFAULT_TUNABLES, detrendEnabled: 0, spectralSegments: 1 }).compute(trended);
    expect(on).not.toBeNull();
    expect(off).not.toBeNull();
    expect(on!.respPeakHz).toBeGreaterThan(0.08);
    expect(on!.respPeakHz).toBeLessThan(0.12);
    expect(on!.cr).toBeGreaterThan(off!.cr);
  });
});

describe('Welch-averaged LS (#2) — variance reduction', () => {
  it('averaged (segments=3) CR is steadier across overlapping windows than single (segments=1)', () => {
    // A noisy 0.1 Hz tone (seeded). Averaging overlapping sub-windows should reduce the run-to-run CR
    // variance vs a single periodogram. Both detrend (default) — only #2 differs.
    const all = modulatedBeatsNoisy(1000, 50, 0.1, 240, 12, 0xc0ffee);
    const lsAvg = new LombScargleCore({ ...DEFAULT_TUNABLES, spectralSegments: 3, spectralOverlapPct: 50 });
    const lsOne = new LombScargleCore({ ...DEFAULT_TUNABLES, spectralSegments: 1 });
    const W = DEFAULT_TUNABLES.coherenceWindowS;
    const crAvg: number[] = [];
    const crOne: number[] = [];
    for (let start = 0; start + W <= 220; start += 8) {
      const win = all.filter((b) => b.beatTimeS >= start && b.beatTimeS < start + W);
      const a = lsAvg.compute(win);
      const o = lsOne.compute(win);
      if (a) crAvg.push(a.cr);
      if (o) crOne.push(o.cr);
    }
    expect(crAvg.length).toBeGreaterThan(5);
    expect(crOne.length).toBeGreaterThan(5);
    expect(variance(crAvg)).toBeLessThan(variance(crOne));
    // sanity: the peak is still recovered on a representative window
    const repr = lsAvg.compute(all.filter((b) => b.beatTimeS >= 0 && b.beatTimeS < W))!;
    expect(repr.respPeakHz).toBeGreaterThan(0.08);
    expect(repr.respPeakHz).toBeLessThan(0.12);
  });
});

describe('computeBreathHeartCoherence (#3) — the Mayer-wave defense', () => {
  const fs = DEFAULT_TUNABLES.accSampleHz;

  it('in-phase RR & ACC at 0.1 Hz → γ²≈1, phase≈0, not confounded', () => {
    const rr = inPhaseBeats(1000, 60, 0.1, 90);
    const acc = accWindow(0.1, 90, fs, 0);
    const bh = computeBreathHeartCoherence(rr, acc, 0.1, 0.1, DEFAULT_TUNABLES);
    expect(bh).not.toBeNull();
    expect(bh!.gammaSq).toBeGreaterThan(0.8);
    expect(Math.abs(bh!.phaseDeg)).toBeLessThan(30);
    expect(bh!.confounded).toBe(false);
  });

  it('breathing ≠ HR rhythm (RR 0.1 Hz, ACC 0.15 Hz) → γ² drops vs the coupled case + confounded', () => {
    // Hold a noisy RR Mayer wave at 0.10 Hz; compare an ACC that MATCHES it (0.10) against one that
    // does NOT (0.15), with independent noise in each channel. The cross-spectral coherence at the
    // breathing frequency must drop sharply when the rhythms differ, and the confound flag must fire
    // on the rate mismatch (the primary Mayer defense). We assert a RELATIVE drop rather than an
    // absolute floor: with only 3 Welch segments the γ² estimator is intentionally higher-variance
    // (3 segments buys the finer resolution the rate comparison needs to tell 0.10 from 0.15 Hz).
    const run = (accHz: number) => {
      const rrNoise = lcg(101);
      const rr = inPhaseBeats(1000, 60, 0.1, 90).map((b) => ({
        beatTimeS: b.beatTimeS,
        rrMs: b.rrMs + (rrNoise() - 0.5) * 2 * 50,
      }));
      const accNoise = lcg(202);
      const a = accWindow(accHz, 90, fs, 0);
      return computeBreathHeartCoherence(
        rr,
        { s: a.s, mag: a.mag.map((m) => m + (accNoise() - 0.5) * 2 * 25) },
        0.1,
        accHz,
        DEFAULT_TUNABLES,
      )!;
    };
    const coupled = run(0.1); // ACC breathing matches the RR rhythm
    const mismatch = run(0.15); // ACC breathing differs from the RR rhythm
    expect(coupled.gammaSq).toBeGreaterThan(0.8);
    expect(mismatch.gammaSq).toBeLessThan(coupled.gammaSq - 0.2); // coherence clearly collapses
    expect(coupled.confounded).toBe(false); // same rate, strong coupling
    expect(mismatch.confounded).toBe(true); // |6 − 9| br/min > respVerifyToleranceBPM
  });

  it('returns null when no ACC window is available (host falls back to the single-signal CR)', () => {
    const rr = inPhaseBeats(1000, 60, 0.1, 90);
    expect(computeBreathHeartCoherence(rr, { s: [], mag: [] }, 0.1, 0.1, DEFAULT_TUNABLES)).toBeNull();
  });
});

describe('welchCoherence — single-segment guard', () => {
  it('returns null for a single segment (never a degenerate γ²=1)', () => {
    const n = 64;
    const x: number[] = [];
    for (let i = 0; i < n; i++) x.push(Math.sin(2 * Math.PI * 0.1 * (i / 4)));
    expect(welchCoherence(x, x.slice(), 4, n, 0)).toBeNull(); // one segment → refuse
    const multi = welchCoherence(x, x.slice(), 4, Math.floor(n / 2), 0.5); // 3 segments
    expect(multi).not.toBeNull();
    for (const g of multi!.gammaSq) expect(g).toBeLessThanOrEqual(1 + 1e-9);
  });
});
