/*
 * settings.ts — all view + conditioning state for the three charts.
 *
 * One store, because the x-axis window is shared: the whole point of stacking a
 * tachogram under a coherence trace is that they line up. Per-chart controls
 * (filter, resample, line shape, which series are drawn) stay per-chart, since
 * a 50 Hz accelerometer and a ~1 Hz metric series want different treatment.
 */
import { create } from 'zustand';
import { DEFAULT_SHAPING, type TraceShaping } from './dsp';
import type { BeatSource } from './log';

/** View windows for the x-axis. */
export const VIEW_WINDOWS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 30, label: '30s' },
  { value: 60, label: '1m' },
  { value: 120, label: '2m' },
  { value: 300, label: '5m' },
  { value: 600, label: '10m' },
  { value: 1800, label: '30m' },
  { value: 3600, label: '1h' },
];

/** HRV analysis windows. 64 s is the default because it is what the firmware
 * coherence port and the Coherence Engine both use, so the traces are directly
 * comparable at that setting; shorter reacts faster, longer is steadier. */
export const ANALYSIS_WINDOWS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 30, label: '30s' },
  { value: 60, label: '60s' },
  { value: 64, label: '64s' },
  { value: 120, label: '2m' },
  { value: 180, label: '3m' },
  { value: 300, label: '5m' },
];

export const FILTER_LABELS: ReadonlyArray<{ value: TraceShaping['filter']; label: string; hint: string }> = [
  { value: 'none', label: 'None', hint: 'Raw samples, exactly as recorded.' },
  { value: 'movavg', label: 'Moving avg', hint: 'Centered box average over N samples. Simple, but blunts peaks.' },
  { value: 'median', label: 'Median', hint: 'Centered median over N samples. Removes isolated ectopic spikes without smearing them.' },
  { value: 'savgol', label: 'Savitzky–Golay', hint: 'Local polynomial fit. Smooths noise while preserving peak height and width.' },
  { value: 'ewma', label: 'EWMA', hint: 'Exponential smoothing run forward and backward, so features do not shift in time.' },
];

export const RESAMPLE_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: 'off' },
  { value: 1, label: '1 Hz' },
  { value: 2, label: '2 Hz' },
  { value: 4, label: '4 Hz' },
  { value: 10, label: '10 Hz' },
];

export const SHAPE_OPTIONS: ReadonlyArray<{ value: TraceShaping['shape']; label: string }> = [
  { value: 'linear', label: 'linear' },
  { value: 'spline', label: 'spline' },
  { value: 'hv', label: 'step' },
];

/** Which panels of the cardiac chart are drawn. */
export interface PanelToggles {
  hr: boolean;
  hrv: boolean;
  coherence: boolean;
  respiration: boolean;
}

/** Which coherence definitions are drawn in the coherence panel. Max 5 — the
 * palette has 5 validated slots and a 6th series would have to cycle a hue. */
export interface CoherenceToggles {
  engine: boolean;
  firmware: boolean;
  heartmath: boolean;
  resonance: boolean;
  breathHeart: boolean;
}

export interface AccToggles {
  x: boolean;
  y: boolean;
  z: boolean;
  mag: boolean;
}

export interface SettingsState {
  /** Shared x-axis span, in seconds. */
  viewWindowSec: number;
  /** Live-follow. Turning it off unlocks pan/zoom on every chart. */
  follow: boolean;
  /** HRV computation window handed to the metrics worker. */
  analysisWindowSec: number;
  analysisSource: BeatSource;

  metricsShaping: TraceShaping;
  ibiShaping: TraceShaping;
  accShaping: TraceShaping;

  panels: PanelToggles;
  coherence: CoherenceToggles;
  acc: AccToggles;
  /** Draw earclip beats alongside the H10 on the tachogram. */
  ibiShowEarclip: boolean;
  ibiShowH10: boolean;
  /** Mark beats the plausibility gate rejected. They are always logged. */
  ibiShowArtifacts: boolean;

  setViewWindowSec: (s: number) => void;
  setFollow: (f: boolean) => void;
  setAnalysisWindowSec: (s: number) => void;
  setAnalysisSource: (s: BeatSource) => void;
  patchMetricsShaping: (p: Partial<TraceShaping>) => void;
  patchIbiShaping: (p: Partial<TraceShaping>) => void;
  patchAccShaping: (p: Partial<TraceShaping>) => void;
  togglePanel: (k: keyof PanelToggles) => void;
  toggleCoherence: (k: keyof CoherenceToggles) => void;
  toggleAcc: (k: keyof AccToggles) => void;
  setIbiShowEarclip: (v: boolean) => void;
  setIbiShowH10: (v: boolean) => void;
  setIbiShowArtifacts: (v: boolean) => void;
}

export const useSettings = create<SettingsState>((set) => ({
  viewWindowSec: 300,
  follow: true,
  analysisWindowSec: 64,
  analysisSource: 'h10',

  // Metrics arrive at 1 Hz and are already windowed averages — smoothing them
  // again by default would hide the variation they exist to show.
  metricsShaping: { ...DEFAULT_SHAPING, shape: 'spline', maxPoints: 3000 },
  // A tachogram is irregularly sampled by construction; drawing it linear
  // between beats is the honest default.
  ibiShaping: { ...DEFAULT_SHAPING, shape: 'linear', maxPoints: 4000 },
  // 50 Hz × 3 axes over a long window is the one place decimation matters.
  accShaping: { ...DEFAULT_SHAPING, shape: 'linear', maxPoints: 2500 },

  panels: { hr: true, hrv: true, coherence: true, respiration: true },
  coherence: {
    engine: true,
    firmware: false,
    heartmath: false,
    resonance: false,
    breathHeart: false,
  },
  acc: { x: true, y: true, z: true, mag: false },
  ibiShowEarclip: true,
  ibiShowH10: true,
  ibiShowArtifacts: true,

  setViewWindowSec: (viewWindowSec) => set({ viewWindowSec }),
  setFollow: (follow) => set({ follow }),
  setAnalysisWindowSec: (analysisWindowSec) => set({ analysisWindowSec }),
  setAnalysisSource: (analysisSource) => set({ analysisSource }),
  patchMetricsShaping: (p) => set((s) => ({ metricsShaping: { ...s.metricsShaping, ...p } })),
  patchIbiShaping: (p) => set((s) => ({ ibiShaping: { ...s.ibiShaping, ...p } })),
  patchAccShaping: (p) => set((s) => ({ accShaping: { ...s.accShaping, ...p } })),
  togglePanel: (k) => set((s) => ({ panels: { ...s.panels, [k]: !s.panels[k] } })),
  toggleCoherence: (k) => set((s) => ({ coherence: { ...s.coherence, [k]: !s.coherence[k] } })),
  toggleAcc: (k) => set((s) => ({ acc: { ...s.acc, [k]: !s.acc[k] } })),
  setIbiShowEarclip: (ibiShowEarclip) => set({ ibiShowEarclip }),
  setIbiShowH10: (ibiShowH10) => set({ ibiShowH10 }),
  setIbiShowArtifacts: (ibiShowArtifacts) => set({ ibiShowArtifacts }),
}));
