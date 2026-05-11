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
  /** Firmware-mirror coherence score (0..100) computed locally on the
   * same beats. null when the dashboard's IBI window was below the
   * firmware minimum (n_ibis < 20). */
  firmwareCoherence: number | null;
  /** Firmware-mirror LF resonance peak frequency in Hz. */
  firmwareRespFreq_hz: number | null;
}

/** A single 0xF2 packet as emitted by the glasses' coherence_task — the
 * authoritative "what the lens is actually responding to" value. Buffered
 * separately from MetricsSnapshot because it arrives independently of the
 * dashboard's beat stream (e.g. when the dashboard has no IBI source but
 * the glasses' on-board ADC is running). */
export interface EdgeCoherenceSnapshot {
  coh: number;
  respMhz: number;
  lf: number;
  hf: number;
  lfNorm: number;
  hfNorm: number;
  lfHf: number;
  nIbis: number;
  pacerBpm: number;
}

const CAPACITY = 1200;

export const metricsBuffers = {
  live: new StreamBuffer<MetricsSnapshot>(CAPACITY),
  replay: new StreamBuffer<MetricsSnapshot>(CAPACITY),
};

export const edgeCoherenceBuffers = {
  live: new StreamBuffer<EdgeCoherenceSnapshot>(CAPACITY),
  replay: new StreamBuffer<EdgeCoherenceSnapshot>(CAPACITY),
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
    firmwareCoherence: r.firmwareCoherence,
    firmwareRespFreq_hz: r.firmwareRespFreq_hz,
  };
}
