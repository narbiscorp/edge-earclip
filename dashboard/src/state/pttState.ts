/*
 * pttState.ts — live pulse arrival time (metrics/ptt.ts): the H10's raw ECG → R-peaks
 * (metrics/ecgRpeak.ts), the earclip's beats, both moved onto corrected clocks and paired.
 * Feeds H10EcgChart and PttChart; recordings take the 'ecg' / 'rpeak' / 'pat' events.
 *
 * The ECG stream is opt-in (startPttEcg): it is 130 Hz, costs H10 battery, and some H10s will
 * not run it beside the accelerometer that Coherence Engine Mode B uses.
 */
import { StreamBuffer } from './streamBuffer';
import { polarH10, type PolarEcgEvent } from '../ble/polarH10';
import { narbisDevice, type NarbisV2IbiEvent, type NarbisV2PpgEvent } from '../ble/narbisDevice';
import { IBIF_ARTIFACT, IBIF_GATED, IBIF_MOTION } from '../ble/v2/protocol';
import { RPeakDetector, type RPeak } from '../metrics/ecgRpeak';
import { ClockCorrector, patFor, type PatSample } from '../metrics/ptt';

/** 5 min of ECG at 130 Hz, on the corrected clock. */
export const ecgBuffer = new StreamBuffer<number>(130 * 300);
export const rPeakBuffer = new StreamBuffer<RPeak>(3000);
export const patBuffer = new StreamBuffer<PatSample>(3000);

export interface PttStats {
  /** Corrections applied to each device's mapped times (ms), null before its first packet. */
  ecgOffsetMs: number | null;
  earOffsetMs: number | null;
  paired: number;
  /** Earclip beats with no R-peak 80-600 ms before them (or no ECG at all). */
  unpaired: number;
}

export const pttStats: PttStats = { ecgOffsetMs: null, earOffsetMs: null, paired: 0, unpaired: 0 };

export interface PttEcgDetail { t0: number; periodMs: number; samples: number[] }
export interface PttRPeakDetail { peak: RPeak }
export interface PttPatDetail { sample: PatSample }

/** Events: 'ecg' (PttEcgDetail), 'rpeak' (PttRPeakDetail), 'pat' (PttPatDetail). */
export const pttEvents = new EventTarget();

/** A pause this long between packets means a new connection: its clock mapping starts over. */
const NEW_LINK_GAP_MS = 3000;
/** R-peaks are final this long behind the newest ECG sample (detector lookahead + search). */
const ECG_FINAL_LAG_MS = 300;
/** An earclip beat still unpaired this long after it happened gives up. */
const PENDING_GIVE_UP_MS = 5000;

const ecgClock = new ClockCorrector();
const earClock = new ClockCorrector();
const detector = new RPeakDetector();
let lastEcgArrival = 0;
let lastEcgFrameMs: number | null = null;
let lastEarArrival = 0;
let ecgFinalTo = -Infinity;
const rTimes: number[] = [];
const pending: Array<{ t: number; flags: number }> = [];

polarH10.addEventListener('ecgReceived', (e) => {
  const { samples, lastSampleMs, sampleRateHz } = (e as CustomEvent<PolarEcgEvent>).detail;
  const arrival = Date.now();
  if (arrival - lastEcgArrival > NEW_LINK_GAP_MS) {
    ecgClock.reset();
    detector.reset();
    lastEcgFrameMs = null;
  }
  lastEcgArrival = arrival;
  ecgClock.observe(lastSampleMs, arrival);
  const off = ecgClock.offset() ?? 0;
  pttStats.ecgOffsetMs = off;

  const n = samples.length;
  const nominal = 1000 / sampleRateHz;
  let period = nominal;
  if (lastEcgFrameMs !== null) {
    const p = (lastSampleMs - lastEcgFrameMs) / n;
    if (p > nominal * 0.9 && p < nominal * 1.1) period = p;
  }
  lastEcgFrameMs = lastSampleMs;
  const t0 = lastSampleMs - (n - 1) * period;
  for (let i = 0; i < n; i++) {
    const mapped = t0 + i * period;
    ecgBuffer.push(mapped + off, samples[i]);
    // The detector runs on the mapped (monotonic) times; each R is moved onto the corrected
    // clock when it is final.
    for (const r of detector.push(mapped, samples[i], sampleRateHz)) {
      const peak = { ...r, t: r.t + off };
      rPeakBuffer.push(peak.t, peak);
      rTimes.push(peak.t);
      pttEvents.dispatchEvent(new CustomEvent<PttRPeakDetail>('rpeak', { detail: { peak } }));
    }
  }
  pttEvents.dispatchEvent(new CustomEvent<PttEcgDetail>('ecg', { detail: { t0: t0 + off, periodMs: period, samples } }));
  while (rTimes.length > 0 && rTimes[0] < lastSampleMs + off - 20_000) rTimes.shift();
  ecgFinalTo = lastSampleMs + off - ECG_FINAL_LAG_MS;
  pairPending();
});

narbisDevice.addEventListener('v2PpgReceived', (e) => {
  const { batch, hostFirstMs, periodMs } = (e as CustomEvent<NarbisV2PpgEvent>).detail;
  const arrival = Date.now();
  if (arrival - lastEarArrival > NEW_LINK_GAP_MS) earClock.reset();
  lastEarArrival = arrival;
  earClock.observe(hostFirstMs + (batch.ir.length - 1) * periodMs, arrival);
  pttStats.earOffsetMs = earClock.offset();
});

narbisDevice.addEventListener('v2IbiReceived', (e) => {
  const { records } = (e as CustomEvent<NarbisV2IbiEvent>).detail;
  const off = earClock.offset();
  if (off === null) return;
  for (const r of records) {
    // A gated or implausible beat may not be a beat at all; light-motion ones are kept, marked.
    if (r.flags & (IBIF_ARTIFACT | IBIF_GATED)) continue;
    pending.push({ t: r.hostMs + off, flags: r.flags });
  }
  pairPending();
});

function pairPending(): void {
  while (pending.length > 0 && pending[0].t <= ecgFinalTo) {
    const p = pending.shift() as { t: number; flags: number };
    const pat = patFor(p.t, rTimes);
    if (pat === null) {
      pttStats.unpaired++;
      continue;
    }
    const sample: PatSample = { t: p.t, pat, motion: (p.flags & IBIF_MOTION) !== 0 };
    patBuffer.push(p.t, sample);
    pttStats.paired++;
    pttEvents.dispatchEvent(new CustomEvent<PttPatDetail>('pat', { detail: { sample } }));
  }
  // No ECG coming (not started, or the strap dropped): don't hoard beats.
  const stale = Date.now() - PENDING_GIVE_UP_MS;
  while (pending.length > 0 && pending[0].t < stale) {
    pending.shift();
    pttStats.unpaired++;
  }
}

/** Start the H10's raw ECG for the PTT charts. Resolves to an error message, or null. */
export async function startPttEcg(): Promise<string | null> {
  try {
    await polarH10.startEcgStream();
    return null;
  } catch (err) {
    const msg = (err as Error).message;
    return polarH10.isAccStreaming
      ? `${msg}. This H10 may not run ECG beside the accelerometer: stop the Coherence Engine (Mode A/B/C use it), then try again.`
      : msg;
  }
}

export async function stopPttEcg(): Promise<void> {
  await polarH10.stopEcgStream();
}
