/*
 * breathHeartCoherence.ts — Mode A's REAL coherence: magnitude-squared coherence γ²(f) between
 * respiration (the H10 accelerometer vector-magnitude) and heart rate (the detrended RR series).
 * This is the coherence the HRV-biofeedback literature (and Gevirtz) means — ≈1 with ≈0° phase at
 * resonance — as opposed to the single-signal spectral concentration the field-standard CR measures.
 * Pure and testable; the engine calls it at 1 Hz whenever an H10 ACC stream is present.
 */
import type { CoherenceTunables } from './tunables';
import { cubicResample, welchCoherence, smoothnessPriorsDetrend } from './dsp';

/** γ² at the respiration peak below this ⇒ HR and breathing are not coherently coupled there → the
 * followed LF rhythm is likely a Mayer-wave / non-respiratory artifact, so the confound flag fires.
 * A module constant (the task specifies only the four spectral tunables); promote to a tunable if the
 * feel pass needs it. 0.5 is the conventional "significant coherence" threshold. */
export const GAMMA2_CONFOUND_FLOOR = 0.5;

/** Common resample rate for the cross-spectrum. Respiration is ≤ ~0.5 Hz, so 4 Hz (Nyquist 2 Hz) is
 * ample headroom while keeping the FFT small. */
const CROSS_FS = 4;

export interface BreathHeartCoherence {
  gammaSq: number; // magnitude-squared coherence at the respiration peak ∈ [0,1]
  phaseDeg: number; // HR–respiration phase at that peak (≈0° at resonance)
  /** The followed LF rate differs from the ACC-measured breathing rate by > tolerance. The engine
   * combines this with the time-SMOOTHED γ² (vs GAMMA2_CONFOUND_FLOOR) for the displayed confound, so
   * a single high-variance γ² tick can't flip the flag. */
  rateMismatch: boolean;
}

/**
 * γ² + phase between heart rate and respiration at the measured breathing frequency, plus the
 * confound flag. Returns null when there is not enough signal to assess (too few beats/ACC samples,
 * insufficient overlap, or < 2 Welch segments) — the host treats null as "can't assess this tick",
 * NOT as confounded, so last-good behavior is preserved.
 */
export function computeBreathHeartCoherence(
  rrBeats: { beatTimeS: number; rrMs: number }[],
  accWin: { s: number[]; mag: number[] },
  lsLfPeakHz: number, // LSResult.respPeakHz — the LF peak the pacer follows
  accRespHz: number, // RespEstimate.bpm / 60 — the trusted (ACC-measured) respiration rate
  t: CoherenceTunables,
): BreathHeartCoherence | null {
  if (rrBeats.length < 20) return null;
  if (accWin.s.length < 16 || accWin.mag.length < 16) return null;
  if (!(accRespHz > 0)) return null;

  // x = HR (detrended RR, same #1 detrend as the single-signal path); y = respiration (ACC mag).
  const rrMs = rrBeats.map((b) => b.rrMs);
  let rrV: number[];
  if (t.detrendEnabled) {
    rrV = smoothnessPriorsDetrend(rrMs, t.detrendLambda);
  } else {
    const m = rrMs.reduce((s, v) => s + v, 0) / rrMs.length;
    rrV = rrMs.map((v) => v - m);
  }
  const rrT = rrBeats.map((b) => b.beatTimeS);

  // Resample both onto a uniform CROSS_FS grid. cubicResample returns absolute-time grids
  // (t[0] === input x[0]); both share the same Date.now epoch, so we align by absolute time below.
  const rx = cubicResample(rrT, rrV, CROSS_FS);
  const ry = cubicResample(accWin.s, accWin.mag, CROSS_FS);
  if (!rx || !ry) return null;

  // Align to the overlapping absolute-time window. Each grid is uniform at dt = 1/CROSS_FS but starts
  // at its own t[0]; snap each start to its nearest integer sample index. Residual misalignment is
  // ≤ 0.5·dt = 0.125 s (≈4.5° phase bias at 0.1 Hz) — acceptable for a gating decision; to remove it,
  // resample both onto one grid anchored at a shared t0 (deferred).
  const t0 = Math.max(rx.t[0], ry.t[0]);
  const t1 = Math.min(rx.t[rx.t.length - 1], ry.t[ry.t.length - 1]);
  if (t1 - t0 < 16 / CROSS_FS) return null; // need ≥16 overlapping samples
  const ix = Math.max(0, Math.round((t0 - rx.t[0]) * CROSS_FS));
  const iy = Math.max(0, Math.round((t0 - ry.t[0]) * CROSS_FS));
  const K = Math.min(rx.v.length - ix, ry.v.length - iy);
  if (K < 16) return null;
  const xA = rx.v.slice(ix, ix + K);
  const yA = ry.v.slice(iy, iy + K);

  // Welch cross-spectrum at ~3 segments / 50% overlap (segLen = floor(K/2) guarantees ≥2 segments
  // down to K=16). welchCoherence returns null on < 2 segments — never a degenerate γ²=1.
  const co = welchCoherence(xA, yA, CROSS_FS, Math.floor(K / 2), 0.5);
  if (!co) return null;

  // Read γ²/phase at the bin nearest the ACC-measured respiration rate (the trusted channel). If the
  // LF peak the pacer follows is actually a Mayer wave, it sits off the true breathing frequency, so
  // γ² HERE is low and the confound fires.
  let bi = 0;
  let best = Infinity;
  for (let i = 0; i < co.freqs.length; i++) {
    const d = Math.abs(co.freqs[i] - accRespHz);
    if (d < best) {
      best = d;
      bi = i;
    }
  }
  const gammaSq = co.gammaSq[bi];
  const phaseDeg = co.phaseDeg[bi];

  // Weak-coupling (γ² < floor) is applied by the engine against the SMOOTHED γ²; here we only report
  // the resolution-independent rate mismatch (the primary Mayer defense).
  const rateMismatch = Math.abs(lsLfPeakHz * 60 - accRespHz * 60) > t.respVerifyToleranceBPM;
  return { gammaSq, phaseDeg, rateMismatch };
}
