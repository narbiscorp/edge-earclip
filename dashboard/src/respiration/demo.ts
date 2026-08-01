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
import type { PolarAccEvent, PolarBeatEvent, PolarEcgEvent } from '../ble/polarH10';

const ACC_RATE_HZ = 50;
const ACC_FRAME_MS = 200; // 10 samples per frame, like the real stream batches
const HR_NOTIFY_MS = 1000;
const ECG_RATE_HZ = 130; // the H10's only ECG rate
const ECG_FRAME_MS = 100;
const ECG_LAG_MS = 400;

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
  /** R-peak times, shared with the ECG generator so the waveform and the beat
   * stream come from one clock. Trimmed as it goes. */
  const ecgBeats: number[] = [];

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
      ecgBeats.push(nextBeatAt);
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

  /* Synthetic ECG.
   *
   * Beat times come from the SAME clock that produces the RR intervals, so the R peaks land
   * exactly where the tachogram says they should — that is the property worth having in a demo,
   * because it makes a misalignment between the ECG and the beat stream visible as a bug rather
   * than hiding it in noise.
   *
   * Morphology is a sum of Gaussians in the usual P-Q-R-S-T arrangement, offsets expressed as a
   * fraction of the current RR so the complex stays sensible as the rate changes. Amplitudes are
   * in microvolts at roughly lead-I scale (R ≈ 1 mV). Plus baseline wander at the breathing rate
   * and a little mains-ish noise, which is what makes the detrend control worth having. */
  const gauss = (dt: number, amp: number, width: number): number =>
    amp * Math.exp(-(dt * dt) / (2 * width * width));

  const ecgAt = (tMs: number, rrMs: number): number => {
    let v = 0;
    for (let i = ecgBeats.length - 1; i >= 0; i--) {
      const dt = (tMs - ecgBeats[i]) / 1000; // seconds from this R peak
      if (dt > 0.6) break; // older beats no longer contribute
      if (dt < -0.4) continue;
      const rr = rrMs / 1000;
      v += gauss(dt + 0.19 * rr, 90, 0.032); // P
      v += gauss(dt - 0.016, -110, 0.0115); // Q
      v += gauss(dt, 1000, 0.0125); // R
      v += gauss(dt - 0.022, -220, 0.014); // S
      v += gauss(dt - 0.34 * rr, 260, 0.055); // T
    }
    const s = (tMs - t0) / 1000;
    v += 55 * Math.sin(2 * Math.PI * breathHz * s); // respiratory baseline wander
    v += (rng() - 0.5) * 18; // broadband noise
    return v;
  };

  let ecgCursor = t0;
  const ecgTimer = setInterval(() => {
    const now = Date.now();
    while (ecgBeats.length > 0 && now - ecgBeats[0] > 3000) ecgBeats.shift();
    const samples: number[] = [];
    const step = 1000 / ECG_RATE_HZ;
    // Generate BEHIND wall clock. The beat generator and this one both tick every 100 ms with no
    // ordering guarantee between them, so emitting a sample for time T before the beat at T has
    // been registered would silently drop that R peak from the waveform. The lag also matches
    // real BLE batching. `ecgAt` still needs one future beat for the P wave, hence 400 ms.
    const upTo = now - ECG_LAG_MS;
    while (ecgCursor + step <= upTo) {
      ecgCursor += step;
      samples.push(Math.round(ecgAt(ecgCursor, rrAt(ecgCursor))));
    }
    if (samples.length === 0) return;
    dispatch<PolarEcgEvent>('ecgReceived', {
      samples,
      lastSampleMs: ecgCursor,
      sampleRateHz: ECG_RATE_HZ,
    });
  }, ECG_FRAME_MS);

  return {
    stop: () => {
      clearInterval(beatTimer);
      clearInterval(accTimer);
      clearInterval(ecgTimer);
      dispatch('disconnected', { reason: 'user' });
    },
  };
}

/** True when the page was opened with ?demo=1 (or ?demo). */
export function demoRequested(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).has('demo');
}
