/// <reference lib="webworker" />

import { computeTimeDomain, type TimeDomainMetrics } from '../metrics/timeDomain';
import {
  lombScargle,
  logSpacedFreqs,
  computeFrequencyDomain,
  integrateBand,
  type FrequencyDomainMetrics,
  type PSD,
} from '../metrics/frequencyDomain';
import {
  computeHeartMathCoherence,
  computeResonanceCoherence,
  type CoherenceResult,
} from '../metrics/coherence';
import { computeFirmwareCoherence } from '../metrics/firmwareCoherence';
import type { NarbisCoherenceParams } from '../../../protocol/narbis_protocol';

export interface MetricsRequest {
  type: 'compute';
  requestId: number;
  times_s: Float64Array;
  ibis_ms: Float64Array;
  /** Absolute beat-end timestamps in ms (sorted). Required for the
   * firmware-mirror coherence — it needs the same wall-clock anchors
   * the firmware uses to time-restrict the 64-second window. */
  beat_ms: Float64Array;
  /** Runtime-tunable coherence params. Caller should pass the SAME values
   * it last pushed to the glasses via 0xE0; otherwise the dashboard's
   * local trace will not match the glasses' 0xF2 stream. */
  coh_params?: NarbisCoherenceParams;
}

export interface MetricsResult {
  type: 'result';
  requestId: number;
  beatCount: number;
  time: TimeDomainMetrics;
  freq: FrequencyDomainMetrics;
  vlfPower: number;
  resonancePower: number;
  hmCoherence: CoherenceResult;
  resonanceCoherence: CoherenceResult;
  /** Firmware-mirror coherence (0..100). null if fewer than 20 beats in
   * the trailing 64-second window. */
  firmwareCoherence: number | null;
  /** Firmware-mirror LF resonance peak frequency in Hz. null when
   * firmwareCoherence is null. */
  firmwareRespFreq_hz: number | null;
}

const VLF_BAND: [number, number] = [0.0033, 0.04];
const RESONANCE_HALF_WIDTH_HZ = 0.015;

const FREQ_GRID = logSpacedFreqs(0.01, 0.5, 256);

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.addEventListener('message', (ev: MessageEvent<MetricsRequest>) => {
  const msg = ev.data;
  if (msg.type !== 'compute') return;

  const { times_s, ibis_ms, beat_ms, coh_params, requestId } = msg;
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
  const vlfPower = integrateBand(psd, VLF_BAND);
  let resonancePower = 0;
  if (resonanceCoherence.peakFreq_hz > 0) {
    const lo = Math.max(resonanceCoherence.peakFreq_hz - RESONANCE_HALF_WIDTH_HZ, FREQ_GRID[0]);
    const hi = Math.min(resonanceCoherence.peakFreq_hz + RESONANCE_HALF_WIDTH_HZ, FREQ_GRID[FREQ_GRID.length - 1]);
    resonancePower = integrateBand(psd, [lo, hi]);
  }

  let firmwareCoherence: number | null = null;
  let firmwareRespFreq_hz: number | null = null;
  if (beat_ms && beat_ms.length === ibis_ms.length) {
    const fw = computeFirmwareCoherence({
      beat_ms,
      ibi_ms: ibis_ms,
      params: coh_params,
    });
    if (fw) {
      firmwareCoherence = fw.coherence;
      firmwareRespFreq_hz = fw.resp_peak_mhz / 1000;
    }
  }

  const result: MetricsResult = {
    type: 'result',
    requestId,
    beatCount: n,
    time,
    freq,
    vlfPower,
    resonancePower,
    hmCoherence,
    resonanceCoherence,
    firmwareCoherence,
    firmwareRespFreq_hz,
  };
  ctx.postMessage(result);
});
