import type {
  NarbisRuntimeConfig,
  NarbisRawSample,
  NarbisSqiPayload,
  DiagnosticSample,
} from '../ble/parsers';
import type { NarbisBeatEvent } from '../ble/narbisDevice';
import type { V2Status } from '../ble/v2/protocol';
import type { OximeterReading } from '../ble/innovoOximeter';
import type { GuidedEventDetail } from '../guided/bus';
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
  /** Pipe-joined flag names ("LOW_SQI|LOW_CONFIDENCE") or "" when no flags
   * set, in the recording earclip's own vocabulary (V2: "GATED|ARTIFACT"). */
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

/** One V2.1 (AFE4404) PPG notification, stored whole and expanded to one row
 * per sample only at export. Device fields are verbatim from the firmware;
 * `hostFirstMs` is sample 0 on the host timeline (device-clock anchored, the
 * same anchor the beats use, so PPG and beats line up exactly). */
export interface V2PpgBatchRecord {
  hostFirstMs: number;
  periodMs: number;
  seq: number;
  t0Us: number;
  rateCode: number;
  flags: number;
  ir: number[];
  red: number[];
  amb: number[] | null;
  /** Drive state from the latest STATUS (≤1 s stale — exact AGC step times
   * are in the events stream). Null until the first STATUS arrives. */
  ledIrMa: number | null;
  ledRedMa: number | null;
  tiaGainCode: number | null;
}

export interface V2StatusRecord extends V2Status {
  timestamp: number;
}

/** One reference-oximeter reading (ble/innovoOximeter.ts), once a second, host arrival time. */
export interface OximeterRecord extends OximeterReading {
  timestamp: number;
  /** The packet as received, lowercase hex: its layout is a third party's decode. */
  hex: string;
}

/** A block of H10 raw ECG (µV) on the PTT clock (state/pttState.ts): sample i at t0 + i·periodMs. */
export interface EcgBlockRecord {
  t0: number;
  periodMs: number;
  samples: number[];
}

/** An R-peak found in the H10 ECG (metrics/ecgRpeak.ts). */
export interface RPeakRecord {
  timestamp: number;
  rr: number | null;
  amp: number;
}

/** One pulse arrival time: H10 ECG R-peak → earclip beat (metrics/ptt.ts). */
export interface PatRecord {
  /** The earclip beat, corrected clock. */
  timestamp: number;
  pat: number;
  motion: boolean;
}

/** Reference-oximeter pleth samples (0..255) from one notification, host arrival time. */
export interface OximeterPlethRecord {
  timestamp: number;
  values: number[];
}

/** One V2.1 accelerometer notification (raw LIS2DH12 counts), stored whole. */
export interface V2AccelBatchRecord {
  hostFirstMs: number;
  periodMs: number;
  seq: number;
  t0Us: number;
  odrCode: number;
  flags: number;
  x: number[];
  y: number[];
  z: number[];
}

export interface V2IbiRecordTimed {
  /** Host ms of the beat (device-clock anchored). */
  timestamp: number;
  seq: number;
  tBeatUs: number;
  ibiMs: number;
  confidence: number;
  flags: number;
}

export interface V2EventRecordTimed {
  /** Device-anchored host ms when known, otherwise the arrival time. */
  timestamp: number;
  arrivalMs: number;
  seq: number;
  type: number;
  typeName: string;
  tUs: number | null;
  fields: Record<string, number>;
  rawHex: string;
}

/** BLE/system log lines captured during the recording (connects, errors,
 * lost-batch warnings) so a capture explains its own gaps. */
export interface BleLogRecord {
  timestamp: number;
  source: string;
  level: string;
  message: string;
}

/** One guided-protocol event (block start/end, cue, pause, session start/end)
 * as the session published it; session_start carries the whole protocol. */
export type ProtocolEventRecord = GuidedEventDetail;

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
  v2Ppg?: V2PpgBatchRecord[];
  v2Accel?: V2AccelBatchRecord[];
  v2Status?: V2StatusRecord[];
  v2Ibi?: V2IbiRecordTimed[];
  v2Events?: V2EventRecordTimed[];
  oximeter?: OximeterRecord[];
  oximeterPleth?: OximeterPlethRecord[];
  ecg?: EcgBlockRecord[];
  rPeaks?: RPeakRecord[];
  pat?: PatRecord[];
  bleLog?: BleLogRecord[];
  protocolEvents?: ProtocolEventRecord[];
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
