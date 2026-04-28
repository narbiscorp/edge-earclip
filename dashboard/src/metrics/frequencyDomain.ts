export interface FrequencyDomainMetrics {
  lf: number;
  hf: number;
  lfHfRatio: number;
  totalPower: number;
}

export interface PSD {
  freqs_hz: Float64Array;
  power: Float64Array;
}

export const LF_BAND: [number, number] = [0.04, 0.15];
export const HF_BAND: [number, number] = [0.15, 0.40];

export function logSpacedFreqs(min_hz: number, max_hz: number, n: number): Float64Array {
  const out = new Float64Array(n);
  if (n === 0) return out;
  if (n === 1) {
    out[0] = min_hz;
    return out;
  }
  const a = Math.log(min_hz);
  const b = Math.log(max_hz);
  for (let i = 0; i < n; i++) {
    out[i] = Math.exp(a + ((b - a) * i) / (n - 1));
  }
  return out;
}

/**
 * Normalized Lomb-Scargle periodogram.
 * times_s: irregular sample times in seconds (length N)
 * values: sample values, mean is removed internally (length N)
 * freqs_hz: frequencies at which to evaluate (length M)
 * Returns power spectral density (length M).
 */
export function lombScargle(
  times_s: Float64Array,
  values: Float64Array,
  freqs_hz: Float64Array,
): Float64Array {
  const n = times_s.length;
  const m = freqs_hz.length;
  const psd = new Float64Array(m);
  if (n < 2 || m === 0) return psd;

  let mean = 0;
  for (let i = 0; i < n; i++) mean += values[i];
  mean /= n;
  let variance = 0;
  const centered = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const v = values[i] - mean;
    centered[i] = v;
    variance += v * v;
  }
  variance /= n;
  if (variance <= 0) return psd;

  for (let k = 0; k < m; k++) {
    const omega = 2 * Math.PI * freqs_hz[k];
    let sin2 = 0;
    let cos2 = 0;
    for (let i = 0; i < n; i++) {
      const a = 2 * omega * times_s[i];
      sin2 += Math.sin(a);
      cos2 += Math.cos(a);
    }
    const tau = Math.atan2(sin2, cos2) / (2 * omega);

    let cSum = 0;
    let sSum = 0;
    let cc = 0;
    let ss = 0;
    for (let i = 0; i < n; i++) {
      const ang = omega * (times_s[i] - tau);
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      cSum += centered[i] * c;
      sSum += centered[i] * s;
      cc += c * c;
      ss += s * s;
    }
    const term1 = cc > 0 ? (cSum * cSum) / cc : 0;
    const term2 = ss > 0 ? (sSum * sSum) / ss : 0;
    psd[k] = (0.5 / variance) * (term1 + term2);
  }
  return psd;
}

export function integrateBand(psd: PSD, band: [number, number]): number {
  const { freqs_hz, power } = psd;
  const n = freqs_hz.length;
  if (n < 2) return 0;
  let total = 0;
  for (let i = 1; i < n; i++) {
    const f0 = freqs_hz[i - 1];
    const f1 = freqs_hz[i];
    if (f1 < band[0] || f0 > band[1]) continue;
    const lo = Math.max(f0, band[0]);
    const hi = Math.min(f1, band[1]);
    if (hi <= lo) continue;
    const fracLo = (lo - f0) / (f1 - f0);
    const fracHi = (hi - f0) / (f1 - f0);
    const pLo = power[i - 1] + (power[i] - power[i - 1]) * fracLo;
    const pHi = power[i - 1] + (power[i] - power[i - 1]) * fracHi;
    total += 0.5 * (pLo + pHi) * (hi - lo);
  }
  return total;
}

export function computeLFPower(psd: PSD): number {
  return integrateBand(psd, LF_BAND);
}

export function computeHFPower(psd: PSD): number {
  return integrateBand(psd, HF_BAND);
}

export function computeLFHFRatio(lf: number, hf: number): number {
  return hf > 0 ? lf / hf : 0;
}

export function computeFrequencyDomain(psd: PSD): FrequencyDomainMetrics {
  const lf = computeLFPower(psd);
  const hf = computeHFPower(psd);
  const total = integrateBand(psd, [psd.freqs_hz[0], psd.freqs_hz[psd.freqs_hz.length - 1]]);
  return {
    lf,
    hf,
    lfHfRatio: computeLFHFRatio(lf, hf),
    totalPower: total,
  };
}
