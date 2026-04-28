import { create } from 'zustand';
import type { NarbisRuntimeConfig } from '../../../protocol/narbis_protocol';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

export interface DashboardState {
  connection: {
    narbis: ConnectionState;
    polar: ConnectionState;
  };
  recording: {
    active: boolean;
    startedAt: number | null;
  };
  config: NarbisRuntimeConfig | null;

  connectNarbis: () => Promise<void>;
  disconnectNarbis: () => Promise<void>;
  connectPolar: () => Promise<void>;
  disconnectPolar: () => Promise<void>;
  startRecording: () => void;
  stopRecording: () => void;
  setConfig: (config: NarbisRuntimeConfig) => void;
}

export const useDashboardStore = create<DashboardState>(() => ({
  connection: {
    narbis: 'disconnected',
    polar: 'disconnected',
  },
  recording: {
    active: false,
    startedAt: null,
  },
  config: null,

  connectNarbis: async () => {
    throw new Error('not implemented');
  },
  disconnectNarbis: async () => {
    throw new Error('not implemented');
  },
  connectPolar: async () => {
    throw new Error('not implemented');
  },
  disconnectPolar: async () => {
    throw new Error('not implemented');
  },
  startRecording: () => {
    throw new Error('not implemented');
  },
  stopRecording: () => {
    throw new Error('not implemented');
  },
  setConfig: () => {
    throw new Error('not implemented');
  },
}));
