import { StreamBuffer } from './streamBuffer';
import type { MetricsResult } from '../workers/metricsWorker';

export interface MetricsSnapshot {
  meanHr: number;
  sdnn: number;
  rmssd: number;
  pnn50: number;
  lf: number;
  hf: number;
  lfHfRatio: number;
  totalPower: number;
  hmCoherence: number;
  resonanceCoherence: number;
  resonanceFreq_hz: number;
  beatCount: number;
}

export const metricsBuffer = new StreamBuffer<MetricsSnapshot>(1200);

export function snapshotFromResult(r: MetricsResult): MetricsSnapshot {
  return {
    meanHr: r.time.meanHr,
    sdnn: r.time.sdnn,
    rmssd: r.time.rmssd,
    pnn50: r.time.pnn50,
    lf: r.freq.lf,
    hf: r.freq.hf,
    lfHfRatio: r.freq.lfHfRatio,
    totalPower: r.freq.totalPower,
    hmCoherence: r.hmCoherence.score,
    resonanceCoherence: r.resonanceCoherence.score,
    resonanceFreq_hz: r.resonanceCoherence.peakFreq_hz,
    beatCount: r.beatCount,
  };
}
