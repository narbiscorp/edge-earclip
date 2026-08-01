/*
 * demo.ts — synthetic Polar H10, for when there is no strap on the bench.
 *
 * Enabled with ?demo=1. It drives the REAL PolarH10 singleton's event surface
 * rather than a parallel code path, so everything downstream — the log, the
 * metrics worker, the Coherence Engine, the CSV writers — runs exactly as it
 * does with hardware. If the demo looks right, the plumbing is right.
 *
 * The signal is physiologically shaped rather than random: a resting heart rate
 * with respiratory sinus arrhythmia at a slow breathing rate, a slower
 * Mayer-wave component, and an occasional ectopic beat so the artifact path is
 * exercised. The accelerometer carries gravity, the chest-wall breathing
 * excursion, and a small cardiac ballistogram. This is NOT recorded human data
 * and must never be presented as a measurement.
 */
import { polarH10 } from '../ble/polarH10';
import type { PolarAccEvent, PolarBeatEvent } from '../ble/polarH10';

const ACC_RATE_HZ = 50;
const ACC_FRAME_MS = 200; // 10 samples per frame, like the real stream batches
const HR_NOTIFY_MS = 1000;

const BASE_HR_BPM = 62;
const BREATH_BPM = 6; // slow, resonant breathing — makes RSA obvious
const RSA_AMPLITUDE_MS = 60;
const MAYER_AMPLITUDE_MS = 14;
const NOISE_MS = 6;
const ECTOPIC_EVERY = 180; // beats between injected ectopics

/** Deterministic PRNG so two runs of the demo look the same — an unreproducible
 * demo is useless for checking whether a change altered behaviour. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export interface DemoHandle {
  stop: () => void;
}

export function startDemo(): DemoHandle {
  const rng = makeRng(0xc0ffee);
  const t0 = Date.now();
  const breathHz = BREATH_BPM / 60;

  let beatCount = 0;
  let nextBeatAt = t0 + 800;
  let pendingRr: number[] = [];
  let pendingTs: number[] = [];
  let lastNotify = t0;

  const dispatch = <T>(type: string, detail: T): void => {
    polarH10.dispatchEvent(new CustomEvent<T>(type, { detail }));
  };

  dispatch('connected', { name: 'Polar H10 (demo)' });
  dispatch('accInfo', {
    message: 'demo mode — synthetic signal, not a measurement',
    level: 'warn' as const,
  });

  /** RR for a beat occurring at wall-clock `t`. */
  const rrAt = (t: number): number => {
    const s = (t - t0) / 1000;
    const base = 60000 / BASE_HR_BPM;
    const rsa = RSA_AMPLITUDE_MS * Math.sin(2 * Math.PI * breathHz * s);
    const mayer = MAYER_AMPLITUDE_MS * Math.sin(2 * Math.PI * 0.04 * s + 1.1);
    const noise = (rng() - 0.5) * 2 * NOISE_MS;
    // A slow drift so the metrics are not perfectly stationary.
    const drift = 25 * Math.sin(2 * Math.PI * s / 420);
    return base + rsa + mayer + noise + drift;
  };

  const beatTimer = setInterval(() => {
    const now = Date.now();
    // Advance the beat clock up to now, collecting each beat that fell due.
    while (nextBeatAt <= now) {
      beatCount += 1;
      let rr = rrAt(nextBeatAt);
      if (beatCount % ECTOPIC_EVERY === 0) {
        // A premature beat: short interval, then the compensatory pause lands
        // on the following one. Both should be flagged, neither dropped.
        rr *= 0.55;
      }
      pendingRr.push(rr);
      pendingTs.push(nextBeatAt);
      nextBeatAt += rr;
    }

    if (now - lastNotify >= HR_NOTIFY_MS && pendingRr.length > 0) {
      lastNotify = now;
      const rrs = pendingRr;
      const tss = pendingTs;
      pendingRr = [];
      pendingTs = [];
      const meanRr = rrs.reduce((a, b) => a + b, 0) / rrs.length;
      dispatch<PolarBeatEvent>('beatReceived', {
        bpm: Math.round(60000 / meanRr),
        rrIntervals_ms: rrs.map((v) => Math.round(v)),
        beatTimestamps: tss,
        timestamp: now,
      });
    }
  }, 100);

  let accCursor = t0;
  const accTimer = setInterval(() => {
    const now = Date.now();
    const samples: Array<{ x: number; y: number; z: number }> = [];
    const step = 1000 / ACC_RATE_HZ;
    while (accCursor + step <= now) {
      accCursor += step;
      const s = (accCursor - t0) / 1000;
      const breath = Math.sin(2 * Math.PI * breathHz * s);
      // Cardiac ballistogram rides at the current heart rate.
      const cardiac = Math.sin(2 * Math.PI * (BASE_HR_BPM / 60) * s);
      samples.push({
        x: Math.round(-38 + 26 * breath + 5 * cardiac + (rng() - 0.5) * 6),
        y: Math.round(112 + 17 * breath + 3 * cardiac + (rng() - 0.5) * 6),
        // Gravity sits on Z for a strap worn upright.
        z: Math.round(978 + 9 * breath + 4 * cardiac + (rng() - 0.5) * 8),
      });
    }
    if (samples.length === 0) return;
    dispatch<PolarAccEvent>('accReceived', {
      samples,
      lastSampleMs: accCursor,
      sampleRateHz: ACC_RATE_HZ,
    });
  }, ACC_FRAME_MS);

  return {
    stop: () => {
      clearInterval(beatTimer);
      clearInterval(accTimer);
      dispatch('disconnected', { reason: 'user' });
    },
  };
}

/** True when the page was opened with ?demo=1 (or ?demo). */
export function demoRequested(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).has('demo');
}
