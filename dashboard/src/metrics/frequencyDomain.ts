// TODO Stage 11: frequency-domain HRV (LF, HF, LF/HF, total power).

export interface FrequencyDomainMetrics {
  lf: number;
  hf: number;
  lfHfRatio: number;
  totalPower: number;
}

export function computeFrequencyDomain(_ibis: number[]): FrequencyDomainMetrics {
  throw new Error('not implemented');
}
