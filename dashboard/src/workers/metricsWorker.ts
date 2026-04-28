/// <reference lib="webworker" />

import { computeTimeDomain, type TimeDomainMetrics } from '../metrics/timeDomain';
import {
  lombScargle,
  logSpacedFreqs,
  computeFrequencyDomain,
  type FrequencyDomainMetrics,
  type PSD,
} from '../metrics/frequencyDomain';
import {
  computeHeartMathCoherence,
  computeResonanceCoherence,
  type CoherenceResult,
} from '../metrics/coherence';

export interface MetricsRequest {
  type: 'compute';
  requestId: number;
  times_s: Float64Array;
  ibis_ms: Float64Array;
}

export interface MetricsResult {
  type: 'result';
  requestId: number;
  beatCount: number;
  time: TimeDomainMetrics;
  freq: FrequencyDomainMetrics;
  hmCoherence: CoherenceResult;
  resonanceCoherence: CoherenceResult;
}

const FREQ_GRID = logSpacedFreqs(0.01, 0.5, 256);

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.addEventListener('message', (ev: MessageEvent<MetricsRequest>) => {
  const msg = ev.data;
  if (msg.type !== 'compute') return;

  const { times_s, ibis_ms, requestId } = msg;
  const n = times_s.length;

  const time = computeTimeDomain(ibis_ms);

  let psd: PSD;
  if (n >= 4) {
    const power = lombScargle(times_s, ibis_ms, FREQ_GRID);
    psd = { freqs_hz: FREQ_GRID, power };
  } else {
    psd = { freqs_hz: FREQ_GRID, power: new Float64Array(FREQ_GRID.length) };
  }

  const freq = computeFrequencyDomain(psd);
  const hmCoherence = computeHeartMathCoherence(psd);
  const resonanceCoherence = computeResonanceCoherence(psd);

  const result: MetricsResult = {
    type: 'result',
    requestId,
    beatCount: n,
    time,
    freq,
    hmCoherence,
    resonanceCoherence,
  };
  ctx.postMessage(result);
});
