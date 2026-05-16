import { create } from 'zustand';
import {
  narbisDevice,
  type NarbisStatus,
  type NarbisBeatEvent,
  type NarbisRawSampleEvent,
  type NarbisSqiEvent,
  type NarbisBatteryEvent,
  type NarbisDiagnosticEvent,
  type NarbisDisconnectedDetail,
  type NarbisErrorDetail,
  type NarbisPhaseDetail,
} from '../ble/narbisDevice';
import {
  polarH10,
  type PolarStatus,
  type PolarBeatEvent,
  type PolarDisconnectedDetail,
  type PolarErrorDetail,
} from '../ble/polarH10';
import {
  edgeDevice,
  type EdgeStatus,
  type EdgeStatusFrame,
  type EdgeDisconnectedDetail,
  type EdgeErrorDetail,
  type EdgeCoherenceFrame,
  type RelayedIbi,
  type RelayedBattery,
  type RelayedConfig,
  type RelayedRawPpg,
  type RelayedDiagnostic,
  type CentralRelayState,
  type LinkQuality,
  type LedHealth,
  type PpgProgram,
} from '../ble/edgeDevice';
import { edgeCoherenceBuffers } from './metricsBuffer';
import type {
  NarbisRuntimeConfig,
  NarbisRawSample,
  NarbisSqiPayload,
  DiagnosticSample,
} from '../ble/parsers';
import { resetDiagnosticClock, deserializeConfig, parseDiagnostic } from '../ble/parsers';
import { StreamBuffer } from './streamBuffer';
import {
  NARBIS_COH_PARAMS_DEFAULTS,
  type NarbisCoherenceParams,
} from '../../../protocol/narbis_protocol';

export type ConnectionState = NarbisStatus | PolarStatus | EdgeStatus;
export type DataSource = 'live' | 'replay';

/* BLE event log entry. Captures connect/disconnect, notifications, control
 * writes - everything user-visible across both devices. Stored as a fixed-
 * size ring (newest last) so the UI can show a tail without unbounded
 * memory growth. */
export type BleLogSource = 'earclip' | 'edge' | 'polar' | 'system';
export type BleLogLevel = 'info' | 'warn' | 'error' | 'rx' | 'tx';
export interface BleLogEntry {
  id: number;
  timestamp: number;
  source: BleLogSource;
  level: BleLogLevel;
  message: string;
}
const BLE_LOG_MAX = 500;

export interface PolarBeatRecord {
  bpm: number;
  rr: number[];
}

/* Earclip battery snapshot for the connection panel. `mv` is null on the
 * standard BAS path (0x180F only carries SoC%); the Narbis custom char and
 * the glasses 0xF8 relay both carry mv. */
export interface BatteryState {
  soc_pct: number;
  mv: number | null;
  charging: boolean;
}

export interface BufferSet {
  rawPpg: StreamBuffer<NarbisRawSample>;
  narbisBeats: StreamBuffer<NarbisBeatEvent>;
  polarBeats: StreamBuffer<PolarBeatRecord>;
  sqi: StreamBuffer<NarbisSqiPayload>;
  filtered: StreamBuffer<DiagnosticSample>;
}

export interface DashboardState {
  connection: {
    narbis: {
      state: NarbisStatus;
      deviceName: string | null;
      battery: BatteryState | null;
      /** Current sub-phase of connect/openSession/reconnect for fine-grained
       *  status display (e.g. "discovering services", "subscribing"). null
       *  outside of an active connect attempt. */
      phase: string | null;
      /** Attempt counter for the auto-reconnect loop. null when not retrying. */
      reconnectAttempt: number | null;
    };
    polar: { state: PolarStatus; deviceName: string | null };
    edge: {
      state: EdgeStatus;
      deviceName: string | null;
      lastFrameAt: number | null;
      /** Glasses-to-earclip relay link state. null = unknown/glasses
       * not on Path-B firmware; true = central reached READY (subs in
       * place); false = central not connected. */
      earclipRelay: boolean | null;
      /** Latest 0xFA link-quality snapshot from the glasses, or null if
       * none received yet (older glasses firmware doesn't emit it). */
      linkQuality: LinkQuality | null;
      /** Latest LED state from bytes [20–21] of the 0xF3 health frame, or null
       * if none received yet (firmware < v4.15 didn't emit 0xF3 at all). */
      ledHealth: LedHealth | null;
    };
  };
  recording: {
    active: boolean;
    startedAt: number | null;
  };
  config: NarbisRuntimeConfig | null;
  lastBeat: NarbisBeatEvent | null;
  lastSqi: NarbisSqiPayload | null;
  counters: {
    beats: number;
    rawSamples: number;
    sqi: number;
    polarBeats: number;
  };
  buffers: BufferSet;
  replayBuffers: BufferSet;
  dataSource: DataSource;
  lastError: string | null;
  /** Shared visible-time-window across all four streaming charts. Lifting
   * it to the store means changing the window on any chart updates them
   * all in lockstep. Smoothing and rescale stay per-chart since they're
   * styling preferences specific to each signal type. */
  windowSec: number;

  bleLog: BleLogEntry[];

  /** PC jitter smoothing: buffer 150 ms of incoming raw-PPG packets and
   * replay them at uniform 20 ms intervals. Mirrors the v13.27 dashboard
   * "PC Jitter Smoothing" toggle. Defaults ON; turn off on tablets where
   * the wire is already uniform. Adds 150 ms of latency to the chart. */
  pcJitterSmoothing: boolean;

  /** Which heart-rate source drives the glasses' coherence pipeline.
   * 'earclip' (default): the glasses' BLE central pulls IBI from the
   * paired Narbis earclip — the original path. 'h10': the dashboard
   * forwards each Polar H10 R-R interval to the glasses via the 0xCA
   * INJECT_IBI opcode, so the same 4 PPG programs run off H10 beats.
   * The dashboard's local coherence runner also follows this source. */
  hrSourceForGlasses: 'earclip' | 'h10';

  /** Live coherence-pipeline params (LF peak window, band ranges, score
   * multiplier, confidence gate). Mirrored to the glasses via the 0xE0
   * opcode and persisted in localStorage. The dashboard's local
   * firmwareCoherence port reads from the same struct, keeping the
   * parity-check trace aligned with what the glasses are computing. */
  coherenceParams: NarbisCoherenceParams;

  /** Which PPG training program the glasses are currently running (1–4),
   * or null if a standalone mode is active. Lifted to the store so the
   * auto-start-on-H10-connect path and the user-click path stay in
   * lockstep — clicking Prog N and the auto path both flow through the
   * same setter. */
  activeProgram: PpgProgram | null;

  /** Which standalone (no-HR) mode is running on the glasses, or null
   * if a PPG program is active instead. Mutually exclusive with
   * activeProgram — setting one clears the other. */
  standaloneMode: 'static' | 'strobe' | 'breathe' | 'pulse' | null;

  /** Most recent firmware coherence frame (0xF2). Used for the live
   * respiration-rate readout in the IBI tachogram header — and any other
   * place that wants the freshest firmware values without polling the
   * edgeCoherenceBuffers ring buffer. */
  lastEdgeCoherence: EdgeCoherenceFrame | null;

  /** Most recent H10 beat. Mirror of `lastBeat` (earclip) so the Basic-mode
   * HR readout can pull whichever source is active without iterating the
   * StreamBuffer on every render. */
  lastPolarBeat: PolarBeatRecord | null;
  /** Wall-clock ms of the most recent beat from EITHER source. Drives the
   * heartbeat-pulse animation in the Basic-mode glasses visual without
   * having to subscribe to both source-specific timestamps separately. */
  lastBeatAt: number | null;

  /** Dashboard UI complexity. 'basic' (default) shows a single-page
   * lay-user view with just the metrics, program selector, and a couple
   * of settings sliders. 'expert' is the full charts + sidebar layout
   * with the algorithm tuning configurator, BLE log, recording controls,
   * etc. Persisted to localStorage. */
  uiMode: 'basic' | 'expert' | 'mobile';

  connectNarbis: () => Promise<void>;
  disconnectNarbis: () => Promise<void>;
  /** Disconnect and release the Web Bluetooth permission grant for the
   *  earclip. Does what plain disconnect+localStorage-clear used to do,
   *  but also calls device.forget() so the browser flushes its cached
   *  device handle and GATT cache. Without this the next connect can
   *  hit a stale cache and need several Forget+Connect cycles to recover. */
  forgetNarbis: () => Promise<void>;
  connectPolar: () => Promise<void>;
  disconnectPolar: () => Promise<void>;
  connectEdge: () => Promise<void>;
  disconnectEdge: () => Promise<void>;
  /** Tell the connected glasses to forget their current earclip and rescan.
   *  Throws if the dashboard is not connected to the glasses. */
  edgeForgetEarclip: () => Promise<void>;
  clearBleLog: () => void;
  setPcJitterSmoothing: (enabled: boolean) => void;
  setHrSourceForGlasses: (source: 'earclip' | 'h10') => void;
  /** Updates the local params struct, persists it to localStorage, and
   * pushes it to the connected glasses via 0xE0. Returns the BLE write
   * promise so callers can await/handle failures. */
  setCoherenceParams: (params: NarbisCoherenceParams) => Promise<void>;
  /** Set the active PPG training program (1–4) or clear it (null). When
   * non-null and Edge is connected, also fires 0xB7 PROGRAM_SELECT to
   * the glasses. Clears standaloneMode (mutually exclusive). */
  setActiveProgram: (p: PpgProgram | null) => Promise<void>;
  /** Activate a standalone mode and fire its BLE command. Pass null to
   * clear (leaves the glasses in whatever mode they were last in). For
   * 'static', `dutyPct` overrides the brightness; otherwise it's
   * ignored. Clears activeProgram. */
  setStandaloneMode: (
    mode: 'static' | 'strobe' | 'breathe' | 'pulse' | null,
    dutyPct?: number,
  ) => Promise<void>;
  setUiMode: (mode: 'basic' | 'expert' | 'mobile') => void;
  setConfig: (config: NarbisRuntimeConfig) => void;
  setDataSource: (source: DataSource) => void;
  setWindowSec: (seconds: number) => void;
}

function makeBuffers(): BufferSet {
  return {
    rawPpg: new StreamBuffer<NarbisRawSample>(12000),
    narbisBeats: new StreamBuffer<NarbisBeatEvent>(1200),
    polarBeats: new StreamBuffer<PolarBeatRecord>(1200),
    sqi: new StreamBuffer<NarbisSqiPayload>(600),
    filtered: new StreamBuffer<DiagnosticSample>(6000),
  };
}

const liveBuffers = makeBuffers();
const replayBuffers = makeBuffers();

const HR_SOURCE_FOR_GLASSES_KEY = 'hrSourceForGlasses';
function loadHrSourceForGlasses(): 'earclip' | 'h10' {
  try {
    const v = localStorage.getItem(HR_SOURCE_FOR_GLASSES_KEY);
    return v === 'h10' ? 'h10' : 'earclip';
  } catch {
    return 'earclip';
  }
}
function saveHrSourceForGlasses(source: 'earclip' | 'h10'): void {
  try { localStorage.setItem(HR_SOURCE_FOR_GLASSES_KEY, source); } catch { /* quota / private mode */ }
}

const COH_PARAMS_KEY = 'coherenceParams';
function loadCoherenceParams(): NarbisCoherenceParams {
  try {
    const raw = localStorage.getItem(COH_PARAMS_KEY);
    if (!raw) return { ...NARBIS_COH_PARAMS_DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<NarbisCoherenceParams>;
    // Merge over defaults so missing fields (e.g. older saved blob) fall
    // back to compile-time defaults instead of NaN.
    return { ...NARBIS_COH_PARAMS_DEFAULTS, ...parsed };
  } catch {
    return { ...NARBIS_COH_PARAMS_DEFAULTS };
  }
}
function saveCoherenceParams(params: NarbisCoherenceParams): void {
  try { localStorage.setItem(COH_PARAMS_KEY, JSON.stringify(params)); } catch { /* quota / private mode */ }
}

const UI_MODE_KEY = 'uiMode';
function loadUiMode(): 'basic' | 'expert' | 'mobile' {
  try {
    const v = localStorage.getItem(UI_MODE_KEY);
    if (v === 'expert') return 'expert';
    if (v === 'mobile') return 'mobile';
    return 'basic';
  } catch {
    return 'basic';
  }
}
function saveUiMode(mode: 'basic' | 'expert' | 'mobile'): void {
  try { localStorage.setItem(UI_MODE_KEY, mode); } catch { /* quota / private mode */ }
}

export const useDashboardStore = create<DashboardState>((set) => ({
  connection: {
    narbis: { state: 'disconnected', deviceName: null, battery: null, phase: null, reconnectAttempt: null },
    polar:  { state: 'disconnected', deviceName: null },
    edge:   { state: 'disconnected', deviceName: null, lastFrameAt: null, earclipRelay: null, linkQuality: null, ledHealth: null },
  },
  recording: {
    active: false,
    startedAt: null,
  },
  config: null,
  lastBeat: null,
  lastSqi: null,
  counters: { beats: 0, rawSamples: 0, sqi: 0, polarBeats: 0 },
  buffers: liveBuffers,
  replayBuffers,
  dataSource: 'live',
  lastError: null,
  windowSec: 30,
  bleLog: [],
  pcJitterSmoothing: true,
  hrSourceForGlasses: loadHrSourceForGlasses(),
  coherenceParams: loadCoherenceParams(),
  activeProgram: null,
  standaloneMode: null,
  lastEdgeCoherence: null,
  lastPolarBeat: null,
  lastBeatAt: null,
  uiMode: loadUiMode(),

  connectNarbis: async () => {
    set({ lastError: null });
    try {
      await narbisDevice.connect();
    } catch (err) {
      set({ lastError: errorMessage(err) });
      throw err;
    }
  },
  disconnectNarbis: async () => {
    await narbisDevice.disconnect();
  },
  forgetNarbis: async () => {
    await narbisDevice.forget();
  },
  connectPolar: async () => {
    set({ lastError: null });
    appendBleLog('polar', 'info', 'connect requested (opening device chooser)');
    try {
      await polarH10.connect();
    } catch (err) {
      const msg = errorMessage(err);
      set({ lastError: msg });
      /* Common cases:
       *  - "User cancelled the requestDevice() chooser." — user closed the dialog.
       *  - "Connection attempt failed." — gatt.connect() failed (strap out of
       *    range, paired to another device, or Windows BLE stack stalled).
       *  - "Bluetooth adapter not available." — OS Bluetooth off / no hardware. */
      appendBleLog('polar', 'error', `connect failed: ${msg}`);
      throw err;
    }
  },
  disconnectPolar: async () => {
    await polarH10.disconnect();
  },
  connectEdge: async () => {
    set({ lastError: null });
    try {
      await edgeDevice.connect();
    } catch (err) {
      set({ lastError: errorMessage(err) });
      throw err;
    }
  },
  disconnectEdge: async () => {
    await edgeDevice.disconnect();
  },
  edgeForgetEarclip: async () => {
    if (!edgeDevice.isConnected) {
      throw new Error('connect to glasses first');
    }
    await edgeDevice.forgetEarclipPairing();
  },
  clearBleLog: () => set({ bleLog: [] }),
  setPcJitterSmoothing: (enabled) => {
    set({ pcJitterSmoothing: enabled });
    // If disabling, drain whatever is buffered immediately so we don't
    // drop samples (also stops the drain timer). If enabling, the next
    // arriving packet kicks off the drain loop.
    if (!enabled) flushJitterQueue();
  },
  setHrSourceForGlasses: (source) => {
    set({ hrSourceForGlasses: source });
    saveHrSourceForGlasses(source);
    /* Tell the glasses to pause its earclip central scan when source=h10
     * (no point hunting for an earclip that's not the active feed), or
     * resume when source=earclip. Fire-and-forget; the BLE write may
     * fail if glasses aren't connected — that's fine, it'll be re-sent
     * on the next connect via the existing auto-push path. */
    if (edgeDevice.isConnected) {
      void edgeDevice.setHrSource(source).catch((err) => {
        appendBleLog('edge', 'error', `setHrSource(${source}) failed: ${(err as Error).message}`);
      });
    }
  },
  setCoherenceParams: async (params) => {
    set({ coherenceParams: params });
    saveCoherenceParams(params);
    if (edgeDevice.isConnected) {
      try {
        await edgeDevice.writeCoherenceParams(params);
      } catch (err) {
        appendBleLog('edge', 'error', `coh params write failed: ${(err as Error).message}`);
        throw err;
      }
    }
  },
  setActiveProgram: async (p) => {
    if (p !== null) {
      set({ activeProgram: p, standaloneMode: null });
    } else {
      set({ activeProgram: null });
    }
    if (p !== null && edgeDevice.isConnected) {
      try {
        await edgeDevice.setProgram(p);
      } catch (err) {
        appendBleLog('edge', 'error', `setProgram(${p}) failed: ${(err as Error).message}`);
        throw err;
      }
    }
  },
  setStandaloneMode: async (mode, dutyPct) => {
    if (mode !== null) {
      set({ standaloneMode: mode, activeProgram: null });
    } else {
      set({ standaloneMode: null });
    }
    if (mode === null || !edgeDevice.isConnected) return;
    try {
      switch (mode) {
        case 'static':
          await edgeDevice.setStandaloneStatic(dutyPct ?? 50);
          break;
        case 'strobe':
          await edgeDevice.setStandaloneStrobe();
          break;
        case 'breathe':
          await edgeDevice.setStandaloneBreathe();
          break;
        case 'pulse':
          await edgeDevice.setStandalonePulseOnBeat();
          break;
      }
    } catch (err) {
      appendBleLog('edge', 'error', `setStandalone(${mode}) failed: ${(err as Error).message}`);
      throw err;
    }
  },
  setUiMode: (mode) => {
    set({ uiMode: mode });
    saveUiMode(mode);
  },
  setConfig: (config) => set({ config }),
  setDataSource: (source) => set({ dataSource: source }),
  setWindowSec: (seconds) => set({ windowSec: seconds }),
}));

let bleLogIdCounter = 0;
function appendBleLog(source: BleLogSource, level: BleLogLevel, message: string): void {
  bleLogIdCounter += 1;
  const entry: BleLogEntry = {
    id: bleLogIdCounter,
    timestamp: Date.now(),
    source,
    level,
    message,
  };
  setState((s) => {
    const next = s.bleLog.length >= BLE_LOG_MAX
      ? [...s.bleLog.slice(s.bleLog.length - BLE_LOG_MAX + 1), entry]
      : [...s.bleLog, entry];
    return { bleLog: next };
  });
}

export function getActiveBuffers(): BufferSet {
  const s = useDashboardStore.getState();
  return s.dataSource === 'replay' ? s.replayBuffers : s.buffers;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const setState = useDashboardStore.setState;

// Monotonic raw-PPG timestamping. The firmware doesn't send per-sample
// timestamps in the raw payload, only sample_rate_hz + N samples; we
// previously back-computed each batch's timestamps from BLE arrival
// time, but BLE jitter makes adjacent batches overlap or step backwards.
// Instead place samples consecutively after the previous batch's last
// sample; resync to wall-clock if we ever fall > 2 batches behind.
let lastRawTs = 0;

narbisDevice.addEventListener('connected', (e) => {
  const { name } = (e as CustomEvent<{ name: string }>).detail;
  setState((s) => ({
    connection: {
      ...s.connection,
      narbis: {
        ...s.connection.narbis,
        state: 'connected',
        deviceName: name,
        phase: null,
        reconnectAttempt: null,
      },
    },
  }));
  appendBleLog('earclip', 'info', `connected to ${name}`);
  /* If edge is already connected and the user hasn't picked a program,
   * schedule an auto-start now that we have a direct earclip beat source.
   * Covers the connect-order: earclip arrives after the glasses were already
   * connected (the edge-connect auto-start ran earlier and skipped because
   * there was no sensor at that point). */
  scheduleAutoStartProgram('earclip direct connected');
});

narbisDevice.addEventListener('disconnected', (e) => {
  const { reason, error } = (e as CustomEvent<NarbisDisconnectedDetail>).detail;
  // Reset our timestamp anchors so the next session re-anchors from
  // its own first sample. Without this, a reconnect carries the old
  // anchor forward and either back-fills the chart (if firmware time
  // jumped backwards on reboot) or shows nothing for several minutes
  // (if firmware time jumped forwards).
  if (narbisDevice.status !== 'reconnecting') {
    resetDiagnosticClock();
    lastRawTs = 0;
    flushJitterQueue();
  }
  setState((s) => ({
    connection: {
      ...s.connection,
      narbis: {
        ...s.connection.narbis,
        state: narbisDevice.status,
        deviceName: narbisDevice.status === 'reconnecting' ? s.connection.narbis.deviceName : null,
        battery: narbisDevice.status === 'reconnecting' ? s.connection.narbis.battery : null,
        phase: narbisDevice.status === 'reconnecting' ? s.connection.narbis.phase : null,
        reconnectAttempt:
          narbisDevice.status === 'reconnecting' ? s.connection.narbis.reconnectAttempt : null,
      },
    },
    lastError: reason === 'error' && error ? error.message : s.lastError,
  }));
  appendBleLog(
    'earclip',
    reason === 'error' ? 'error' : 'info',
    narbisDevice.status === 'reconnecting'
      ? `disconnected (${reason}) - reconnecting`
      : `disconnected (${reason})`,
  );
});

narbisDevice.addEventListener('phase', (e) => {
  const { phase, attempt } = (e as CustomEvent<NarbisPhaseDetail>).detail;
  setState((s) => ({
    connection: {
      ...s.connection,
      narbis: {
        ...s.connection.narbis,
        phase,
        reconnectAttempt: attempt ?? s.connection.narbis.reconnectAttempt,
      },
    },
  }));
});

narbisDevice.addEventListener('error', (e) => {
  const { error, phase } = (e as CustomEvent<NarbisErrorDetail>).detail;
  setState({ lastError: `${phase}: ${error.message}` });
  appendBleLog('earclip', 'error', `${phase}: ${error.message}`);
});

// Coalesce zustand updates from BLE event handlers into one setState per
// RAF. Without this, every BLE notification (1–10 Hz across 4 streams)
// triggers a store update, which re-renders every component that calls
// useDashboardStore — including all four streaming charts. We accumulate
// here and flush once per frame.
const pending = {
  beats: 0,
  rawSamples: 0,
  sqi: 0,
  polarBeats: 0,
  lastBeat: null as NarbisBeatEvent | null,
  lastSqi: null as NarbisSqiPayload | null,
};
let flushRaf = 0;

function scheduleCounterFlush(): void {
  if (flushRaf) return;
  flushRaf = requestAnimationFrame(() => {
    flushRaf = 0;
    const cur = useDashboardStore.getState();
    const patch: Partial<DashboardState> = {
      counters: {
        beats: cur.counters.beats + pending.beats,
        rawSamples: cur.counters.rawSamples + pending.rawSamples,
        sqi: cur.counters.sqi + pending.sqi,
        polarBeats: cur.counters.polarBeats + pending.polarBeats,
      },
    };
    if (pending.lastBeat) patch.lastBeat = pending.lastBeat;
    if (pending.lastSqi) patch.lastSqi = pending.lastSqi;
    setState(patch);
    pending.beats = 0;
    pending.rawSamples = 0;
    pending.sqi = 0;
    pending.polarBeats = 0;
    pending.lastBeat = null;
    pending.lastSqi = null;
  });
}

narbisDevice.addEventListener('beatReceived', (e) => {
  const beat = (e as CustomEvent<NarbisBeatEvent>).detail;
  liveBuffers.narbisBeats.push(beat.timestamp, beat);
  pending.beats += 1;
  pending.lastBeat = beat;
  scheduleCounterFlush();
  setState({ lastBeatAt: beat.timestamp });
});

narbisDevice.addEventListener('sqiReceived', (e) => {
  const sqi = (e as CustomEvent<NarbisSqiEvent>).detail;
  liveBuffers.sqi.push(sqi.timestamp, sqi);
  pending.sqi += 1;
  pending.lastSqi = sqi;
  scheduleCounterFlush();
});

// PC jitter smoothing — Windows BLE delivers notifications in bursts
// ("4 packets, then silence for 80 ms, then 3 more"). Buffer arriving
// raw-PPG batches and drain them at a uniform 20 ms cadence so the
// downstream pipeline (and chart) sees evenly-spaced data. Buffer depth
// 150 ms = 7-8 packets at 50 Hz, plenty to absorb one burst-silence cycle
// without underruning. v13.27 dashboard parity.
const SMOOTH_BUFFER_MS = 150;
const SMOOTH_TICK_MS   = 20;
const SMOOTH_TARGET_PKTS = Math.ceil(SMOOTH_BUFFER_MS / SMOOTH_TICK_MS);
let jitterQueue: NarbisRawSampleEvent[] = [];
let jitterTimer: number | null = null;
let jitterFilled = false;

function processRawBatch(raw: NarbisRawSampleEvent): void {
  const arrivalMs = raw.timestamp;
  const periodMs = raw.sample_rate_hz > 0 ? 1000 / raw.sample_rate_hz : 0;
  const n = raw.samples.length;
  if (periodMs === 0 || n === 0) return;

  const arrivalFirst = arrivalMs - (n - 1) * periodMs;
  const continueFirst = lastRawTs > 0 ? lastRawTs + periodMs : arrivalFirst;
  let firstTs = Math.max(continueFirst, arrivalFirst);
  if (continueFirst < arrivalFirst - 2 * n * periodMs) firstTs = arrivalFirst;

  for (let i = 0; i < n; i++) {
    liveBuffers.rawPpg.push(firstTs + i * periodMs, raw.samples[i]);
  }
  lastRawTs = firstTs + (n - 1) * periodMs;

  pending.rawSamples += n;
  scheduleCounterFlush();
}

function drainJitterQueue(): void {
  if (jitterQueue.length === 0) return;
  // Initial fill — wait until we have buffer depth before starting
  if (!jitterFilled) {
    if (jitterQueue.length < SMOOTH_TARGET_PKTS) return;
    jitterFilled = true;
  }
  // Catch-up pacing: if we fell behind (browser hiccup), process up to
  // 3 packets per tick. Cap is intentional — doing all the work in one
  // render frame causes its own jitter.
  const backlog = jitterQueue.length - SMOOTH_TARGET_PKTS;
  const toProcess = Math.min(3, Math.max(1, backlog + 1));
  for (let i = 0; i < toProcess && jitterQueue.length > 0; i++) {
    const next = jitterQueue.shift();
    if (next) processRawBatch(next);
  }
}

function flushJitterQueue(): void {
  while (jitterQueue.length > 0) {
    const next = jitterQueue.shift();
    if (next) processRawBatch(next);
  }
  if (jitterTimer !== null) {
    window.clearInterval(jitterTimer);
    jitterTimer = null;
  }
  jitterFilled = false;
}

/* Shared raw-batch entry point for both the direct (narbisDevice) and
 * relay (edgeDevice 0xF5) paths. Routes through the PC-jitter buffer
 * when smoothing is enabled, otherwise straight to processRawBatch.
 * Without this helper, the relay path silently bypassed the smoother
 * and got bursty playback on Windows BLE. */
function feedRawBatch(raw: NarbisRawSampleEvent): void {
  const smoothing = useDashboardStore.getState().pcJitterSmoothing;
  if (!smoothing) {
    processRawBatch(raw);
    return;
  }
  jitterQueue.push(raw);
  if (jitterTimer === null) {
    jitterTimer = window.setInterval(drainJitterQueue, SMOOTH_TICK_MS);
  }
}

narbisDevice.addEventListener('rawSampleReceived', (e) => {
  feedRawBatch((e as CustomEvent<NarbisRawSampleEvent>).detail);
});

narbisDevice.addEventListener('batteryReceived', (e) => {
  const batt = (e as CustomEvent<NarbisBatteryEvent>).detail;
  setState((s) => {
    /* Both the standard BAS char (0x180F, soc_pct only) and the Narbis
     * custom char (mv + soc + charging) notify into this same handler.
     * Preserve mv/charging from the last Narbis update if the new event
     * came from BAS — otherwise BAS would clobber the voltage display. */
    const prev = s.connection.narbis.battery;
    return {
      connection: {
        ...s.connection,
        narbis: {
          ...s.connection.narbis,
          battery: {
            soc_pct: batt.soc_pct,
            mv: batt.mv != null ? batt.mv : (prev?.mv ?? null),
            charging:
              batt.charging != null ? !!batt.charging : (prev?.charging ?? false),
          },
        },
      },
    };
  });
});

narbisDevice.addEventListener('configChanged', (e) => {
  const cfg = (e as CustomEvent<NarbisRuntimeConfig>).detail;
  setState({ config: cfg });
  appendBleLog('earclip', 'rx', `config v${cfg.config_version} (sample_rate=${cfg.sample_rate_hz} Hz)`);
});

narbisDevice.addEventListener('diagnosticReceived', (e) => {
  const diag = (e as CustomEvent<NarbisDiagnosticEvent>).detail;
  for (const s of diag.samples) {
    liveBuffers.filtered.push(s.timestamp, s);
  }
});

/* When H10 connects and there is no earclip in the picture, auto-route
 * the HR source so the glasses' coherence pipeline gets fed without the
 * user having to flip a toggle. Pure source-select — program auto-start
 * is handled separately by the edge-connect delayed timer below.
 * No-op if the earclip is already connected (user clearly intends the
 * earclip path then) or if Edge isn't connected yet. */
function autoSelectHrSourceIfApplicable(reason: string): void {
  const s = useDashboardStore.getState();
  if (s.connection.polar.state !== 'connected') return;
  if (s.connection.narbis.state === 'connected') return;
  if (s.connection.edge.state !== 'connected') return;

  if (s.hrSourceForGlasses !== 'h10') {
    s.setHrSourceForGlasses('h10');
    appendBleLog('system', 'info', `auto-select HR source = h10 (${reason})`);
  }
}

/* Auto-start Program 2 (Coh Breathe) shortly after the Edge glasses
 * connect AND a beat source is available. The delay (~1.5 s) lets the
 * post-connect BLE pipeline settle — coh-params auto-push, raw-relay
 * enable, hr-source assertion all fire synchronously on connect; spacing
 * the program write avoids stacking five GATT writes back-to-back which
 * has caused write-already-in-flight errors on Windows BLE.
 *
 * The timer fires from three places so all connect-order permutations
 * work: edge-first+earclip-later, earclip-first+edge-later, and both
 * already ready. Each call site re-arms the timer (debounced), so rapid
 * successive events don't stack multiple writes.
 *
 * Skipped if: the user has already picked a program or standalone, OR
 * no beat source is connected yet (earclip direct, glasses relay, or H10).
 * "No sensor" skipping is critical — Program 2 requires IBI to do
 * anything useful; entering it without a sensor confuses users who see the
 * lens breathing but can't understand why the heartbeat program is broken. */
const AUTO_START_DELAY_MS = 1500;
const AUTO_START_PROGRAM: PpgProgram = 2;
let autoStartTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleAutoStartProgram(reason: string): void {
  if (autoStartTimer) clearTimeout(autoStartTimer);
  autoStartTimer = setTimeout(() => {
    autoStartTimer = null;
    if (!edgeDevice.isConnected) return;
    const s = useDashboardStore.getState();
    /* Honor user intent: if they've clicked a program or standalone
     * during the delay window, leave them alone. */
    if (s.activeProgram !== null || s.standaloneMode !== null) {
      appendBleLog('system', 'info', `auto-start skipped — user already selected ${
        s.activeProgram !== null ? `Program ${s.activeProgram}` : `Standalone ${s.standaloneMode}`
      }`);
      return;
    }
    /* Require a live beat source before auto-starting any sensor program.
     * Without IBI the glasses just breathe the lens on the pacer timer with
     * no HRV feedback — Program 2 looks "active" but is essentially a
     * standalone breathe. Users trying Heartbeat (Program 1) would also see
     * no pulses. Wait until a sensor is in place. */
    const hasEarclipDirect = s.connection.narbis.state === 'connected';
    const hasEarclipRelay  = s.connection.edge.earclipRelay === true;
    const hasH10           = s.connection.polar.state === 'connected';
    if (!hasEarclipDirect && !hasEarclipRelay && !hasH10) {
      appendBleLog('system', 'info', 'auto-start skipped — no beat source (earclip or H10) connected yet');
      return;
    }
    void s.setActiveProgram(AUTO_START_PROGRAM)
      .then(() => {
        appendBleLog('system', 'info', `auto-start Program ${AUTO_START_PROGRAM} (Coh Breathe) — ${reason}`);
      })
      .catch(() => { /* setActiveProgram already logs */ });
  }, AUTO_START_DELAY_MS);
}

polarH10.addEventListener('connected', (e) => {
  const { name } = (e as CustomEvent<{ name: string }>).detail;
  setState((s) => ({
    connection: {
      ...s.connection,
      polar: { state: 'connected', deviceName: name },
    },
  }));
  appendBleLog('polar', 'info', `connected to ${name}`);
  autoSelectHrSourceIfApplicable('h10 connected');
});

polarH10.addEventListener('disconnected', (e) => {
  const { reason, error } = (e as CustomEvent<PolarDisconnectedDetail>).detail;
  setState((s) => ({
    connection: {
      ...s.connection,
      polar: {
        state: polarH10.status,
        deviceName: polarH10.status === 'reconnecting' ? s.connection.polar.deviceName : null,
      },
    },
    /* Drop the cached beat on real disconnect; keep it across reconnects
     * so the Basic-mode HR card doesn't blink. */
    lastPolarBeat: polarH10.status === 'reconnecting' ? s.lastPolarBeat : null,
    lastError: reason === 'error' && error ? error.message : s.lastError,
  }));
  /* On real (not reconnecting) polar disconnect while source=h10, flip
   * the dashboard back to earclip so the glasses resume scanning. The
   * setter fires 0xCB to the glasses. Skipped during reconnecting state
   * so a brief drop doesn't churn the glasses' central. */
  if (polarH10.status === 'disconnected') {
    const st = useDashboardStore.getState();
    if (st.hrSourceForGlasses === 'h10') {
      st.setHrSourceForGlasses('earclip');
      appendBleLog('system', 'info', 'h10 disconnected → reverting HR source to earclip');
    }
  }
  appendBleLog(
    'polar',
    reason === 'error' ? 'error' : 'info',
    polarH10.status === 'reconnecting'
      ? `disconnected (${reason}) - reconnecting`
      : `disconnected (${reason})${error ? `: ${error.message}` : ''}`,
  );
});

polarH10.addEventListener('error', (e) => {
  const { error, phase } = (e as CustomEvent<PolarErrorDetail>).detail;
  setState({ lastError: `polar/${phase}: ${error.message}` });
  appendBleLog('polar', 'error', `${phase}: ${error.message}`);
});

/* H10 → glasses IBI forwarding (0xCA INJECT_IBI). Sanity-bound to the
 * physiological range; same window the firmware's beat validator uses
 * implicitly (240..30 BPM). RRs outside this band almost always mean a
 * detection glitch on the strap and would corrupt the coherence FFT.
 * The firmware also drops conf<50 / ARTIFACT, so we keep the conservative
 * defaults (conf=100, flags=0) — H10's strap-side detector is solid. */
const H10_RR_MIN_MS = 250;
const H10_RR_MAX_MS = 2000;
function forwardH10BeatsToGlasses(rrs: number[]): void {
  if (rrs.length === 0) return;
  if (!edgeDevice.isConnected) return;
  for (const rr of rrs) {
    if (!Number.isFinite(rr) || rr < H10_RR_MIN_MS || rr > H10_RR_MAX_MS) continue;
    void edgeDevice.injectIbi(rr).catch((err) => {
      appendBleLog('edge', 'error', `injectIbi failed: ${(err as Error).message}`);
    });
  }
}

polarH10.addEventListener('beatReceived', (e) => {
  const beat = (e as CustomEvent<PolarBeatEvent>).detail;
  const record: PolarBeatRecord = { bpm: beat.bpm, rr: beat.rrIntervals_ms };
  liveBuffers.polarBeats.push(beat.timestamp, record);
  pending.polarBeats += 1;
  scheduleCounterFlush();
  /* Stash the freshest beat for Basic-mode HR readout. setState is
   * coarse-grained (one per beat, ~1 Hz) so we don't need RAF batching. */
  setState({ lastPolarBeat: record, lastBeatAt: beat.timestamp });
  if (useDashboardStore.getState().hrSourceForGlasses === 'h10') {
    forwardH10BeatsToGlasses(beat.rrIntervals_ms);
  }
});

// ---------- Edge glasses ----------

edgeDevice.addEventListener('connected', (e) => {
  const { name } = (e as CustomEvent<{ name: string }>).detail;
  setState((s) => ({
    connection: {
      ...s.connection,
      edge: {
        state: 'connected',
        deviceName: name,
        lastFrameAt: s.connection.edge.lastFrameAt,
        earclipRelay: null,  /* unknown until first 0xF6 frame */
        linkQuality: null,   /* unknown until first 0xFA frame */
        ledHealth: null,     /* unknown until first 0xF3 frame */
      },
    },
  }));
  appendBleLog('edge', 'info', `connected to ${name}`);
  /* Default raw-PPG relay to ON on every glasses connect. The glasses
   * firmware's S.raw_enabled defaults to false on boot, so we have to
   * tell it on each session. The toggle in EdgeControls still lets the
   * user turn it off. */
  void edgeDevice.setRawRelayEnabled(true).catch((err) => {
    appendBleLog('edge', 'error', `auto-enable raw relay failed: ${(err as Error).message}`);
  });
  /* Push the dashboard's stored coherence params to the glasses so the
   * firmware's NVS-loaded values are overridden by the user's most
   * recent tuning intent. Skipped silently if params equal compile-time
   * defaults (no point burning a BLE round-trip just to confirm). */
  const stored = useDashboardStore.getState().coherenceParams;
  const isDefault = (Object.keys(NARBIS_COH_PARAMS_DEFAULTS) as (keyof NarbisCoherenceParams)[])
    .every((k) => stored[k] === NARBIS_COH_PARAMS_DEFAULTS[k]);
  if (!isDefault) {
    void edgeDevice.writeCoherenceParams(stored).catch((err) => {
      appendBleLog('edge', 'error', `auto-push coh params failed: ${(err as Error).message}`);
    });
  }
  /* Re-assert the current HR source on every connect so the glasses'
   * central halts (h10) or runs (earclip) per dashboard state. The
   * firmware doesn't persist this — it defaults to 'earclip' on boot. */
  const currentSource = useDashboardStore.getState().hrSourceForGlasses;
  void edgeDevice.setHrSource(currentSource).catch((err) => {
    appendBleLog('edge', 'error', `auto-push hr_source failed: ${(err as Error).message}`);
  });
  /* If H10 was already connected when Edge came up, fire the source
   * trigger we'd run from the polar 'connected' listener — covers the
   * connect-order H10-first-then-glasses. */
  autoSelectHrSourceIfApplicable('edge connected with h10 ready');
  /* Schedule the default-program auto-start. Fires after a short delay
   * so the user has time to pick something else, and so the post-connect
   * burst of GATT writes (coh params, raw relay, hr source) doesn't
   * collide with the program-select write. */
  scheduleAutoStartProgram('edge connected');
});

edgeDevice.addEventListener('disconnected', (e) => {
  const { reason, error } = (e as CustomEvent<EdgeDisconnectedDetail>).detail;
  /* Cancel a pending auto-start if the edge dropped during the delay
   * window — firing a setProgram BLE write into a disconnected glasses
   * would just log a failure. */
  if (autoStartTimer) {
    clearTimeout(autoStartTimer);
    autoStartTimer = null;
  }
  setState((s) => ({
    connection: {
      ...s.connection,
      edge: {
        state: edgeDevice.status,
        deviceName: edgeDevice.status === 'reconnecting' ? s.connection.edge.deviceName : null,
        lastFrameAt: edgeDevice.status === 'reconnecting' ? s.connection.edge.lastFrameAt : null,
        earclipRelay: edgeDevice.status === 'reconnecting' ? s.connection.edge.earclipRelay : null,
        linkQuality:  edgeDevice.status === 'reconnecting' ? s.connection.edge.linkQuality  : null,
        ledHealth:    edgeDevice.status === 'reconnecting' ? s.connection.edge.ledHealth    : null,
      },
    },
    /* Drop the cached firmware-coherence frame on a real disconnect
     * (keep it across transient reconnects so the readout doesn't blink). */
    lastEdgeCoherence: edgeDevice.status === 'reconnecting' ? s.lastEdgeCoherence : null,
    lastError: reason === 'error' && error ? error.message : s.lastError,
  }));
  appendBleLog(
    'edge',
    reason === 'error' ? 'error' : 'info',
    edgeDevice.status === 'reconnecting'
      ? `disconnected (${reason}) - reconnecting`
      : `disconnected (${reason})`,
  );
});

edgeDevice.addEventListener('error', (e) => {
  const { error, phase } = (e as CustomEvent<EdgeErrorDetail>).detail;
  setState({ lastError: `edge/${phase}: ${error.message}` });
  appendBleLog('edge', 'error', `${phase}: ${error.message}`);
});

edgeDevice.addEventListener('statusFrame', (e) => {
  const frame = (e as CustomEvent<EdgeStatusFrame>).detail;
  setState((s) => ({
    connection: {
      ...s.connection,
      edge: { ...s.connection.edge, lastFrameAt: frame.timestamp },
    },
  }));
  // 0xF7 (relay diag) fires 30-100x per second when POST_FILTER is on
  // and floods the BLE event log. Drop it from the log entirely — the
  // data still reaches the Filtered chart via the relayedDiagnostic
  // listener below. Same for 0xF5 (relay raw_ppg) — it's also high-rate
  // and the chart is the right place to see that data, not the log.
  if (frame.type === 0xF7 || frame.type === 0xF5) return;
  // Show the decoded summary directly. For 0xF1 firmware-log frames this
  // is the actual log line; for 0xF0/0xF2 it's a parsed summary; for
  // unknown frame types the summary still includes a hex dump.
  appendBleLog('edge', 'rx', frame.summary);
});

edgeDevice.addEventListener('ctrlSent', (e) => {
  const { opcode, length } = (e as CustomEvent<{ opcode: number; length: number }>).detail;
  appendBleLog(
    'edge',
    'tx',
    `ctrl opcode=0x${opcode.toString(16).padStart(2, '0').toUpperCase()} (${length} B)`,
  );
});

/* 0xF2 firmware HRV/coherence — feed the dedicated ring so charts can
 * overlay the on-glasses coherence trace against the dashboard's local
 * firmwareCoherence port. This is the validation loop for the algorithm
 * port and also the live signal when only the glasses are connected
 * (no dashboard-side beat source). */
edgeDevice.addEventListener('edgeCoherence', (e) => {
  const f = (e as CustomEvent<EdgeCoherenceFrame>).detail;
  edgeCoherenceBuffers.live.push(f.timestamp, {
    coh: f.coh,
    respMhz: f.respMhz,
    lf: f.lf,
    hf: f.hf,
    lfNorm: f.lfNorm,
    hfNorm: f.hfNorm,
    lfHf: f.lfHf,
    nIbis: f.nIbis,
    pacerBpm: f.pacerBpm,
  });
  setState({ lastEdgeCoherence: f });
});

/* Relayed earclip data through the glasses. The glasses' main.c forwards
 * IBI / battery via ble_log() text frames; edgeDevice parses them and
 * fires these events. We feed them into the same buffers the direct-
 * earclip-connection path uses, so the BPM / IBI / battery UI works
 * regardless of which BLE path delivered the data.
 *
 * Suppressed when the dashboard is also directly connected to the
 * earclip — that path already feeds the same buffers and doubling up
 * would corrupt the IBI tachogram. */
function isEarclipDirect(): boolean {
  return useDashboardStore.getState().connection.narbis.state === 'connected';
}

/* IIR rolling average for the relayed-IBI outlier gate. Mirrors the firmware's
 * on_earclip_ibi gate so the dashboard coherence ring sees the same filtered
 * stream as the firmware's coh_ibi_ring. Reset on earclip relay disconnect. */
let relayIbiRollingAvgMs = 0;
const RELAY_IBI_OUTLIER_PCT = 75;  // reject if IBI > avg × 1.75

edgeDevice.addEventListener('relayedIbi', (e) => {
  if (isEarclipDirect()) return;  // direct path already covers this
  const r = (e as CustomEvent<RelayedIbi>).detail;
  if (r.ibi_ms <= 0) return;

  /* Outlier gate — same logic as firmware on_earclip_ibi. */
  if (relayIbiRollingAvgMs === 0) {
    relayIbiRollingAvgMs = r.ibi_ms;
  } else if (r.ibi_ms > relayIbiRollingAvgMs * (100 + RELAY_IBI_OUTLIER_PCT) / 100) {
    return;  /* likely missed beat — skip dashboard coherence ring */
  } else {
    relayIbiRollingAvgMs = (relayIbiRollingAvgMs * 7 + r.ibi_ms) / 8;
  }

  const beat: NarbisBeatEvent = {
    bpm: Math.round(60000 / r.ibi_ms),
    ibi_ms: r.ibi_ms,
    confidence: r.confidence_x100,
    flags: r.flags,
    sqi: null,
    timestamp: r.timestamp,
  };
  liveBuffers.narbisBeats.push(beat.timestamp, beat);
  pending.beats += 1;
  setState({ lastBeatAt: beat.timestamp });
  pending.lastBeat = beat;
  scheduleCounterFlush();
});

/* Path B: glasses-to-earclip relay link state. Fires on connect/disconnect
 * of the central inside the glasses, AND on every periodic 0xF6 heartbeat
 * (~30 s). Edge-trigger off the previous state so we only react to actual
 * transitions; treating every event as fresh fired the auto-config-refresh
 * every heartbeat → multiple 0xC5 in flight via Web Bluetooth → "GATT
 * operation already in progress" → controller jam → both BLE links
 * (dashboard↔glasses and glasses↔earclip) cratered together. */
let configRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let configRefreshInFlight = false;
let prevRelayConnected: boolean | null = null;
edgeDevice.addEventListener('centralRelayState', (e) => {
  const r = (e as CustomEvent<CentralRelayState>).detail;
  setState((s) => ({
    connection: {
      ...s.connection,
      edge: { ...s.connection.edge, earclipRelay: r.connected },
    },
  }));
  appendBleLog('edge', 'info', `glasses→earclip relay ${r.connected ? 'LINKED' : 'lost'}`);

  /* Only react to actual transitions — ignore heartbeat re-emissions
   * where the connected flag hasn't changed since the last frame. */
  const transitionedUp   = r.connected && prevRelayConnected !== true;
  const transitionedDown = !r.connected && prevRelayConnected === true;
  prevRelayConnected = r.connected;

  if (transitionedUp) {
    /* Reset the diagnostic clock anchor on the actual link-up — diag
     * samples on the relay path inherit a stale anchor from a previous
     * direct-earclip session and land off-screen on the chart otherwise. */
    resetDiagnosticClock();
    lastRawTs = 0;
    /* Now that the glasses have an earclip source, try to auto-start the
     * default sensor program if the user hasn't picked one yet. Covers the
     * connect-order: glasses connected first (auto-start at that point
     * skipped because earclipRelay was null/false), earclip relay comes up
     * seconds later. The 1.5 s delay absorbs the config-refresh and any
     * other GATT writes already in flight. */
    scheduleAutoStartProgram('earclip relay linked');
    /* Schedule one-shot auto-refresh ~2 s after link-up. The glasses'
     * central does an enter_ready CONFIG read that should make this
     * unnecessary, but if the read drops (Bluedroid outbound queue) we
     * recover with a single 0xC5. The earclip-side notify-on-subscribe
     * fix (see firmware/main/transport_ble.c BLE_GAP_EVENT_SUBSCRIBE)
     * is the primary delivery path; this is the second-chance backup.
     * Manual reload via the ConfigPanel button is the third. */
    if (configRefreshTimer) clearTimeout(configRefreshTimer);
    configRefreshTimer = setTimeout(() => {
      configRefreshTimer = null;
      if (useDashboardStore.getState().config !== null) return;
      if (configRefreshInFlight) return;   // overlap guard
      configRefreshInFlight = true;
      void edgeDevice.requestEarclipConfigRead()
        .catch((err) => {
          appendBleLog('edge', 'error', `auto config refresh: ${(err as Error).message}`);
        })
        .finally(() => {
          configRefreshInFlight = false;
        });
    }, 2000);
  } else if (transitionedDown) {
    relayIbiRollingAvgMs = 0;  /* stale avg would corrupt next relay session */
    if (configRefreshTimer) {
      clearTimeout(configRefreshTimer);
      configRefreshTimer = null;
    }
  }
});

edgeDevice.addEventListener('relayedBattery', (e) => {
  if (isEarclipDirect()) return;
  const b = (e as CustomEvent<RelayedBattery>).detail;
  setState((s) => ({
    connection: {
      ...s.connection,
      narbis: {
        ...s.connection.narbis,
        battery: {
          soc_pct: b.soc_pct,
          mv: b.mv,
          charging: !!b.charging,
        },
      },
    },
  }));
});

/* 0xFA link-quality snapshot from the glasses (~1 Hz). Drives the
 * RSSI-bars/tooltip readout in ConnectionPanel. Web Bluetooth doesn't
 * expose RSSI to JS, so this firmware-emitted frame is the only source. */
edgeDevice.addEventListener('linkQuality', (e) => {
  const lq = (e as CustomEvent<LinkQuality>).detail;
  setState((s) => ({
    connection: {
      ...s.connection,
      edge: { ...s.connection.edge, linkQuality: lq },
    },
  }));
});

/* 0xF3 health frame bytes [20–21] (~1 Hz). Surfaces LED mode + duty in the
 * header so the app can confirm brightness commands are landing. */
edgeDevice.addEventListener('ledHealth', (e) => {
  const lh = (e as CustomEvent<LedHealth>).detail;
  setState((s) => ({
    connection: {
      ...s.connection,
      edge: { ...s.connection.edge, ledHealth: lh },
    },
  }));
});

/* Path B Phase 1: relayed CONFIG. The glasses central does a one-shot
 * GATTC read on connect (the earclip only notifies CONFIG on changes),
 * then mirrors any subsequent change-notifies. Either way we land here
 * with the serialized 50-byte blob. Deserialize and feed into the same
 * `config` slot the direct-earclip path uses; ConfigPanel renders from
 * it regardless of which path delivered it. */
edgeDevice.addEventListener('relayedConfig', (e) => {
  if (isEarclipDirect()) return;
  const r = (e as CustomEvent<RelayedConfig>).detail;
  try {
    const cfg = deserializeConfig(r.bytes);
    setState({ config: cfg });
    appendBleLog(
      'earclip',
      'rx',
      `config v${cfg.config_version} (relay; sample_rate=${cfg.sample_rate_hz} Hz)`,
    );
  } catch (err) {
    appendBleLog('earclip', 'error', `relay config parse: ${(err as Error).message}`);
  }
});

/* Path B Phase 2: relayed RAW_PPG batches. Wire format matches the
 * direct path — u16 sample_rate_hz, u16 n_samples, n × (u32 red, u32 ir).
 * We rebuild a NarbisRawSampleEvent and feed the existing processRawBatch
 * so the chart, jitter smoother, and counters all keep working. */
edgeDevice.addEventListener('relayedRawPpg', (e) => {
  if (isEarclipDirect()) return;
  const r = (e as CustomEvent<RelayedRawPpg>).detail;
  try {
    if (r.bytes.byteLength < 4) return;
    const dv = new DataView(r.bytes.buffer, r.bytes.byteOffset, r.bytes.byteLength);
    const sample_rate_hz = dv.getUint16(0, true);
    const n_samples = dv.getUint16(2, true);
    const expected = 4 + n_samples * 8;
    if (r.bytes.byteLength < expected) {
      appendBleLog(
        'earclip',
        'error',
        `relay raw_ppg truncated: have ${r.bytes.byteLength}, need ${expected}`,
      );
      return;
    }
    const samples: NarbisRawSample[] = new Array(n_samples);
    let off = 4;
    for (let i = 0; i < n_samples; i++) {
      const red = dv.getUint32(off, true); off += 4;
      const ir  = dv.getUint32(off, true); off += 4;
      samples[i] = { red, ir };
    }
    feedRawBatch({
      sample_rate_hz,
      n_samples,
      samples,
      timestamp: r.timestamp,
    });
  } catch (err) {
    appendBleLog('earclip', 'error', `relay raw_ppg parse: ${(err as Error).message}`);
  }
});

/* Path B: relayed diagnostic frames (0xF7). Same wire format as the
 * direct earclip diagnostic char, so we run the existing parseDiagnostic
 * and push samples to the filtered buffer. Earclip only emits these
 * when its diagnostics_enabled=1 AND diagnostics_mask has POST_FILTER
 * set — both edited via ConfigPanel. */
edgeDevice.addEventListener('relayedDiagnostic', (e) => {
  if (isEarclipDirect()) return;
  const r = (e as CustomEvent<RelayedDiagnostic>).detail;
  try {
    const dv = new DataView(r.bytes.buffer, r.bytes.byteOffset, r.bytes.byteLength);
    const samples = parseDiagnostic(dv, r.timestamp);
    if (samples.length === 0) return;
    for (const s of samples) {
      liveBuffers.filtered.push(s.timestamp, s);
    }
  } catch (err) {
    appendBleLog('earclip', 'error', `relay diag parse: ${(err as Error).message}`);
  }
});

export function setRecordingState(active: boolean, startedAt: number | null): void {
  setState({ recording: { active, startedAt } });
}

/** Used by the replay player to surface the recorded battery state on the
 * connection panel as the playhead moves. Pass null to clear (e.g. when
 * unloading a replay or seeking before any recorded sample). */
export function setReplayBattery(b: BatteryState | null): void {
  setState((s) => ({
    connection: {
      ...s.connection,
      narbis: { ...s.connection.narbis, battery: b },
    },
  }));
}
