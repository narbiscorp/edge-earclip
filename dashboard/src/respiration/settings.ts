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
import type { BeatSource, StrapId } from './log';

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

/** Baseline-removal windows. The value is the centred moving-average span in
 * seconds; longer keeps more of the slow content. 12 s passes normal breathing
 * (0.1-0.5 Hz) while removing gravity and posture drift. */
export const DETREND_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: 'off (absolute)' },
  { value: 2, label: '2 s' },
  { value: 4, label: '4 s' },
  { value: 8, label: '8 s' },
  { value: 12, label: '12 s' },
  { value: 30, label: '30 s' },
];

/** Per-channel gain for the accelerometer panels. `null` = auto-gain (each
 * channel autoranges to its own content). A number pins every channel to that
 * ± range in mG so their amplitudes are directly comparable. */
export const GAIN_OPTIONS: ReadonlyArray<{ value: number | null; label: string }> = [
  { value: null, label: 'auto' },
  { value: 5, label: '±5 mG' },
  { value: 20, label: '±20 mG' },
  { value: 50, label: '±50 mG' },
  { value: 200, label: '±200 mG' },
  { value: 1200, label: '±1200 mG' },
];

/** Accelerometer sample rates the H10 offers. Higher is not about resolving
 * faster breathing — respiration is below 0.5 Hz — but about how OFTEN frames
 * arrive: the strap fills each notification to the MTU, so 200 Hz delivers them
 * four times as often as 50 Hz, and the plot moves that much more continuously. */
export const ACC_RATE_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 25, label: '25 Hz' },
  { value: 50, label: '50 Hz' },
  { value: 100, label: '100 Hz' },
  { value: 200, label: '200 Hz' },
];

/** Smoothing windows, in seconds so they mean the same thing at every rate. */
export const SMOOTH_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: 'off' },
  { value: 0.05, label: '50 ms' },
  { value: 0.1, label: '100 ms' },
  { value: 0.25, label: '250 ms' },
  { value: 0.5, label: '500 ms' },
  { value: 1, label: '1 s' },
  { value: 2, label: '2 s' },
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

/** Which strap is on the sternum. The other one is the abdominal strap. Swappable
 * because the roles are a fact about how the subject was strapped up, not about
 * which device happened to pair first. */
export type DiaphragmView = 'overlay' | 'differential';

export interface SettingsState {
  /** Shared x-axis span, in seconds. */
  viewWindowSec: number;
  /** Live-follow. Turning it off unlocks pan/zoom on every chart. */
  follow: boolean;
  /** HRV computation window handed to the metrics worker. */
  analysisWindowSec: number;
  analysisSource: BeatSource;

  /** Strap worn across the sternum; the other is the abdominal strap. */
  chestStrap: StrapId;
  /** Accelerometer axis the diaphragm analysis runs on. 'auto' picks the axis
   * the two straps are actually comparable on — see chooseAxis. */
  diaphragmAxis: 'x' | 'y' | 'z' | 'mag' | 'auto';
  diaphragmView: DiaphragmView;
  /** Deep-breath calibration scale factors. 1 = uncalibrated. */
  calibChest: number;
  calibAbdo: number;

  metricsShaping: TraceShaping;
  ibiShaping: TraceShaping;
  accShaping: TraceShaping;
  ecgShaping: TraceShaping;
  /** Fixed ± range for every accelerometer panel, or null for auto-gain. */
  accGain: number | null;
  /** Requested H10 accelerometer rate, Hz. */
  accRateHz: number;

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
  setChestStrap: (s: StrapId) => void;
  setDiaphragmAxis: (a: 'x' | 'y' | 'z' | 'mag' | 'auto') => void;
  setDiaphragmView: (v: DiaphragmView) => void;
  setCalibration: (chest: number, abdo: number) => void;
  patchMetricsShaping: (p: Partial<TraceShaping>) => void;
  patchIbiShaping: (p: Partial<TraceShaping>) => void;
  patchAccShaping: (p: Partial<TraceShaping>) => void;
  patchEcgShaping: (p: Partial<TraceShaping>) => void;
  setAccGain: (v: number | null) => void;
  setAccRateHz: (hz: number) => void;
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
  chestStrap: 'main',
  diaphragmAxis: 'auto',
  diaphragmView: 'overlay',
  calibChest: 1,
  calibAbdo: 1,

  metricsShaping: { ...DEFAULT_SHAPING, shape: 'spline', maxPoints: 3000 },
  // A tachogram is irregularly sampled by construction; drawing it linear
  // between beats is the honest default.
  ibiShaping: { ...DEFAULT_SHAPING, shape: 'linear', maxPoints: 4000 },
  // 50 Hz x 3 axes over a long window is the one place decimation matters.
  // Baseline removal is ON by default: without it the breathing movement this
  // page exists to show is a sub-1% wiggle on the gravity offset.
  accShaping: {
    ...DEFAULT_SHAPING,
    shape: 'linear',
    maxPoints: 4000,
    detrendSec: 12,
    // A little smoothing by default: at 100 Hz the raw trace carries sensor
    // noise and footfall that swamp a few-mG breath on screen.
    filter: 'movavg',
    filterSec: 0.15,
  },
  // ECG keeps its absolute scale by default — the QRS amplitude is meaningful,
  // and the wander is obvious enough that removing it should be a choice.
  ecgShaping: { ...DEFAULT_SHAPING, shape: 'linear', maxPoints: 4000, detrendSec: 0 },
  accGain: null,
  accRateHz: 100,

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
  setChestStrap: (chestStrap) => set({ chestStrap }),
  setDiaphragmAxis: (diaphragmAxis) => set({ diaphragmAxis }),
  setDiaphragmView: (diaphragmView) => set({ diaphragmView }),
  setCalibration: (calibChest, calibAbdo) => set({ calibChest, calibAbdo }),
  patchMetricsShaping: (p) => set((s) => ({ metricsShaping: { ...s.metricsShaping, ...p } })),
  patchIbiShaping: (p) => set((s) => ({ ibiShaping: { ...s.ibiShaping, ...p } })),
  patchAccShaping: (p) => set((s) => ({ accShaping: { ...s.accShaping, ...p } })),
  patchEcgShaping: (p) => set((s) => ({ ecgShaping: { ...s.ecgShaping, ...p } })),
  setAccGain: (accGain) => set({ accGain }),
  setAccRateHz: (accRateHz) => set({ accRateHz }),
  togglePanel: (k) => set((s) => ({ panels: { ...s.panels, [k]: !s.panels[k] } })),
  toggleCoherence: (k) => set((s) => ({ coherence: { ...s.coherence, [k]: !s.coherence[k] } })),
  toggleAcc: (k) => set((s) => ({ acc: { ...s.acc, [k]: !s.acc[k] } })),
  setIbiShowEarclip: (ibiShowEarclip) => set({ ibiShowEarclip }),
  setIbiShowH10: (ibiShowH10) => set({ ibiShowH10 }),
  setIbiShowArtifacts: (ibiShowArtifacts) => set({ ibiShowArtifacts }),
}));
