// TODO Stage 13: manifest schema (firmware version, config snapshot, start/end ts, etc.).

export interface RecordingManifest {
  schemaVersion: number;
  startedAt: number;
  endedAt: number | null;
}

export function buildManifest(): RecordingManifest {
  throw new Error('not implemented');
}
