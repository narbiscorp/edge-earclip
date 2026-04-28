import type {
  BeatRecord,
  FileEntry,
  ManifestSummary,
  MetricsRecord,
  RawSampleRecord,
  RecordingManifest,
  RecordingSessionRow,
  SqiRecord,
  Annotation,
  PolarBeatRecordTimed,
} from './types';
import { UNSUPPORTED_COLUMN_NOTES } from './format';

export const RECORDING_SCHEMA_VERSION = 1;

export interface SummarizeInput {
  startedAt: number;
  endedAt: number;
  raw: RawSampleRecord[];
  beats: BeatRecord[];
  sqi: SqiRecord[];
  annotations: Annotation[];
  polarBeats: PolarBeatRecordTimed[];
  metrics: MetricsRecord[];
  filesBytes: number;
}

export function summarize(input: SummarizeInput): ManifestSummary {
  const totalBeats = input.beats.length;
  const totalArtifactBeats = input.beats.reduce((acc, b) => acc + (b.is_artifact ? 1 : 0), 0);
  const validBeats = input.beats.filter((b) => !b.is_artifact && b.bpm > 0);
  const meanHrBpm =
    validBeats.length > 0
      ? validBeats.reduce((acc, b) => acc + b.bpm, 0) / validBeats.length
      : null;
  const meanSqiX100 =
    input.sqi.length > 0
      ? input.sqi.reduce((acc, s) => acc + s.sqi_x100, 0) / input.sqi.length
      : null;

  return {
    durationMs: Math.max(0, input.endedAt - input.startedAt),
    totalRawSamples: input.raw.length,
    totalBeats,
    totalArtifactBeats,
    artifactRatio: totalBeats > 0 ? totalArtifactBeats / totalBeats : 0,
    meanHrBpm,
    meanSqiX100,
    totalAnnotations: input.annotations.length,
    totalPolarBeats: input.polarBeats.length,
    totalMetrics: input.metrics.length,
    filesBytes: input.filesBytes,
  };
}

export function buildManifest(
  session: RecordingSessionRow,
  endedAt: number,
  files: FileEntry[],
  summary: ManifestSummary,
): RecordingManifest {
  return {
    schemaVersion: RECORDING_SCHEMA_VERSION,
    sessionId: session.id,
    name: session.name,
    subjectId: session.subjectId,
    notes: session.notes,
    startedAt: session.startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - session.startedAt),
    fwVersion: session.fwVersion,
    dashboardVersion: session.dashboardVersion,
    streams: session.streams,
    files,
    summary,
    notes_on_unsupported_columns: UNSUPPORTED_COLUMN_NOTES,
  };
}

export function sessionFolderName(session: RecordingSessionRow): string {
  const ts = new Date(session.startedAt)
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .replace('Z', '');
  const subj = (session.subjectId || 'subject').replace(/[^A-Za-z0-9_-]+/g, '_');
  return `session_${ts}_${subj}`;
}
