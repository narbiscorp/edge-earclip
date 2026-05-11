import MetricsWorker from '../workers/metricsWorker?worker';
import type { MetricsRequest, MetricsResult } from '../workers/metricsWorker';
import { useDashboardStore } from './store';
import { extractIbiWindow, extractH10IbiWindow, type IbiWindow } from '../metrics/windowing';
import { metricsBuffers, snapshotFromResult, type MetricsSnapshot } from './metricsBuffer';

const COMPUTE_INTERVAL_MS = 1000;
// The firmware coherence pipeline uses a 64-second window; widen the
// metrics window beyond the historical 60 s so we have enough data in
// the trailing 64 s for the firmware-mirror branch. Lomb-Scargle on the
// other branch is unaffected — it just gets a slightly longer window.
export const METRICS_WINDOW_SEC = 64;

export interface MetricsUpdatedDetail {
  snapshot: MetricsSnapshot;
  timestamp: number;
}

class MetricsRunner extends EventTarget {
  private worker: Worker | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private nextRequestId = 1;
  // Skip the worker post when no new beats have arrived since the last
  // tick. v13_26 strides frequency-domain HRV every 5 beats for the same
  // reason — Lomb-Scargle is the dominant cost and HRV moves on a ~30 s
  // timescale, so per-second recompute is wasted when nothing changed.
  // Composite seq tag includes the source so toggling earclip↔h10 forces
  // an immediate recompute on the new buffer.
  private lastSeqTag = '';

  start(): void {
    if (this.worker) return;
    this.worker = new MetricsWorker();
    this.worker.addEventListener('message', this.onMessage);
    this.timer = setInterval(this.tick, COMPUTE_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.worker) {
      this.worker.removeEventListener('message', this.onMessage);
      this.worker.terminate();
      this.worker = null;
    }
    this.inFlight = false;
    this.lastSeqTag = '';
    metricsBuffers.live.clear();
  }

  isRunning(): boolean {
    return this.worker !== null;
  }

  private tick = (): void => {
    if (!this.worker || this.inFlight) return;
    const state = useDashboardStore.getState();
    if (state.dataSource !== 'live') return;

    const source = state.hrSourceForGlasses;
    let window: IbiWindow;
    let seqTag: string;
    if (source === 'h10') {
      const buf = state.buffers.polarBeats;
      seqTag = `h10:${buf.seq}`;
      if (seqTag === this.lastSeqTag) return;
      const samples = buf.getAll();
      if (samples.length < 1) return;
      /* PolarBeatRecord lives in the StreamBuffer without a self-contained
       * timestamp — the buffer wraps each value in a {timestamp, value}
       * pair. Reshape into PolarBeatSample for the window extractor. */
      const polarSamples = samples.map((s) => ({
        timestamp: s.timestamp,
        bpm: s.value.bpm,
        rr: s.value.rr,
      }));
      window = extractH10IbiWindow(polarSamples, METRICS_WINDOW_SEC, Date.now());
    } else {
      const buf = state.buffers.narbisBeats;
      seqTag = `earclip:${buf.seq}`;
      if (seqTag === this.lastSeqTag) return;
      const samples = buf.getAll();
      if (samples.length < 4) return;
      window = extractIbiWindow(samples.map((s) => s.value), METRICS_WINDOW_SEC, Date.now());
    }

    const { times_s, ibis_ms, beat_ms } = window;
    if (times_s.length < 4) return;

    const requestId = this.nextRequestId++;
    const msg: MetricsRequest = {
      type: 'compute',
      requestId,
      times_s,
      ibis_ms,
      beat_ms,
      /* Pass the live params so the worker's firmware-mirror coherence
       * uses the SAME constants the user just pushed to the glasses.
       * Without this the dashboard's local trace drifts away from the
       * 0xF2 stream as soon as the user touches a slider. */
      coh_params: state.coherenceParams,
    };
    this.inFlight = true;
    this.lastSeqTag = seqTag;
    this.worker.postMessage(msg, [times_s.buffer, ibis_ms.buffer, beat_ms.buffer]);
  };

  private onMessage = (ev: MessageEvent<MetricsResult>): void => {
    this.inFlight = false;
    const result = ev.data;
    if (!result || result.type !== 'result') return;
    const snapshot = snapshotFromResult(result);
    const timestamp = Date.now();
    metricsBuffers.live.push(timestamp, snapshot);
    this.dispatchEvent(
      new CustomEvent<MetricsUpdatedDetail>('metricsUpdated', {
        detail: { snapshot, timestamp },
      }),
    );
  };
}

export const metricsRunner = new MetricsRunner();
