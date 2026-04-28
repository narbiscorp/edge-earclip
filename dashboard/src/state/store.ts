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
import { StreamBuffer } from './streamBuffer';

export type ConnectionState = NarbisStatus | PolarStatus;

export interface PolarBeatRecord {
  bpm: number;
  rr: number[];
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
  buffers: {
    rawPpg: StreamBuffer<NarbisRawSample>;
    narbisBeats: StreamBuffer<NarbisBeatEvent>;
    polarBeats: StreamBuffer<PolarBeatRecord>;
    sqi: StreamBuffer<NarbisSqiPayload>;
    filtered: StreamBuffer<DiagnosticSample>;
  };
  lastError: string | null;

  connectNarbis: () => Promise<void>;
  disconnectNarbis: () => Promise<void>;
  connectPolar: () => Promise<void>;
  disconnectPolar: () => Promise<void>;
  startRecording: () => void;
  stopRecording: () => void;
  setConfig: (config: NarbisRuntimeConfig) => void;
}

const buffers: DashboardState['buffers'] = {
  rawPpg: new StreamBuffer<NarbisRawSample>(12000),
  narbisBeats: new StreamBuffer<NarbisBeatEvent>(1200),
  polarBeats: new StreamBuffer<PolarBeatRecord>(1200),
  sqi: new StreamBuffer<NarbisSqiPayload>(600),
  filtered: new StreamBuffer<DiagnosticSample>(6000),
};

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
  buffers,
  lastError: null,

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
  startRecording: () => {
    set((s) => ({ recording: { active: true, startedAt: Date.now() }, counters: s.counters }));
  },
  stopRecording: () => {
    set({ recording: { active: false, startedAt: null } });
  },
  setConfig: (config) => set({ config }),
}));

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const setState = useDashboardStore.setState;

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
  buffers.narbisBeats.push(beat.timestamp, beat);
  setState((s) => ({
    lastBeat: beat,
    counters: { ...s.counters, beats: s.counters.beats + 1 },
  }));
});

narbisDevice.addEventListener('sqiReceived', (e) => {
  const sqi = (e as CustomEvent<NarbisSqiEvent>).detail;
  buffers.sqi.push(sqi.timestamp, sqi);
  setState((s) => ({
    lastSqi: sqi,
    counters: { ...s.counters, sqi: s.counters.sqi + 1 },
  }));
});

narbisDevice.addEventListener('rawSampleReceived', (e) => {
  const raw = (e as CustomEvent<NarbisRawSampleEvent>).detail;
  const baseTs = raw.timestamp;
  const periodMs = raw.sample_rate_hz > 0 ? 1000 / raw.sample_rate_hz : 0;
  for (let i = 0; i < raw.samples.length; i++) {
    buffers.rawPpg.push(baseTs - (raw.samples.length - 1 - i) * periodMs, raw.samples[i]);
  }
  setState((s) => ({
    counters: { ...s.counters, rawSamples: s.counters.rawSamples + raw.samples.length },
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
    buffers.filtered.push(s.timestamp, s);
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
  buffers.polarBeats.push(beat.timestamp, { bpm: beat.bpm, rr: beat.rrIntervals_ms });
  setState((s) => ({
    counters: { ...s.counters, polarBeats: s.counters.polarBeats + 1 },
  }));
});
