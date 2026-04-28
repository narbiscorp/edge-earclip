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
    metricsBuffers.live.clear();
  }

  isRunning(): boolean {
    return this.worker !== null;
  }

  private tick = (): void => {
    if (!this.worker || this.inFlight) return;
    if (useDashboardStore.getState().dataSource !== 'live') return;
    const beats = useDashboardStore.getState().buffers.narbisBeats.getAll();
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
