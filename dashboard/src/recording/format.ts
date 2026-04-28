// TODO Stage 13: recording bundle format (CSV + JSON manifest).

export interface RecordingBundle {
  manifest: unknown;
  ibiCsv: string;
  rawCsv: string | null;
}

export function buildBundle(): RecordingBundle {
  throw new Error('not implemented');
}
