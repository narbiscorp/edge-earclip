import type { PSD } from './frequencyDomain';
import { integrateBand } from './frequencyDomain';

export interface CoherenceResult {
  score: number;
  peakFreq_hz: number;
}

const HM_BAND: [number, number] = [0.04, 0.26];
const RESONANCE_BAND: [number, number] = [0.04, 0.20];
const RESONANCE_HALF_WIDTH_HZ = 0.015;

function findPeak(psd: PSD, band: [number, number]): { freq_hz: number; power: number } {
  const { freqs_hz, power } = psd;
  let best = -1;
  let bestPower = 0;
  for (let i = 0; i < freqs_hz.length; i++) {
    const f = freqs_hz[i];
    if (f < band[0] || f > band[1]) continue;
    if (best === -1 || power[i] > bestPower) {
      best = i;
      bestPower = power[i];
    }
  }
  if (best === -1) return { freq_hz: 0, power: 0 };
  return { freq_hz: freqs_hz[best], power: bestPower };
}

/**
 * HeartMath-style coherence: ratio of power in the coherence band to power outside it,
 * mapped to a 0..10 score.
 */
export function computeHeartMathCoherence(psd: PSD): CoherenceResult {
  const inBand = integrateBand(psd, HM_BAND);
  const lo = psd.freqs_hz[0];
  const hi = psd.freqs_hz[psd.freqs_hz.length - 1];
  const total = integrateBand(psd, [lo, hi]);
  const outOfBand = Math.max(total - inBand, 1e-12);
  const ratio = inBand / outOfBand;
  const peak = findPeak(psd, HM_BAND);
  const score = Math.min(10, ratio);
  return { score, peakFreq_hz: peak.freq_hz };
}

/**
 * Lehrer / Vaschillo individualized resonance coherence: locate the dominant peak
 * in the resonance band, then score by the ratio of power within ±halfWidth Hz
 * of that peak to total power. Higher = sharper resonance peak.
 */
export function computeResonanceCoherence(
  psd: PSD,
  halfWidth_hz: number = RESONANCE_HALF_WIDTH_HZ,
): CoherenceResult {
  const peak = findPeak(psd, RESONANCE_BAND);
  if (peak.power === 0) return { score: 0, peakFreq_hz: 0 };
  const lo = Math.max(peak.freq_hz - halfWidth_hz, psd.freqs_hz[0]);
  const hi = Math.min(peak.freq_hz + halfWidth_hz, psd.freqs_hz[psd.freqs_hz.length - 1]);
  const peakPower = integrateBand(psd, [lo, hi]);
  const totalPower = integrateBand(psd, [psd.freqs_hz[0], psd.freqs_hz[psd.freqs_hz.length - 1]]);
  if (totalPower <= 0) return { score: 0, peakFreq_hz: peak.freq_hz };
  const fraction = peakPower / totalPower;
  const score = Math.min(10, fraction * 10);
  return { score, peakFreq_hz: peak.freq_hz };
}

export function computeCoherence(psd: PSD): { hm: CoherenceResult; resonance: CoherenceResult } {
  return {
    hm: computeHeartMathCoherence(psd),
    resonance: computeResonanceCoherence(psd),
  };
}
