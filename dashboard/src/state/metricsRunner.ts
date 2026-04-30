import MetricsWorker from '../workers/metricsWorker?worker';
import type { MetricsRequest, MetricsResult } from '../workers/metricsWorker';
import { useDashboardStore } from './store';
import { extractIbiWindow } from '../metrics/windowing';
import { metricsBuffers, snapshotFromResult, type MetricsSnapshot } from './metricsBuffer';

const COMPUTE_INTERVAL_MS = 1000;
export const METRICS_WINDOW_SEC = 60;

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
  private lastBeatSeq = -1;

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
    this.lastBeatSeq = -1;
    metricsBuffers.live.clear();
  }

  isRunning(): boolean {
    return this.worker !== null;
  }

  private tick = (): void => {
    if (!this.worker || this.inFlight) return;
    if (useDashboardStore.getState().dataSource !== 'live') return;
    const beatBuf = useDashboardStore.getState().buffers.narbisBeats;
    if (beatBuf.seq === this.lastBeatSeq) return;
    const beats = beatBuf.getAll();
    if (beats.length < 4) return;
    const beatEvents = beats.map((s) => s.value);
    const { times_s, ibis_ms } = extractIbiWindow(beatEvents, METRICS_WINDOW_SEC, Date.now());
    if (times_s.length < 4) return;

    const requestId = this.nextRequestId++;
    const msg: MetricsRequest = {
      type: 'compute',
      requestId,
      times_s,
      ibis_ms,
    };
    this.inFlight = true;
    this.lastBeatSeq = beatBuf.seq;
    this.worker.postMessage(msg, [times_s.buffer, ibis_ms.buffer]);
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
