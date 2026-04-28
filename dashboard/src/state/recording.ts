import { create } from 'zustand';
import {
  narbisDevice,
  type NarbisBeatEvent,
  type NarbisRawSampleEvent,
  type NarbisSqiEvent,
  type NarbisDiagnosticEvent,
} from '../ble/narbisDevice';
import { polarH10, type PolarBeatEvent } from '../ble/polarH10';
import {
  metricsRunner,
  METRICS_WINDOW_SEC,
  type MetricsUpdatedDetail,
} from './metricsRunner';
import {
  isArtifactBeat,
} from '../metrics/windowing';
import {
  NARBIS_BEAT_FLAG_ARTIFACT,
  NARBIS_BEAT_FLAG_LOW_SQI,
  NARBIS_BEAT_FLAG_INTERPOLATED,
  NARBIS_BEAT_FLAG_LOW_CONFIDENCE,
  type NarbisRuntimeConfig,
} from '../ble/parsers';
import { useDashboardStore, setRecordingState } from './store';
import {
  getDb,
  STORE_RECORDING_SESSIONS,
  STORE_RECORDING_CHUNKS,
  STORE_RECORDING_BLOBS,
} from './idb';
import {
  RECORDING_SCHEMA_VERSION,
} from '../recording/manifest';
import type {
  Annotation,
  AnnotationEventType,
  BeatRecord,
  ConfigChangeEntry,
  FilteredRecord,
  ManifestSummary,
  MetricsRecord,
  PolarBeatRecordTimed,
  RawSampleRecord,
  RecordingChunk,
  RecordingMeta,
  RecordingPhase,
  RecordingSessionRow,
  SessionStatus,
  SqiRecord,
} from '../recording/types';
import { deleteChunks } from '../recording/aggregator';
import { exportSession } from '../recording/export';

const FLUSH_INTERVAL_MS = 10_000;
const DASHBOARD_VERSION = '0.0.0';

const DEFAULT_STREAMS: RecordingMeta['streams'] = {
  raw: true,
  beats: true,
  sqi: true,
  filtered: true,
  polar: true,
  metrics: true,
};

const DEFAULT_META: RecordingMeta = {
  name: '',
  subjectId: '',
  notes: '',
  streams: DEFAULT_STREAMS,
};

export interface RecordingCounts {
  raw: number;
  beats: number;
  sqi: number;
  filtered: number;
  polarBeats: number;
  metrics: number;
  annotations: number;
}

export interface PendingRecovery {
  sessionId: string;
  startedAt: number;
  chunkCount: number;
  name: string;
  subjectId: string;
}

export interface RecordingStoreState {
  phase: RecordingPhase;
  sessionId: string | null;
  startedAt: number | null;
  endedAt: number | null;
  meta: RecordingMeta | null;
  counts: RecordingCounts;
  byteEstimate: number;
  lastError: string | null;
  finalSummary: ManifestSummary | null;
  finalBlob: Blob | null;
  finalFilename: string | null;
  pendingRecovery: PendingRecovery | null;
  // actions
  openPreRecording: () => void;
  cancelPreRecording: () => void;
  startRecording: (meta: RecordingMeta) => Promise<void>;
  stopRecording: () => Promise<void>;
  abortRecording: () => Promise<void>;
  addAnnotation: (text: string, eventType?: AnnotationEventType) => void;
  resetToIdle: () => void;
  checkForOrphanedSessions: () => Promise<void>;
  recoverSession: (sessionId: string) => Promise<void>;
  discardSession: (sessionId: string) => Promise<void>;
}

const ZERO_COUNTS: RecordingCounts = {
  raw: 0,
  beats: 0,
  sqi: 0,
  filtered: 0,
  polarBeats: 0,
  metrics: 0,
  annotations: 0,
};

class SessionAccumulator {
  raw: RawSampleRecord[] = [];
  beats: BeatRecord[] = [];
  sqi: SqiRecord[] = [];
  filtered: FilteredRecord[] = [];
  polarBeats: PolarBeatRecordTimed[] = [];
  metrics: MetricsRecord[] = [];
  annotations: Annotation[] = [];
  configEvents: ConfigChangeEntry[] = [];

  isEmpty(): boolean {
    return (
      this.raw.length === 0 &&
      this.beats.length === 0 &&
      this.sqi.length === 0 &&
      this.filtered.length === 0 &&
      this.polarBeats.length === 0 &&
      this.metrics.length === 0 &&
      this.annotations.length === 0 &&
      this.configEvents.length === 0
    );
  }

  reset(): void {
    this.raw = [];
    this.beats = [];
    this.sqi = [];
    this.filtered = [];
    this.polarBeats = [];
    this.metrics = [];
    this.annotations = [];
    this.configEvents = [];
  }
}

interface RecorderRuntime {
  sessionId: string;
  startedAt: number;
  meta: RecordingMeta;
  acc: SessionAccumulator;
  flushTimer: ReturnType<typeof setInterval> | null;
  flushInFlight: boolean;
  chunkSeq: number;
  rawSampleIndex: number;
  lastSqi: { dc_red: number; dc_ir: number } | null;
  lastConfig: NarbisRuntimeConfig | null;
  channelUsed: string;
  recentSqiX100: Array<{ timestamp: number; sqi_x100: number }>; // for sqi_avg per metric
  byteEstimate: number;
  // listener references for tear-down
  onBeat: (e: Event) => void;
  onRaw: (e: Event) => void;
  onSqi: (e: Event) => void;
  onDiag: (e: Event) => void;
  onConfig: (e: Event) => void;
  onPolar: (e: Event) => void;
  onMetric: (e: Event) => void;
}

let runtime: RecorderRuntime | null = null;

function flagsToReason(flags: number): string {
  const out: string[] = [];
  if (flags & NARBIS_BEAT_FLAG_ARTIFACT) out.push('ARTIFACT');
  if (flags & NARBIS_BEAT_FLAG_LOW_SQI) out.push('LOW_SQI');
  if (flags & NARBIS_BEAT_FLAG_INTERPOLATED) out.push('INTERPOLATED');
  if (flags & NARBIS_BEAT_FLAG_LOW_CONFIDENCE) out.push('LOW_CONFIDENCE');
  return out.join('|');
}

function approxJsonBytes(value: unknown): number {
  // Rough estimate without actually serializing — good enough for the UI HUD.
  if (value === null || value === undefined) return 4;
  if (typeof value === 'number') return 8;
  if (typeof value === 'string') return value.length + 2;
  if (typeof value === 'boolean') return 5;
  if (Array.isArray(value)) {
    let n = 2;
    for (const v of value) n += approxJsonBytes(v) + 1;
    return n;
  }
  if (typeof value === 'object') {
    let n = 2;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      n += k.length + 3 + approxJsonBytes(v) + 1;
    }
    return n;
  }
  return 8;
}

async function writeSessionRow(row: RecordingSessionRow): Promise<void> {
  const db = await getDb();
  await db.put(STORE_RECORDING_SESSIONS, row);
}

async function readSessionRow(id: string): Promise<RecordingSessionRow | null> {
  const db = await getDb();
  const row = (await db.get(STORE_RECORDING_SESSIONS, id)) as RecordingSessionRow | undefined;
  return row ?? null;
}

async function listSessionRowsByStatus(status: SessionStatus): Promise<RecordingSessionRow[]> {
  const db = await getDb();
  const rows = (await db.getAll(STORE_RECORDING_SESSIONS)) as RecordingSessionRow[];
  return rows.filter((r) => r.status === status);
}

async function persistChunk(chunk: RecordingChunk): Promise<void> {
  const db = await getDb();
  await db.put(STORE_RECORDING_CHUNKS, chunk);
}

async function persistBlob(sessionId: string, blob: Blob): Promise<void> {
  const db = await getDb();
  await db.put(STORE_RECORDING_BLOBS, { id: sessionId, blob });
}

async function deleteSessionRow(sessionId: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORE_RECORDING_SESSIONS, sessionId);
}

async function deleteSessionBlob(sessionId: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORE_RECORDING_BLOBS, sessionId);
}

async function countChunks(sessionId: string): Promise<number> {
  const db = await getDb();
  const tx = db.transaction(STORE_RECORDING_CHUNKS, 'readonly');
  const idx = tx.store.index('by_session');
  return await idx.count(sessionId);
}

export const useRecordingStore = create<RecordingStoreState>((set, get) => ({
  phase: 'IDLE',
  sessionId: null,
  startedAt: null,
  endedAt: null,
  meta: null,
  counts: { ...ZERO_COUNTS },
  byteEstimate: 0,
  lastError: null,
  finalSummary: null,
  finalBlob: null,
  finalFilename: null,
  pendingRecovery: null,

  openPreRecording: () => {
    if (get().phase !== 'IDLE') return;
    set({ phase: 'PRE_RECORDING', meta: get().meta ?? DEFAULT_META, lastError: null });
  },

  cancelPreRecording: () => {
    if (get().phase !== 'PRE_RECORDING') return;
    set({ phase: 'IDLE' });
  },

  startRecording: async (meta) => {
    if (get().phase !== 'PRE_RECORDING' && get().phase !== 'IDLE') return;
    const sessionId = `session-${
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2)
    }`;
    const startedAt = Date.now();
    const initialConfig = useDashboardStore.getState().config;

    const row: RecordingSessionRow = {
      id: sessionId,
      name: meta.name || 'Untitled session',
      subjectId: meta.subjectId,
      notes: meta.notes,
      startedAt,
      endedAt: null,
      status: 'recording',
      schemaVersion: RECORDING_SCHEMA_VERSION,
      configInitial: initialConfig,
      fwVersion: null,
      dashboardVersion: DASHBOARD_VERSION,
      streams: meta.streams,
      summary: null,
    };

    try {
      await writeSessionRow(row);
    } catch (err) {
      set({ lastError: errMsg(err), phase: 'IDLE' });
      throw err;
    }

    runtime = createRuntime(sessionId, startedAt, meta, initialConfig);
    attachListeners(runtime);
    runtime.flushTimer = setInterval(() => void flushChunk(), FLUSH_INTERVAL_MS);

    set({
      phase: 'RECORDING',
      sessionId,
      startedAt,
      endedAt: null,
      meta,
      counts: { ...ZERO_COUNTS },
      byteEstimate: 0,
      lastError: null,
      finalSummary: null,
      finalBlob: null,
      finalFilename: null,
    });
    setRecordingState(true, startedAt);
  },

  stopRecording: async () => {
    if (get().phase !== 'RECORDING') return;
    const r = runtime;
    if (!r) return;
    detachListeners(r);
    if (r.flushTimer) {
      clearInterval(r.flushTimer);
      r.flushTimer = null;
    }
    set({ phase: 'FINALIZING' });
    setRecordingState(false, null);

    try {
      await flushChunk();
      const endedAt = Date.now();
      const sessionRow = await readSessionRow(r.sessionId);
      if (!sessionRow) throw new Error(`session ${r.sessionId} disappeared from IDB`);
      const finalized: RecordingSessionRow = { ...sessionRow, status: 'finalizing', endedAt };
      await writeSessionRow(finalized);
      const { blob, filename, summary } = await exportSession(r.sessionId);
      await persistBlob(r.sessionId, blob);
      const completed: RecordingSessionRow = { ...finalized, status: 'complete', summary };
      await writeSessionRow(completed);
      runtime = null;
      set({
        phase: 'COMPLETE',
        endedAt,
        finalSummary: summary,
        finalBlob: blob,
        finalFilename: filename,
      });
    } catch (err) {
      set({ phase: 'COMPLETE', lastError: errMsg(err) });
    }
  },

  abortRecording: async () => {
    const r = runtime;
    if (r) {
      detachListeners(r);
      if (r.flushTimer) {
        clearInterval(r.flushTimer);
        r.flushTimer = null;
      }
      runtime = null;
    }
    const sessionId = get().sessionId;
    set({
      phase: 'IDLE',
      sessionId: null,
      startedAt: null,
      endedAt: null,
      meta: null,
      counts: { ...ZERO_COUNTS },
      byteEstimate: 0,
      finalSummary: null,
      finalBlob: null,
      finalFilename: null,
    });
    setRecordingState(false, null);
    if (sessionId) {
      const row = await readSessionRow(sessionId);
      if (row) await writeSessionRow({ ...row, status: 'aborted', endedAt: Date.now() });
      await deleteChunks(sessionId);
    }
  },

  addAnnotation: (text, eventType = 'text') => {
    if (get().phase !== 'RECORDING') return;
    const r = runtime;
    if (!r) return;
    const ann: Annotation = {
      timestamp: Date.now(),
      text,
      eventType,
      source: 'user',
    };
    r.acc.annotations.push(ann);
    bump(r, 'annotations', approxJsonBytes(ann));
  },

  resetToIdle: () => {
    const blob = get().finalBlob;
    if (blob) {
      // No URL to revoke (we never created one); just drop the reference.
    }
    set({
      phase: 'IDLE',
      sessionId: null,
      startedAt: null,
      endedAt: null,
      meta: null,
      counts: { ...ZERO_COUNTS },
      byteEstimate: 0,
      finalSummary: null,
      finalBlob: null,
      finalFilename: null,
    });
  },

  checkForOrphanedSessions: async () => {
    try {
      const orphans = await listSessionRowsByStatus('recording');
      if (orphans.length === 0) {
        if (get().pendingRecovery) set({ pendingRecovery: null });
        return;
      }
      // Pick the most recent orphan; the user can finalize/discard it then we re-check.
      orphans.sort((a, b) => b.startedAt - a.startedAt);
      const o = orphans[0];
      const chunkCount = await countChunks(o.id);
      set({
        pendingRecovery: {
          sessionId: o.id,
          startedAt: o.startedAt,
          chunkCount,
          name: o.name,
          subjectId: o.subjectId,
        },
      });
    } catch (err) {
      set({ lastError: errMsg(err) });
    }
  },

  recoverSession: async (sessionId) => {
    set({ phase: 'FINALIZING', pendingRecovery: null });
    try {
      const row = await readSessionRow(sessionId);
      if (!row) throw new Error(`session ${sessionId} not found`);
      const endedAt = Date.now();
      const finalizing: RecordingSessionRow = { ...row, status: 'finalizing', endedAt };
      await writeSessionRow(finalizing);
      const { blob, filename, summary } = await exportSession(sessionId);
      await persistBlob(sessionId, blob);
      const completed: RecordingSessionRow = { ...finalizing, status: 'complete', summary };
      await writeSessionRow(completed);
      set({
        phase: 'COMPLETE',
        sessionId,
        startedAt: row.startedAt,
        endedAt,
        meta: {
          name: row.name,
          subjectId: row.subjectId,
          notes: row.notes,
          streams: row.streams,
        },
        finalSummary: summary,
        finalBlob: blob,
        finalFilename: filename,
      });
    } catch (err) {
      set({ phase: 'IDLE', lastError: errMsg(err) });
    }
  },

  discardSession: async (sessionId) => {
    try {
      await deleteChunks(sessionId);
      await deleteSessionBlob(sessionId);
      await deleteSessionRow(sessionId);
      const cur = get().pendingRecovery;
      if (cur && cur.sessionId === sessionId) set({ pendingRecovery: null });
    } catch (err) {
      set({ lastError: errMsg(err) });
    }
  },
}));

function createRuntime(
  sessionId: string,
  startedAt: number,
  meta: RecordingMeta,
  initialConfig: NarbisRuntimeConfig | null,
): RecorderRuntime {
  const acc = new SessionAccumulator();
  if (initialConfig) {
    acc.configEvents.push({ timestamp: startedAt, config: initialConfig });
  }
  const r: RecorderRuntime = {
    sessionId,
    startedAt,
    meta,
    acc,
    flushTimer: null,
    flushInFlight: false,
    chunkSeq: 0,
    rawSampleIndex: 0,
    lastSqi: null,
    lastConfig: initialConfig,
    channelUsed: 'ir',
    recentSqiX100: [],
    byteEstimate: 0,
    onBeat: () => {},
    onRaw: () => {},
    onSqi: () => {},
    onDiag: () => {},
    onConfig: () => {},
    onPolar: () => {},
    onMetric: () => {},
  };
  r.onBeat = makeOnBeat(r);
  r.onRaw = makeOnRaw(r);
  r.onSqi = makeOnSqi(r);
  r.onDiag = makeOnDiag(r);
  r.onConfig = makeOnConfig(r);
  r.onPolar = makeOnPolar(r);
  r.onMetric = makeOnMetric(r);
  return r;
}

function attachListeners(r: RecorderRuntime): void {
  if (r.meta.streams.beats) narbisDevice.addEventListener('beatReceived', r.onBeat);
  if (r.meta.streams.raw) narbisDevice.addEventListener('rawSampleReceived', r.onRaw);
  if (r.meta.streams.sqi) narbisDevice.addEventListener('sqiReceived', r.onSqi);
  if (r.meta.streams.filtered) narbisDevice.addEventListener('diagnosticReceived', r.onDiag);
  narbisDevice.addEventListener('configChanged', r.onConfig);
  if (r.meta.streams.polar) polarH10.addEventListener('beatReceived', r.onPolar);
  if (r.meta.streams.metrics) metricsRunner.addEventListener('metricsUpdated', r.onMetric);
}

function detachListeners(r: RecorderRuntime): void {
  narbisDevice.removeEventListener('beatReceived', r.onBeat);
  narbisDevice.removeEventListener('rawSampleReceived', r.onRaw);
  narbisDevice.removeEventListener('sqiReceived', r.onSqi);
  narbisDevice.removeEventListener('diagnosticReceived', r.onDiag);
  narbisDevice.removeEventListener('configChanged', r.onConfig);
  polarH10.removeEventListener('beatReceived', r.onPolar);
  metricsRunner.removeEventListener('metricsUpdated', r.onMetric);
}

function makeOnBeat(r: RecorderRuntime) {
  return (ev: Event) => {
    const beat = (ev as CustomEvent<NarbisBeatEvent>).detail;
    const rec: BeatRecord = {
      ...beat,
      is_artifact: isArtifactBeat(beat),
      rejection_reason: flagsToReason(beat.flags),
      channel_used: r.channelUsed,
    };
    r.acc.beats.push(rec);
    bump(r, 'beats', 100);
  };
}

function makeOnRaw(r: RecorderRuntime) {
  return (ev: Event) => {
    const raw = (ev as CustomEvent<NarbisRawSampleEvent>).detail;
    const baseTs = raw.timestamp;
    const periodMs = raw.sample_rate_hz > 0 ? 1000 / raw.sample_rate_hz : 0;
    const dc_red = r.lastSqi?.dc_red ?? null;
    const dc_ir = r.lastSqi?.dc_ir ?? null;
    const led_red_ma = r.lastConfig ? r.lastConfig.led_red_ma_x10 / 10 : null;
    const led_ir_ma = r.lastConfig ? r.lastConfig.led_ir_ma_x10 / 10 : null;
    for (let i = 0; i < raw.samples.length; i++) {
      const ts = baseTs - (raw.samples.length - 1 - i) * periodMs;
      r.acc.raw.push({
        timestamp: ts,
        sample_index: r.rawSampleIndex++,
        red: raw.samples[i].red,
        ir: raw.samples[i].ir,
        dc_red,
        dc_ir,
        led_red_ma,
        led_ir_ma,
      });
    }
    bump(r, 'raw', 80 * raw.samples.length);
  };
}

function makeOnSqi(r: RecorderRuntime) {
  return (ev: Event) => {
    const sqi = (ev as CustomEvent<NarbisSqiEvent>).detail;
    const rec: SqiRecord = {
      timestamp: sqi.timestamp,
      sqi_x100: sqi.sqi_x100,
      dc_red: sqi.dc_red,
      dc_ir: sqi.dc_ir,
      perfusion_idx_x1000: sqi.perfusion_idx_x1000,
    };
    r.acc.sqi.push(rec);
    r.lastSqi = { dc_red: sqi.dc_red, dc_ir: sqi.dc_ir };
    r.recentSqiX100.push({ timestamp: sqi.timestamp, sqi_x100: sqi.sqi_x100 });
    pruneRecentSqi(r);
    bump(r, 'sqi', 64);
  };
}

function makeOnDiag(r: RecorderRuntime) {
  return (ev: Event) => {
    const diag = (ev as CustomEvent<NarbisDiagnosticEvent>).detail;
    for (const s of diag.samples) {
      r.acc.filtered.push({ timestamp: s.timestamp, sample: s });
    }
    bump(r, 'filtered', 32 * diag.samples.length);
  };
}

function makeOnConfig(r: RecorderRuntime) {
  return (ev: Event) => {
    const cfg = (ev as CustomEvent<NarbisRuntimeConfig>).detail;
    r.lastConfig = cfg;
    r.acc.configEvents.push({ timestamp: Date.now(), config: cfg });
    // (channel_used could be derived from a config field if/when one exists.)
    bump(r, null, 256);
  };
}

function makeOnPolar(r: RecorderRuntime) {
  return (ev: Event) => {
    const beat = (ev as CustomEvent<PolarBeatEvent>).detail;
    r.acc.polarBeats.push({
      timestamp: beat.timestamp,
      bpm: beat.bpm,
      rr: beat.rrIntervals_ms.slice(),
    });
    bump(r, 'polarBeats', 48 + beat.rrIntervals_ms.length * 6);
  };
}

function makeOnMetric(r: RecorderRuntime) {
  return (ev: Event) => {
    const detail = (ev as CustomEvent<MetricsUpdatedDetail>).detail;
    const sqiAvg = computeSqiAvg(r, detail.timestamp, METRICS_WINDOW_SEC);
    r.acc.metrics.push({
      timestamp: detail.timestamp,
      window_seconds: METRICS_WINDOW_SEC,
      snapshot: detail.snapshot,
      sqi_avg: sqiAvg,
    });
    bump(r, 'metrics', 128);
  };
}

function computeSqiAvg(r: RecorderRuntime, nowMs: number, windowSec: number): number | null {
  const cutoff = nowMs - windowSec * 1000;
  let sum = 0;
  let count = 0;
  for (const s of r.recentSqiX100) {
    if (s.timestamp >= cutoff) {
      sum += s.sqi_x100;
      count += 1;
    }
  }
  return count > 0 ? sum / count : null;
}

function pruneRecentSqi(r: RecorderRuntime): void {
  // Keep only the last 5 minutes; far more than we ever look back.
  const cutoff = Date.now() - 5 * 60 * 1000;
  while (r.recentSqiX100.length && r.recentSqiX100[0].timestamp < cutoff) {
    r.recentSqiX100.shift();
  }
}

function bump(r: RecorderRuntime, key: keyof RecordingCounts | null, bytes: number): void {
  r.byteEstimate += bytes;
  if (key !== null) {
    const cur = useRecordingStore.getState().counts;
    useRecordingStore.setState({
      counts: { ...cur, [key]: cur[key] + 1 },
      byteEstimate: r.byteEstimate,
    });
  } else {
    useRecordingStore.setState({ byteEstimate: r.byteEstimate });
  }
}

async function flushChunk(): Promise<void> {
  const r = runtime;
  if (!r) return;
  // Wait out any in-flight flush so the final flush at stopRecording captures
  // events added after the previous flush's acc.reset().
  while (r.flushInFlight) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  if (r.acc.isEmpty()) return;
  r.flushInFlight = true;
  const seq = r.chunkSeq++;
  const t0 = pickFirstTimestamp(r.acc) ?? r.startedAt;
  const t1 = pickLastTimestamp(r.acc) ?? Date.now();
  const chunk: RecordingChunk = {
    sessionId: r.sessionId,
    chunkSeq: seq,
    t0_ms: t0,
    t1_ms: t1,
  };
  if (r.acc.raw.length) chunk.raw = r.acc.raw;
  if (r.acc.beats.length) chunk.beats = r.acc.beats;
  if (r.acc.sqi.length) chunk.sqi = r.acc.sqi;
  if (r.acc.filtered.length) chunk.filtered = r.acc.filtered;
  if (r.acc.polarBeats.length) chunk.polarBeats = r.acc.polarBeats;
  if (r.acc.metrics.length) chunk.metrics = r.acc.metrics;
  if (r.acc.annotations.length) chunk.annotations = r.acc.annotations;
  if (r.acc.configEvents.length) chunk.configEvents = r.acc.configEvents;
  // Reset before await so events arriving during the write go into the next chunk.
  r.acc.reset();
  try {
    await persistChunk(chunk);
  } catch (err) {
    useRecordingStore.setState({ lastError: errMsg(err) });
  } finally {
    r.flushInFlight = false;
  }
}

function pickFirstTimestamp(acc: SessionAccumulator): number | null {
  const candidates = [
    acc.raw[0]?.timestamp,
    acc.beats[0]?.timestamp,
    acc.sqi[0]?.timestamp,
    acc.filtered[0]?.timestamp,
    acc.polarBeats[0]?.timestamp,
    acc.metrics[0]?.timestamp,
    acc.annotations[0]?.timestamp,
    acc.configEvents[0]?.timestamp,
  ].filter((v): v is number => typeof v === 'number');
  if (candidates.length === 0) return null;
  return Math.min(...candidates);
}

function pickLastTimestamp(acc: SessionAccumulator): number | null {
  const candidates = [
    last(acc.raw)?.timestamp,
    last(acc.beats)?.timestamp,
    last(acc.sqi)?.timestamp,
    last(acc.filtered)?.timestamp,
    last(acc.polarBeats)?.timestamp,
    last(acc.metrics)?.timestamp,
    last(acc.annotations)?.timestamp,
    last(acc.configEvents)?.timestamp,
  ].filter((v): v is number => typeof v === 'number');
  if (candidates.length === 0) return null;
  return Math.max(...candidates);
}

function last<T>(arr: T[]): T | undefined {
  return arr.length > 0 ? arr[arr.length - 1] : undefined;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
