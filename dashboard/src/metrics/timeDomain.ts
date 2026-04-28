// TODO Stage 11: time-domain HRV (RMSSD, SDNN, pNN50, mean HR).

export interface TimeDomainMetrics {
  meanHr: number;
  sdnn: number;
  rmssd: number;
  pnn50: number;
}

export function computeTimeDomain(_ibis: number[]): TimeDomainMetrics {
  throw new Error('not implemented');
}
