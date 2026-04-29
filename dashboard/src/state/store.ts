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
} from '../ble/narbisDevice';
import {
  polarH10,
  type PolarStatus,
  type PolarBeatEvent,
  type PolarDisconnectedDetail,
  type PolarErrorDetail,
} from '../ble/polarH10';
import type {
  NarbisRuntimeConfig,
  NarbisRawSample,
  NarbisSqiPayload,
  DiagnosticSample,
} from '../ble/parsers';
import { resetDiagnosticClock } from '../ble/parsers';
import { StreamBuffer } from './streamBuffer';

export type ConnectionState = NarbisStatus | PolarStatus;
export type DataSource = 'live' | 'replay';

export interface PolarBeatRecord {
  bpm: number;
  rr: number[];
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
    narbis: { state: NarbisStatus; deviceName: string | null; battery: number | null };
    polar: { state: PolarStatus; deviceName: string | null };
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

  connectNarbis: () => Promise<void>;
  disconnectNarbis: () => Promise<void>;
  connectPolar: () => Promise<void>;
  disconnectPolar: () => Promise<void>;
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
    narbis: { state: 'disconnected', deviceName: null, battery: null },
    polar: { state: 'disconnected', deviceName: null },
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
  setConfig: (config) => set({ config }),
  setDataSource: (source) => set({ dataSource: source }),
  setWindowSec: (seconds) => set({ windowSec: seconds }),
}));

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
      narbis: { ...s.connection.narbis, state: 'connected', deviceName: name },
    },
  }));
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
  }
  setState((s) => ({
    connection: {
      ...s.connection,
      narbis: {
        ...s.connection.narbis,
        state: narbisDevice.status,
        deviceName: narbisDevice.status === 'reconnecting' ? s.connection.narbis.deviceName : null,
        battery: narbisDevice.status === 'reconnecting' ? s.connection.narbis.battery : null,
      },
    },
    lastError: reason === 'error' && error ? error.message : s.lastError,
  }));
});

narbisDevice.addEventListener('error', (e) => {
  const { error, phase } = (e as CustomEvent<NarbisErrorDetail>).detail;
  setState({ lastError: `${phase}: ${error.message}` });
});

narbisDevice.addEventListener('beatReceived', (e) => {
  const beat = (e as CustomEvent<NarbisBeatEvent>).detail;
  liveBuffers.narbisBeats.push(beat.timestamp, beat);
  setState((s) => ({
    lastBeat: beat,
    counters: { ...s.counters, beats: s.counters.beats + 1 },
  }));
});

narbisDevice.addEventListener('sqiReceived', (e) => {
  const sqi = (e as CustomEvent<NarbisSqiEvent>).detail;
  liveBuffers.sqi.push(sqi.timestamp, sqi);
  setState((s) => ({
    lastSqi: sqi,
    counters: { ...s.counters, sqi: s.counters.sqi + 1 },
  }));
});

narbisDevice.addEventListener('rawSampleReceived', (e) => {
  const raw = (e as CustomEvent<NarbisRawSampleEvent>).detail;
  const arrivalMs = raw.timestamp;
  const periodMs = raw.sample_rate_hz > 0 ? 1000 / raw.sample_rate_hz : 0;
  const n = raw.samples.length;
  if (periodMs === 0 || n === 0) return;

  // Where this batch's first sample WOULD land if anchored to arrival time.
  const arrivalFirst = arrivalMs - (n - 1) * periodMs;
  // Where it lands continuing the previous batch.
  const continueFirst = lastRawTs > 0 ? lastRawTs + periodMs : arrivalFirst;
  // Pick the later of the two (monotonic). If we've fallen far behind
  // wall-clock (> N samples worth), resync to arrival to avoid drift.
  let firstTs = Math.max(continueFirst, arrivalFirst);
  if (continueFirst < arrivalFirst - 2 * n * periodMs) {
    firstTs = arrivalFirst;
  }

  for (let i = 0; i < n; i++) {
    liveBuffers.rawPpg.push(firstTs + i * periodMs, raw.samples[i]);
  }
  lastRawTs = firstTs + (n - 1) * periodMs;

  setState((s) => ({
    counters: { ...s.counters, rawSamples: s.counters.rawSamples + n },
  }));
});

narbisDevice.addEventListener('batteryReceived', (e) => {
  const batt = (e as CustomEvent<NarbisBatteryEvent>).detail;
  setState((s) => ({
    connection: {
      ...s.connection,
      narbis: { ...s.connection.narbis, battery: batt.soc_pct },
    },
  }));
});

narbisDevice.addEventListener('configChanged', (e) => {
  const cfg = (e as CustomEvent<NarbisRuntimeConfig>).detail;
  setState({ config: cfg });
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
  setState((s) => ({
    counters: { ...s.counters, polarBeats: s.counters.polarBeats + 1 },
  }));
});

export function setRecordingState(active: boolean, startedAt: number | null): void {
  setState({ recording: { active, startedAt } });
}
