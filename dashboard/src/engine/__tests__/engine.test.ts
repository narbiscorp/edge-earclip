/*
 * engine.test.ts — port of the key SyntheticSignals / NarbisCoherenceEngineTests cases.
 * Validates the math port: coherence ratio on a known signal, the bidirectional artifact
 * gate, ACC respiration recovery, and Mode B convergence + the verification gate.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_TUNABLES } from '../tunables';
import { IBIIngest, type IBIEntry } from '../ibiIngest';
import { LombScargleCore } from '../lombScargleCore';
import { RespirationFromACC } from '../respirationFromAcc';
import { ResonanceController } from '../resonanceController';

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
