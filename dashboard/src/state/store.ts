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
  type RelayedIbi,
  type RelayedBattery,
  type RelayedConfig,
  type RelayedRawPpg,
  type RelayedDiagnostic,
  type CentralRelayState,
} from '../ble/edgeDevice';
import type {
  NarbisRuntimeConfig,
  NarbisRawSample,
  NarbisSqiPayload,
  DiagnosticSample,
} from '../ble/parsers';
import { resetDiagnosticClock, deserializeConfig, parseDiagnostic } from '../ble/parsers';
import { StreamBuffer } from './streamBuffer';

export type ConnectionState = NarbisStatus | PolarStatus | EdgeStatus;
export type DataSource = 'live' | 'replay';

/* BLE event log entry. Captures connect/disconnect, notifications, control
 * writes - everything user-visible across both devices. Stored as a fixed-
 * size ring (newest last) so the UI can show a tail without unbounded
 * memory growth. */
export type BleLogSource = 'earclip' | 'edge' | 'system';
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

export const useDashboardStore = create<DashboardState>((set) => ({
  connection: {
    narbis: { state: 'disconnected', deviceName: null, battery: null, phase: null, reconnectAttempt: null },
    polar:  { state: 'disconnected', deviceName: null },
    edge:   { state: 'disconnected', deviceName: null, lastFrameAt: null, earclipRelay: null },
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
    try {
      await polarH10.connect();
    } catch (err) {
      set({ lastError: errorMessage(err) });
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

polarH10.addEventListener('connected', (e) => {
  const { name } = (e as CustomEvent<{ name: string }>).detail;
  setState((s) => ({
    connection: {
      ...s.connection,
      polar: { state: 'connected', deviceName: name },
    },
  }));
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
    lastError: reason === 'error' && error ? error.message : s.lastError,
  }));
});

polarH10.addEventListener('error', (e) => {
  const { error, phase } = (e as CustomEvent<PolarErrorDetail>).detail;
  setState({ lastError: `polar/${phase}: ${error.message}` });
});

polarH10.addEventListener('beatReceived', (e) => {
  const beat = (e as CustomEvent<PolarBeatEvent>).detail;
  liveBuffers.polarBeats.push(beat.timestamp, { bpm: beat.bpm, rr: beat.rrIntervals_ms });
  pending.polarBeats += 1;
  scheduleCounterFlush();
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
});

edgeDevice.addEventListener('disconnected', (e) => {
  const { reason, error } = (e as CustomEvent<EdgeDisconnectedDetail>).detail;
  setState((s) => ({
    connection: {
      ...s.connection,
      edge: {
        state: edgeDevice.status,
        deviceName: edgeDevice.status === 'reconnecting' ? s.connection.edge.deviceName : null,
        lastFrameAt: edgeDevice.status === 'reconnecting' ? s.connection.edge.lastFrameAt : null,
        earclipRelay: edgeDevice.status === 'reconnecting' ? s.connection.edge.earclipRelay : null,
      },
    },
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

edgeDevice.addEventListener('relayedIbi', (e) => {
  if (isEarclipDirect()) return;  // direct path already covers this
  const r = (e as CustomEvent<RelayedIbi>).detail;
  const beat: NarbisBeatEvent = {
    bpm: r.ibi_ms > 0 ? Math.round(60000 / r.ibi_ms) : 0,
    ibi_ms: r.ibi_ms,
    confidence: r.confidence_x100,
    flags: r.flags,
    sqi: null,
    timestamp: r.timestamp,
  };
  liveBuffers.narbisBeats.push(beat.timestamp, beat);
  pending.beats += 1;
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
  } else if (transitionedDown && configRefreshTimer) {
    clearTimeout(configRefreshTimer);
    configRefreshTimer = null;
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
