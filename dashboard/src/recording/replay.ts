import JSZip from 'jszip';
import { useDashboardStore, setReplayBattery } from '../state/store';
import { metricsBuffers } from '../state/metricsBuffer';
import { METRICS_WINDOW_SEC } from '../state/metricsRunner';
import { extractIbiWindow } from '../metrics/windowing';
import MetricsWorker from '../workers/metricsWorker?worker';
import type { MetricsRequest, MetricsResult } from '../workers/metricsWorker';
import { snapshotFromResult } from '../state/metricsBuffer';
import type {
  Annotation,
  BatteryRecord,
  BeatRecord,
  ConfigChangeEntry,
  FilteredRecord,
  LoadedSession,
  MetricsRecord,
  PolarBeatRecordTimed,
  RawSampleRecord,
  RecordingManifest,
  ReplayEvent,
  SqiRecord,
} from './types';
import { FILE_NAMES } from './format';
import type { NarbisBeatEvent } from '../ble/narbisDevice';

export async function parseSessionFromJson(text: string): Promise<LoadedSession> {
  const events = JSON.parse(text) as ReplayEvent[];
  return loadedFromEvents(events, null);
}

export async function parseSessionFromZip(blob: Blob): Promise<LoadedSession> {
  const zip = await JSZip.loadAsync(blob);
  let manifest: RecordingManifest | null = null;
  let replayText: string | null = null;

  // Find the path of replay.json regardless of containing folder.
  const paths: string[] = [];
  zip.forEach((path) => paths.push(path));
  const replayPath = paths.find((p) => p.endsWith(FILE_NAMES.replay));
  if (!replayPath) throw new Error('replay.json not found in zip');
  const replayFile = zip.file(replayPath);
  if (!replayFile) throw new Error('replay.json not readable');
  replayText = await replayFile.async('string');

  const folder = replayPath.endsWith('/' + FILE_NAMES.replay)
    ? replayPath.slice(0, replayPath.length - FILE_NAMES.replay.length)
    : '';
  const manifestFile = zip.file(folder + FILE_NAMES.manifest);
  if (manifestFile) {
    const text = await manifestFile.async('string');
    try {
      manifest = JSON.parse(text) as RecordingManifest;
    } catch {
      manifest = null;
    }
  }
  const events = JSON.parse(replayText) as ReplayEvent[];
  return loadedFromEvents(events, manifest);
}

function loadedFromEvents(
  events: ReplayEvent[],
  manifest: RecordingManifest | null,
): LoadedSession {
  events.sort((a, b) => a.t - b.t);
  const raw: Array<{ timestamp: number; sample: { red: number; ir: number } }> = [];
  const beats: BeatRecord[] = [];
  const sqi: SqiRecord[] = [];
  const battery: BatteryRecord[] = [];
  const filtered: FilteredRecord[] = [];
  const polarBeats: PolarBeatRecordTimed[] = [];
  const metrics: MetricsRecord[] = [];
  const annotations: Annotation[] = [];
  const configEvents: ConfigChangeEntry[] = [];
  for (const e of events) {
    switch (e.kind) {
      case 'raw': {
        const r = e.payload as RawSampleRecord;
        raw.push({ timestamp: r.timestamp, sample: { red: r.red, ir: r.ir } });
        break;
      }
      case 'beat':
        beats.push(e.payload as BeatRecord);
        break;
      case 'sqi':
        sqi.push(e.payload as SqiRecord);
        break;
      case 'battery':
        battery.push(e.payload as BatteryRecord);
        break;
      case 'filtered':
        filtered.push(e.payload as FilteredRecord);
        break;
      case 'polarBeat':
        polarBeats.push(e.payload as PolarBeatRecordTimed);
        break;
      case 'metric':
        metrics.push(e.payload as MetricsRecord);
        break;
      case 'annotation':
        annotations.push(e.payload as Annotation);
        break;
      case 'config':
        configEvents.push(e.payload as ConfigChangeEntry);
        break;
    }
  }
  const startedAt = manifest?.startedAt ?? (events.length > 0 ? events[0].t : 0);
  const endedAt = manifest?.endedAt ?? (events.length > 0 ? events[events.length - 1].t : 0);
  return {
    manifest,
    raw,
    beats,
    sqi,
    battery,
    filtered,
    polarBeats,
    metrics,
    annotations,
    configEvents,
    startedAt,
    endedAt,
  };
}

const RAW_WINDOW_SEC = 30;
const BEAT_WINDOW_SEC = 300;
const FILTERED_WINDOW_SEC = 30;
const METRICS_DISPLAY_WINDOW_SEC = 600;

export class ReplayPlayer {
  private session: LoadedSession;
  private positionMs: number;
  private speed: 1 | 2 | 5 | 10 = 1;
  private playing = false;
  private rafId: number | null = null;
  private lastFrameMs = 0;
  private listeners = new Set<(pos: number) => void>();

  constructor(session: LoadedSession) {
    this.session = session;
    this.positionMs = 0;
    this.rebuildBuffers();
  }

  get duration_ms(): number {
    return Math.max(0, this.session.endedAt - this.session.startedAt);
  }

  get position_ms(): number {
    return this.positionMs;
  }

  get speedMultiplier(): 1 | 2 | 5 | 10 {
    return this.speed;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get loaded(): LoadedSession {
    return this.session;
  }

  setSpeed(s: 1 | 2 | 5 | 10): void {
    this.speed = s;
  }

  play(): void {
    if (this.playing) return;
    this.playing = true;
    this.lastFrameMs = performance.now();
    this.rafId = requestAnimationFrame(this.frame);
  }

  pause(): void {
    this.playing = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  seek(ms: number): void {
    this.positionMs = clamp(ms, 0, this.duration_ms);
    this.rebuildBuffers();
    this.notify();
  }

  onTick(cb: (pos: number) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  dispose(): void {
    this.pause();
    this.listeners.clear();
  }

  private frame = (now: number): void => {
    if (!this.playing) return;
    const dt = now - this.lastFrameMs;
    this.lastFrameMs = now;
    const advance = dt * this.speed;
    const newPos = this.positionMs + advance;
    if (newPos >= this.duration_ms) {
      this.positionMs = this.duration_ms;
      this.rebuildBuffers();
      this.playing = false;
      this.rafId = null;
      this.notify();
      return;
    }
    this.positionMs = newPos;
    this.rebuildBuffers();
    this.notify();
    this.rafId = requestAnimationFrame(this.frame);
  };

  private notify(): void {
    for (const cb of this.listeners) cb(this.positionMs);
  }

  /**
   * Rebuild the replay buffers to reflect a window ending at the current virtual position.
   * Charts read from these buffers exactly as they do for live data.
   */
  private rebuildBuffers(): void {
    const bufs = useDashboardStore.getState().replayBuffers;
    const tEnd = this.session.startedAt + this.positionMs;
    bufs.rawPpg.clear();
    bufs.narbisBeats.clear();
    bufs.sqi.clear();
    bufs.filtered.clear();
    bufs.polarBeats.clear();
    metricsBuffers.replay.clear();

    pushWindow(this.session.raw, tEnd, RAW_WINDOW_SEC, (e) =>
      bufs.rawPpg.push(e.timestamp, e.sample),
    );
    pushWindow(this.session.beats, tEnd, BEAT_WINDOW_SEC, (b) =>
      bufs.narbisBeats.push(b.timestamp, beatRecordToEvent(b)),
    );
    pushWindow(this.session.sqi, tEnd, BEAT_WINDOW_SEC, (s) => bufs.sqi.push(s.timestamp, s));
    pushWindow(this.session.filtered, tEnd, FILTERED_WINDOW_SEC, (f) =>
      bufs.filtered.push(f.timestamp, f.sample),
    );
    pushWindow(this.session.polarBeats, tEnd, BEAT_WINDOW_SEC, (p) =>
      bufs.polarBeats.push(p.timestamp, { bpm: p.bpm, rr: p.rr }),
    );
    pushWindow(
      this.session.metrics,
      tEnd,
      METRICS_DISPLAY_WINDOW_SEC,
      (m) => metricsBuffers.replay.push(m.timestamp, m.snapshot),
    );

    /* Battery is sparse (every ~30 s) — find the most-recent record at or
     * before tEnd and surface it on the connection panel during playback. */
    const b = latestAtOrBefore(this.session.battery, tEnd);
    if (b) {
      setReplayBattery({ soc_pct: b.soc_pct, mv: b.mv, charging: b.charging });
    } else {
      setReplayBattery(null);
    }
  }
}

function latestAtOrBefore<T extends { timestamp: number }>(
  arr: T[],
  tEnd: number,
): T | null {
  if (arr.length === 0) return null;
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].timestamp <= tEnd) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? arr[lo - 1] : null;
}

function beatRecordToEvent(b: BeatRecord): NarbisBeatEvent {
  return {
    bpm: b.bpm,
    ibi_ms: b.ibi_ms,
    confidence: b.confidence,
    flags: b.flags,
    sqi: b.sqi,
    timestamp: b.timestamp,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

function pushWindow<T extends { timestamp: number }>(
  arr: T[],
  tEnd: number,
  windowSec: number,
  push: (item: T) => void,
): void {
  if (arr.length === 0) return;
  const tStart = tEnd - windowSec * 1000;
  // Binary-search for tStart, then push everything ≤ tEnd.
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].timestamp < tStart) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < arr.length; i++) {
    if (arr[i].timestamp > tEnd) break;
    push(arr[i]);
  }
}

/**
 * One-shot recompute of metrics over a session's beats with a given window.
 * Pushes synthesized snapshots into metricsBuffers.replay (clearing it first).
 */
export async function recomputeMetrics(
  session: LoadedSession,
  windowSec: number,
  stepSec = 1,
): Promise<void> {
  metricsBuffers.replay.clear();
  if (session.beats.length === 0) return;
  const start = session.startedAt;
  const end = session.endedAt;
  const worker = new MetricsWorker() as Worker;
  let nextRequestId = 1;
  const pending = new Map<
    number,
    { resolve: (r: MetricsResult) => void; reject: (err: Error) => void }
  >();
  worker.addEventListener('message', (ev: MessageEvent<MetricsResult>) => {
    const r = ev.data;
    if (!r || r.type !== 'result') return;
    const cb = pending.get(r.requestId);
    if (cb) {
      cb.resolve(r);
      pending.delete(r.requestId);
    }
  });

  function compute(
    times_s: Float64Array,
    ibis_ms: Float64Array,
    beat_ms: Float64Array,
  ): Promise<MetricsResult> {
    const requestId = nextRequestId++;
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      const msg: MetricsRequest = { type: 'compute', requestId, times_s, ibis_ms, beat_ms };
      worker.postMessage(msg, [times_s.buffer, ibis_ms.buffer, beat_ms.buffer]);
    });
  }

  try {
    const beatEvents = session.beats.map(beatRecordToEvent);
    for (let t = start + windowSec * 1000; t <= end; t += stepSec * 1000) {
      const { times_s, ibis_ms, beat_ms } = extractIbiWindow(beatEvents, windowSec, t);
      if (times_s.length < 4) continue;
      const result = await compute(times_s, ibis_ms, beat_ms);
      metricsBuffers.replay.push(t, snapshotFromResult(result));
    }
  } finally {
    worker.terminate();
  }
}

export function defaultRecomputeWindow(): number {
  return METRICS_WINDOW_SEC;
}
