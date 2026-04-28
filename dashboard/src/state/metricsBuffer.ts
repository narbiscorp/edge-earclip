import { StreamBuffer } from './streamBuffer';
import type { MetricsResult } from '../workers/metricsWorker';

export interface MetricsSnapshot {
  meanHr: number;
  sdnn: number;
  rmssd: number;
  pnn50: number;
  vlf: number;
  lf: number;
  hf: number;
  lfHfRatio: number;
  totalPower: number;
  resonancePower: number;
  hmCoherence: number;
  resonanceCoherence: number;
  resonanceFreq_hz: number;
  beatCount: number;
}

const CAPACITY = 1200;

export const metricsBuffers = {
  live: new StreamBuffer<MetricsSnapshot>(CAPACITY),
  replay: new StreamBuffer<MetricsSnapshot>(CAPACITY),
};

// Backwards-compat alias for code paths that always wrote to the live buffer
// before the live/replay split. New code should prefer `getActiveMetricsBuffer()`.
export const metricsBuffer = metricsBuffers.live;

export function snapshotFromResult(r: MetricsResult): MetricsSnapshot {
  return {
    meanHr: r.time.meanHr,
    sdnn: r.time.sdnn,
    rmssd: r.time.rmssd,
    pnn50: r.time.pnn50,
    vlf: r.vlfPower,
    lf: r.freq.lf,
    hf: r.freq.hf,
    lfHfRatio: r.freq.lfHfRatio,
    totalPower: r.freq.totalPower,
    resonancePower: r.resonancePower,
    hmCoherence: r.hmCoherence.score,
    resonanceCoherence: r.resonanceCoherence.score,
    resonanceFreq_hz: r.resonanceCoherence.peakFreq_hz,
    beatCount: r.beatCount,
  };
}
