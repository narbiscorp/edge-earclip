export interface TimeDomainMetrics {
  meanHr: number;
  sdnn: number;
  rmssd: number;
  pnn50: number;
}

export function computeMeanHR(ibis_ms: ArrayLike<number>): number {
  const n = ibis_ms.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += ibis_ms[i];
  const mean = sum / n;
  return mean > 0 ? 60000 / mean : 0;
}

export function computeSDNN(ibis_ms: ArrayLike<number>): number {
  const n = ibis_ms.length;
  if (n < 2) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += ibis_ms[i];
  const mean = sum / n;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const d = ibis_ms[i] - mean;
    sq += d * d;
  }
  return Math.sqrt(sq / (n - 1));
}

export function computeRMSSD(ibis_ms: ArrayLike<number>): number {
  const n = ibis_ms.length;
  if (n < 2) return 0;
  let sq = 0;
  for (let i = 1; i < n; i++) {
    const d = ibis_ms[i] - ibis_ms[i - 1];
    sq += d * d;
  }
  return Math.sqrt(sq / (n - 1));
}

export function computePNN50(ibis_ms: ArrayLike<number>): number {
  const n = ibis_ms.length;
  if (n < 2) return 0;
  let count = 0;
  for (let i = 1; i < n; i++) {
    if (Math.abs(ibis_ms[i] - ibis_ms[i - 1]) > 50) count += 1;
  }
  return count / (n - 1);
}

export function computeTimeDomain(ibis_ms: ArrayLike<number>): TimeDomainMetrics {
  return {
    meanHr: computeMeanHR(ibis_ms),
    sdnn: computeSDNN(ibis_ms),
    rmssd: computeRMSSD(ibis_ms),
    pnn50: computePNN50(ibis_ms),
  };
}
