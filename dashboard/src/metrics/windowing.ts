// TODO Stage 11: window functions for spectral analysis.

export type WindowType = 'rect' | 'hann' | 'hamming' | 'blackman';

export function applyWindow(_samples: number[], _type: WindowType): number[] {
  throw new Error('not implemented');
}
