import { StreamBuffer } from './streamBuffer';
import { Spo2Tracker, type Spo2Estimate } from '../metrics/spo2';

/* SpO2 estimates (metrics/spo2.ts), one a second: an hour each. Live ones come from every raw
 * sample as it is processed; a replay's are computed over the whole recording when it loads
 * (recording/replay.ts) and windowed into `replay` like the metrics. */
const CAPACITY = 3600;

export const spo2Buffers = {
  live: new StreamBuffer<Spo2Estimate>(CAPACITY),
  replay: new StreamBuffer<Spo2Estimate>(CAPACITY),
};

const liveTracker = new Spo2Tracker();

/** Every live raw sample, in time order (store.ts processRawBatch). */
export function pushLiveSpo2(ts: number, ir: number, red: number, sampleRateHz: number): void {
  const e = liveTracker.push(ts, ir, red, sampleRateHz);
  if (e) spo2Buffers.live.push(ts, e);
}
