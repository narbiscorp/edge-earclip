import { create } from 'zustand';
import {
  parseSessionFromJson,
  parseSessionFromZip,
  recomputeMetrics,
  ReplayPlayer,
} from '../recording/replay';
import type { LoadedSession } from '../recording/types';
import { useDashboardStore, setReplayBattery } from './store';
import { metricsBuffers } from './metricsBuffer';

export type ReplaySpeed = 1 | 2 | 5 | 10;

export interface ReplayStoreState {
  loaded: LoadedSession | null;
  playerVersion: number; // bumped to force UI refresh on player creation
  position_ms: number;
  duration_ms: number;
  speed: ReplaySpeed;
  isPlaying: boolean;
  recomputeWindowSec: number;
  recomputing: boolean;
  lastError: string | null;
  loadFile: (file: File) => Promise<void>;
  loadBlob: (blob: Blob, filename: string) => Promise<void>;
  loadJsonText: (text: string) => Promise<void>;
  unload: () => void;
  play: () => void;
  pause: () => void;
  seek: (ms: number) => void;
  setSpeed: (s: ReplaySpeed) => void;
  setRecomputeWindow: (s: number) => void;
  runRecompute: () => Promise<void>;
}

let player: ReplayPlayer | null = null;
let unsubscribeTick: (() => void) | null = null;

export const useReplayStore = create<ReplayStoreState>((set, get) => ({
  loaded: null,
  playerVersion: 0,
  position_ms: 0,
  duration_ms: 0,
  speed: 1,
  isPlaying: false,
  recomputeWindowSec: 60,
  recomputing: false,
  lastError: null,

  loadFile: async (file) => {
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.zip')) {
      await get().loadBlob(file, file.name);
    } else {
      const text = await file.text();
      await get().loadJsonText(text);
    }
  },

  loadBlob: async (blob) => {
    set({ lastError: null });
    try {
      const session = await parseSessionFromZip(blob);
      installSession(session, set);
    } catch (err) {
      set({ lastError: errMsg(err) });
    }
  },

  loadJsonText: async (text) => {
    set({ lastError: null });
    try {
      const session = await parseSessionFromJson(text);
      installSession(session, set);
    } catch (err) {
      set({ lastError: errMsg(err) });
    }
  },

  unload: () => {
    if (unsubscribeTick) {
      unsubscribeTick();
      unsubscribeTick = null;
    }
    if (player) {
      player.dispose();
      player = null;
    }
    metricsBuffers.replay.clear();
    const bufs = useDashboardStore.getState().replayBuffers;
    bufs.rawPpg.clear();
    bufs.narbisBeats.clear();
    bufs.sqi.clear();
    bufs.filtered.clear();
    bufs.polarBeats.clear();
    setReplayBattery(null);
    if (useDashboardStore.getState().dataSource === 'replay') {
      useDashboardStore.getState().setDataSource('live');
    }
    set({
      loaded: null,
      position_ms: 0,
      duration_ms: 0,
      isPlaying: false,
    });
  },

  play: () => {
    if (!player) return;
    player.play();
    set({ isPlaying: true });
  },

  pause: () => {
    if (!player) return;
    player.pause();
    set({ isPlaying: false });
  },

  seek: (ms) => {
    if (!player) return;
    player.seek(ms);
    set({ position_ms: player.position_ms });
  },

  setSpeed: (s) => {
    if (player) player.setSpeed(s);
    set({ speed: s });
  },

  setRecomputeWindow: (s) => set({ recomputeWindowSec: s }),

  runRecompute: async () => {
    const session = get().loaded;
    if (!session) return;
    set({ recomputing: true, lastError: null });
    try {
      await recomputeMetrics(session, get().recomputeWindowSec);
      // Force a UI refresh after the buffer is repopulated by reseeking.
      if (player) player.seek(player.position_ms);
    } catch (err) {
      set({ lastError: errMsg(err) });
    } finally {
      set({ recomputing: false });
    }
  },
}));

function installSession(
  session: LoadedSession,
  set: (
    partial: Partial<ReplayStoreState> | ((s: ReplayStoreState) => Partial<ReplayStoreState>),
  ) => void,
): void {
  if (unsubscribeTick) {
    unsubscribeTick();
    unsubscribeTick = null;
  }
  if (player) {
    player.dispose();
  }
  player = new ReplayPlayer(session);
  unsubscribeTick = player.onTick((pos) => {
    useReplayStore.setState({ position_ms: pos, isPlaying: player?.isPlaying ?? false });
  });
  set({
    loaded: session,
    playerVersion: useReplayStore.getState().playerVersion + 1,
    position_ms: 0,
    duration_ms: player.duration_ms,
    isPlaying: false,
    speed: 1,
  });
  // Seed the replay buffers at t=0 so the charts show something on load.
  player.seek(0);
  // Switch dashboard data source to replay so charts render the loaded session.
  useDashboardStore.getState().setDataSource('replay');
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
