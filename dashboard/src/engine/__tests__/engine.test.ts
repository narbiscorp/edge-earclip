/*
 * engine.test.ts — port of the key SyntheticSignals / NarbisCoherenceEngineTests cases.
 * Validates the math port: coherence ratio on a known signal, the bidirectional artifact
 * gate, ACC respiration recovery, and Mode B convergence + the verification gate.
 */
import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_TUNABLES } from '../tunables';
import { IBIIngest, type IBIEntry } from '../ibiIngest';
import { AdaptiveDRRGate } from '../adaptiveDrrGate';
import { LombScargleCore } from '../lombScargleCore';
import { RespirationFromACC } from '../respirationFromAcc';
import { ResonanceController } from '../resonanceController';
import { FollowPacer } from '../followPacer';
import { CoherenceEngine, evaluateModeCGate, type LensState } from '../coherenceEngine';

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

// ──────────────────────────────────────────────────────────────────────────────
// Mode C "Settle & Find" — Mode A warm-up → stability+ACC gate → seeded Mode B search.
// ──────────────────────────────────────────────────────────────────────────────

/** Build ~1 Hz warm-up gate samples filling the trailing stability window (newest at nowS). */
function buildWarmup(bpmAt: (i: number) => number, ok: boolean, nowS: number, windowS: number) {
  const n = Math.ceil(windowS) + 1;
  const resp: Array<{ s: number; bpm: number }> = [];
  const acc: Array<{ s: number; ok: boolean }> = [];
  for (let i = 0; i < n; i++) {
    const s = nowS - (n - 1 - i); // 1 Hz, s = nowS-(n-1) .. nowS
    resp.push({ s, bpm: bpmAt(i) });
    acc.push({ s, ok });
  }
  return { resp, acc };
}

describe('evaluateModeCGate — Mode C warm-up gate', () => {
  const t = { ...DEFAULT_TUNABLES }; // warmupS 120, warmupMaxS 240, window 30, sd 0.4
  const W = t.modeCStabilityWindowS;
  // Steady breather ≈ `rate` (tiny ±0.05 wobble keeps SD well under modeCStabilityBpmSd).
  const steady = (rate: number, ok = true) =>
    buildWarmup((i) => rate + (i % 2 ? 0.05 : -0.05), ok, 1000, W);

  it('transitions only with confident ACC, past warmupS, and stable — seeded at the settled rate', () => {
    const { resp, acc } = steady(5.5);
    // Stable + ACC confident but BEFORE warmupS → no transition yet.
    const early = evaluateModeCGate(resp, acc, t.modeCWarmupS - 1, 1000, t);
    expect(early.accConfident).toBe(true);
    expect(early.stable).toBe(true);
    expect(early.canTransition).toBe(false);
    // At warmupS, stable → transition; seed ≈ the settled rate.
    const go = evaluateModeCGate(resp, acc, t.modeCWarmupS, 1000, t);
    expect(go.canTransition).toBe(true);
    expect(Math.abs(go.seedBPM - 5.5)).toBeLessThan(0.2);
  });

  it('clamps the seed into the resonance search band', () => {
    const { resp, acc } = steady(9.0); // settled above searchHiBPM (7.5)
    const go = evaluateModeCGate(resp, acc, t.modeCWarmupS, 1000, t);
    expect(go.canTransition).toBe(true);
    expect(go.seedBPM).toBe(t.searchHiBPM);
  });

  it('never transitions without confident ACC — even far past the cap (ACC is mandatory)', () => {
    const resp = steady(5.5).resp;
    const accOff = buildWarmup(() => 5.5, false, 1000, W).acc; // ACC never confident
    const g = evaluateModeCGate(resp, accOff, t.modeCWarmupMaxS * 100, 1000, t);
    expect(g.accConfident).toBe(false);
    expect(g.canTransition).toBe(false);
  });

  it('restless breather (high SD) + confident ACC: no transition before the cap, transitions AT the cap', () => {
    // Alternating 4.5/7.0 → SD far above modeCStabilityBpmSd (0.4).
    const { resp, acc } = buildWarmup((i) => (i % 2 ? 7.0 : 4.5), true, 1000, W);
    const beforeCap = evaluateModeCGate(resp, acc, t.modeCWarmupMaxS - 1, 1000, t);
    expect(beforeCap.accConfident).toBe(true);
    expect(beforeCap.stable).toBe(false);
    expect(beforeCap.canTransition).toBe(false); // unstable and not yet at the cap
    const atCap = evaluateModeCGate(resp, acc, t.modeCWarmupMaxS, 1000, t);
    expect(atCap.stable).toBe(false); // cap relaxes ONLY stability — ACC still required (and present)
    expect(atCap.canTransition).toBe(true);
  });
});

describe('ResonanceController — Mode C seeded search', () => {
  it('a controller seeded at the settled rate hill-climbs to the resonance peak and locks', () => {
    // Mirrors the Mode B convergence test, but SEEDED away from the true RF — exactly what the
    // Mode C handoff does: `new ResonanceController(t, settledRate)`.
    const seed = 6.5;
    const ctrl = new ResonanceController(DEFAULT_TUNABLES, seed);
    expect(ctrl.commandedBPM).toBe(seed);
    const RF = 5.5;
    const curve = (b: number) => 100 - 8 * (b - RF) * (b - RF);
    let nowS = 0;
    for (let i = 0; i < 600 && ctrl.state !== 'maintaining'; i++) {
      nowS += 10;
      const b = ctrl.commandedBPM;
      ctrl.onBreathCycle({
        cycleAmplitude: curve(b),
        measuredBPM: b,
        respConfidence: 1,
        pacedBPM: b,
        dwellArtifactClean: true,
        nowS,
      });
    }
    expect(ctrl.state).toBe('maintaining');
    expect(Math.abs(ctrl.lockedRF - RF)).toBeLessThan(0.6);
  });
});

/** Feed one second (50 samples @ 50 Hz) of a clean breathing tone into the engine's ACC channel. */
function feedAccSecond(engine: CoherenceEngine, sec: number, freqHz: number): void {
  const fs = 50;
  const n = 50;
  const tArrivalS = sec + 1;
  const samples: Array<{ x: number; y: number; z: number }> = [];
  for (let i = 0; i < n; i++) {
    const tS = tArrivalS - (n - 1 - i) / fs; // matches onAccPacket's per-sample stamping
    samples.push({ x: 1000 + 50 * Math.sin(2 * Math.PI * freqHz * tS), y: 0, z: 0 });
  }
  engine.onAccPacket(samples, tArrivalS);
}

describe('CoherenceEngine — Mode C engine integration', () => {
  it('Mode C warm-up is byte-for-byte Mode A (identical pacer + lens state), and with no ACC it never leaves warm-up', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date', 'performance'] });
    try {
      const tun = { ...DEFAULT_TUNABLES };
      const lensA: LensState[] = [];
      const lensC: LensState[] = [];
      const engineA = new CoherenceEngine();
      const engineC = new CoherenceEngine();
      engineA.start({ mode: 'modeA', source: 'polarH10', tunables: tun, onLens: (s) => lensA.push(s) });
      engineC.start({ mode: 'modeC', source: 'polarH10', tunables: tun, onLens: (s) => lensC.push(s) });

      // Identical clean 6-br/min RSA beats to BOTH; NO ACC fed (so Mode C's gate can never pass).
      const beats = modulatedBeats(900, 120, 0.1, 130);
      let bi = 0;
      for (let sec = 0; sec < 130; sec++) {
        while (bi < beats.length && beats[bi].beatTimeS <= sec) {
          engineA.onRR(beats[bi].rrMs, 100, beats[bi].beatTimeS);
          engineC.onRR(beats[bi].rrMs, 100, beats[bi].beatTimeS);
          bi++;
        }
        vi.advanceTimersByTime(1000); // fires tick1Hz + ~12 lensTicks on both engines
      }

      // Mode C stayed in warm-up the whole time (no confident ACC) ...
      expect(engineC.getStatus().modeCPhase).toBe('warmup');
      expect(engineC.getStatus().modeBState).toBeNull(); // no controller → no stale resonance data
      // ... and emitted an identical lens-state stream to Mode A — proving warm-up ≡ Mode A.
      expect(lensC.length).toBeGreaterThan(0);
      expect(lensC).toEqual(lensA);
      expect(engineC.getStatus().pacerBpm).toBe(engineA.getStatus().pacerBpm);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Mode C: gate fires into a verified search, then an unverifiable search aborts back to warm-up (never stuck)', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date', 'performance'] });
    try {
      const tun = {
        ...DEFAULT_TUNABLES,
        modeCWarmupS: 1, // time gate trivially satisfied; ACC confidence is the binding constraint
        modeCWarmupMaxS: 2,
        modeCStabilityWindowS: 4,
        modeCStabilityBpmSd: 2.0, // generous → the steady detected rate easily reads "stable"
        dwellBreaths: 2,
        dwellEstimateFraction: 0.5,
        maxUnverifiedDwells: 1, // abort after the first unverifiable dwell
        respConfidenceMin: 0.2,
      };
      const engine = new CoherenceEngine();
      engine.start({ mode: 'modeC', source: 'polarH10', tunables: tun, onLens: () => {} });

      // Beats imply a ~6 br/min detected rate (the seed); ACC reports ~4.5 br/min — off by 1.5,
      // beyond respVerifyToleranceBPM, so every dwell is unverifiable → the search must give up.
      const beats = modulatedBeats(900, 120, 0.1, 210);
      let bi = 0;
      let sawSearching = false;
      let returnedToWarmupAfterSearch = false;
      for (let sec = 0; sec < 200; sec++) {
        while (bi < beats.length && beats[bi].beatTimeS <= sec) {
          engine.onRR(beats[bi].rrMs, 100, beats[bi].beatTimeS);
          bi++;
        }
        feedAccSecond(engine, sec, 0.075); // ~4.5 br/min, confident but mismatched
        vi.advanceTimersByTime(1000);
        const phase = engine.getStatus().modeCPhase;
        if (phase === 'searching') sawSearching = true;
        if (sawSearching && phase === 'warmup') returnedToWarmupAfterSearch = true;
      }

      expect(sawSearching).toBe(true); // the ACC gate passed and a seeded search started
      expect(returnedToWarmupAfterSearch).toBe(true); // the abort dropped back to warm-up, not stuck
    } finally {
      vi.useRealTimers();
    }
  });
});
