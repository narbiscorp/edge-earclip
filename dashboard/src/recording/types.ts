import type {
  NarbisRuntimeConfig,
  NarbisRawSample,
  NarbisSqiPayload,
  DiagnosticSample,
} from '../ble/parsers';
import type { NarbisBeatEvent } from '../ble/narbisDevice';
import type { PolarBeatRecord } from '../state/store';
import type { MetricsSnapshot } from '../state/metricsBuffer';

export type RecordingPhase = 'IDLE' | 'PRE_RECORDING' | 'RECORDING' | 'FINALIZING' | 'COMPLETE';

export interface RecordingMeta {
  name: string;
  subjectId: string;
  notes: string;
  streams: {
    raw: boolean;
    beats: boolean;
    sqi: boolean;
    filtered: boolean;
    polar: boolean;
    acc: boolean; // H10 accelerometer (Mode B respiration channel) — only present alongside polar
    metrics: boolean;
  };
}

export type AnnotationEventType = 'mark' | 'text';

export interface Annotation {
  timestamp: number;
  text: string;
  eventType: AnnotationEventType;
  source: 'user';
}

export interface ConfigChangeEntry {
  timestamp: number;
  config: NarbisRuntimeConfig;
}

// Records held in the in-memory accumulator and flushed into IndexedDB chunks.
export interface RawSampleRecord {
  timestamp: number;
  sample_index: number;
  red: number;
  ir: number;
  // forward-filled DC at the time the sample was captured (latest SQI value).
  dc_red: number | null;
  dc_ir: number | null;
  // led currents in mA derived from the active runtime config (null until config seen).
  led_red_ma: number | null;
  led_ir_ma: number | null;
}

export interface BeatRecord extends NarbisBeatEvent {
  /** True when isArtifactBeat() returned true for this beat. */
  is_artifact: boolean;
  /** Pipe-joined flag names ("LOW_SQI|LOW_CONFIDENCE") or "" when no flags set. */
  rejection_reason: string;
  /** Detection channel used by the firmware ("ir" by default). */
  channel_used: string;
}

export interface SqiRecord {
  timestamp: number;
  sqi_x100: number;
  dc_red: number;
  dc_ir: number;
  perfusion_idx_x1000: number;
}

export interface BatteryRecord {
  timestamp: number;
  mv: number | null;     // null on standard BAS source (0x180F only carries SoC%).
  soc_pct: number;
  charging: boolean;
  source: 'narbis' | 'standard' | 'relay';
}

export interface PolarBeatRecordTimed {
  timestamp: number;
  bpm: number;
  rr: number[];
  /* Monotonic per-RR timestamps (ms). Optional because recording bundles
   * captured before the beat-clock landing won't have it; replay
   * regenerates them on load. New recordings always include this. */
  beatTimestamps?: number[];
}

export interface MetricsRecord {
  timestamp: number;
  window_seconds: number;
  snapshot: MetricsSnapshot;
  /** Average sqi_x100 within the metric window, or null if no SQI samples. */
  sqi_avg: number | null;
}

/** One PMD accelerometer notification from the H10 (raw device counts). `timestamp` is the NEWEST
 * sample's wall-clock ms (PolarAccEvent.lastSampleMs); per-sample times walk back by 1000/sampleRateHz.
 * Self-describing, so it round-trips on replay with no clock regeneration. */
export interface AccPacketRecord {
  timestamp: number;
  sampleRateHz: number;
  samples: Array<{ x: number; y: number; z: number }>;
}

export interface FilteredRecord {
  timestamp: number;
  sample: DiagnosticSample;
}

export interface RecordingChunk {
  sessionId: string;
  chunkSeq: number;
  t0_ms: number;
  t1_ms: number;
  raw?: RawSampleRecord[];
  beats?: BeatRecord[];
  sqi?: SqiRecord[];
  battery?: BatteryRecord[];
  filtered?: FilteredRecord[];
  polarBeats?: PolarBeatRecordTimed[];
  accPackets?: AccPacketRecord[];
  metrics?: MetricsRecord[];
  annotations?: Annotation[];
  configEvents?: ConfigChangeEntry[];
}

export type SessionStatus = 'recording' | 'finalizing' | 'complete' | 'aborted';

export interface RecordingSessionRow {
  id: string;
  name: string;
  subjectId: string;
  notes: string;
  startedAt: number;
  endedAt: number | null;
  status: SessionStatus;
  schemaVersion: number;
  configInitial: NarbisRuntimeConfig | null;
  fwVersion: string | null;
  dashboardVersion: string;
  streams: RecordingMeta['streams'];
  summary: ManifestSummary | null;
}

export interface FileEntry {
  path: string;
  bytes: number;
}

export interface ManifestSummary {
  durationMs: number;
  totalRawSamples: number;
  totalBeats: number;
  totalArtifactBeats: number;
  artifactRatio: number;
  meanHrBpm: number | null;
  meanSqiX100: number | null;
  totalAnnotations: number;
  totalPolarBeats: number;
  totalMetrics: number;
  filesBytes: number;
}

export interface RecordingManifest {
  schemaVersion: number;
  sessionId: string;
  name: string;
  subjectId: string;
  notes: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  fwVersion: string | null;
  dashboardVersion: string;
  streams: RecordingMeta['streams'];
  files: FileEntry[];
  summary: ManifestSummary;
  notes_on_unsupported_columns: string[];
}

// Time-ordered events written to replay.json.
export type ReplayEventKind =
  | 'raw'
  | 'beat'
  | 'sqi'
  | 'battery'
  | 'filtered'
  | 'polarBeat'
  | 'acc'
  | 'metric'
  | 'annotation'
  | 'config';

export interface ReplayEvent {
  t: number;
  kind: ReplayEventKind;
  payload: unknown;
}

// Loaded session — fully parsed in memory by ReplayPlayer.
export interface LoadedSession {
  manifest: RecordingManifest | null;
  raw: Array<{ timestamp: number; sample: NarbisRawSample }>;
  beats: BeatRecord[];
  sqi: SqiRecord[];
  battery: BatteryRecord[];
  filtered: FilteredRecord[];
  polarBeats: PolarBeatRecordTimed[];
  accPackets: AccPacketRecord[];
  metrics: MetricsRecord[];
  annotations: Annotation[];
  configEvents: ConfigChangeEntry[];
  startedAt: number;
  endedAt: number;
}

// Re-exports used by the writers so they only need to import this one module.
export type { NarbisRawSample, NarbisSqiPayload, DiagnosticSample, NarbisRuntimeConfig };
export type { NarbisBeatEvent };
export type { PolarBeatRecord };
export type { MetricsSnapshot };
