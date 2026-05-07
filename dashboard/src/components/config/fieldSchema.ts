import {
  NarbisBleProfile,
  NarbisDataFormat,
  NarbisDetectorMode,
} from '../../ble/parsers';
import type { NarbisRuntimeConfig } from '../../ble/parsers';

export type SectionId =
  | 'sensorLed'
  | 'dcAgc'
  | 'bandpass'
  | 'elgendi'
  | 'ibi'
  | 'sqi'
  | 'detector'
  | 'transport'
  | 'diagnostics';

export interface SectionDef {
  id: SectionId;
  label: string;
  defaultExpanded: boolean;
}

export const SECTIONS: SectionDef[] = [
  { id: 'sensorLed',   label: 'Sensor & LED',          defaultExpanded: true  },
  { id: 'dcAgc',       label: 'DC Removal & AGC',      defaultExpanded: true  },
  { id: 'bandpass',    label: 'Bandpass Filter',       defaultExpanded: false },
  { id: 'elgendi',     label: 'Elgendi Peak Detection', defaultExpanded: false },
  { id: 'ibi',         label: 'IBI Validation',        defaultExpanded: false },
  { id: 'sqi',         label: 'Signal Quality',        defaultExpanded: false },
  { id: 'detector',    label: 'Adaptive Detector',     defaultExpanded: true  },
  { id: 'transport',   label: 'Transport & Mode',      defaultExpanded: false },
  { id: 'diagnostics', label: 'Diagnostics',           defaultExpanded: false },
];

export type ConfigKey = keyof NarbisRuntimeConfig;

interface BaseFieldSpec {
  key: ConfigKey;
  section: SectionId;
  label: string;
  help?: string;
  hidden?: boolean;
  requiresReboot?: boolean;
}

export interface NumericFieldSpec extends BaseFieldSpec {
  kind: 'numeric';
  min: number;
  max: number;
  step: number;
  scale?: number;
  unit?: string;
  validate?: (raw: number, cfg: NarbisRuntimeConfig) => string | null;
}

export interface EnumOption {
  value: number;
  label: string;
}

export interface EnumFieldSpec extends BaseFieldSpec {
  kind: 'enum';
  options: EnumOption[];
}

export interface ToggleFieldSpec extends BaseFieldSpec {
  kind: 'toggle';
}

export interface BitmaskBit {
  bit: number;
  label: string;
  help?: string;
}

export interface BitmaskFieldSpec extends BaseFieldSpec {
  kind: 'bitmask';
  bits: BitmaskBit[];
}

export interface ReadonlyFieldSpec extends BaseFieldSpec {
  kind: 'readonly';
  format?: (value: unknown) => string;
}

export type FieldSpec =
  | NumericFieldSpec
  | EnumFieldSpec
  | ToggleFieldSpec
  | BitmaskFieldSpec
  | ReadonlyFieldSpec;

const numeric = (spec: Omit<NumericFieldSpec, 'kind'>): NumericFieldSpec => ({ kind: 'numeric', ...spec });
const enumField = (spec: Omit<EnumFieldSpec, 'kind'>): EnumFieldSpec => ({ kind: 'enum', ...spec });
const toggle = (spec: Omit<ToggleFieldSpec, 'kind'>): ToggleFieldSpec => ({ kind: 'toggle', ...spec });
const bitmask = (spec: Omit<BitmaskFieldSpec, 'kind'>): BitmaskFieldSpec => ({ kind: 'bitmask', ...spec });
const readonly = (spec: Omit<ReadonlyFieldSpec, 'kind'>): ReadonlyFieldSpec => ({ kind: 'readonly', ...spec });

export const FIELD_SCHEMA: Record<ConfigKey, FieldSpec> = {
  config_version: readonly({
    key: 'config_version',
    section: 'sensorLed',
    label: 'Config version',
    help: 'Firmware-managed; increments on schema changes.',
  }),

  // --- Sensor & LED ---
  sample_rate_hz: enumField({
    key: 'sample_rate_hz',
    section: 'sensorLed',
    label: 'Sample rate',
    help: 'PPG sampling frequency. Requires firmware reboot to apply.',
    requiresReboot: true,
    options: [
      { value: 50,  label: '50 Hz' },
      { value: 100, label: '100 Hz' },
      { value: 200, label: '200 Hz' },
      { value: 400, label: '400 Hz' },
    ],
  }),
  led_red_ma_x10: numeric({
    key: 'led_red_ma_x10',
    section: 'sensorLed',
    label: 'Red LED current',
    min: 0, max: 510, step: 1,
    scale: 0.1, unit: 'mA',
    help: 'AGC may override this if enabled.',
  }),
  led_ir_ma_x10: numeric({
    key: 'led_ir_ma_x10',
    section: 'sensorLed',
    label: 'IR LED current',
    min: 0, max: 510, step: 1,
    scale: 0.1, unit: 'mA',
  }),

  // --- DC Removal & AGC ---
  agc_enabled: toggle({
    key: 'agc_enabled',
    section: 'dcAgc',
    label: 'AGC enabled',
    help: 'Automatic LED current adjustment to keep DC in target range.',
  }),
  reserved_agc: readonly({
    key: 'reserved_agc',
    section: 'dcAgc',
    label: 'reserved_agc',
    hidden: true,
  }),
  agc_update_period_ms: numeric({
    key: 'agc_update_period_ms',
    section: 'dcAgc',
    label: 'AGC update period',
    min: 50, max: 5000, step: 10,
    unit: 'ms',
  }),
  agc_target_dc_min: numeric({
    key: 'agc_target_dc_min',
    section: 'dcAgc',
    label: 'AGC target DC min',
    min: 0, max: 262143, step: 100,
    unit: 'counts',
    validate: (v, c) =>
      v >= c.agc_target_dc_max ? 'must be less than AGC target DC max' : null,
  }),
  agc_target_dc_max: numeric({
    key: 'agc_target_dc_max',
    section: 'dcAgc',
    label: 'AGC target DC max',
    min: 0, max: 262143, step: 100,
    unit: 'counts',
    validate: (v, c) =>
      v <= c.agc_target_dc_min ? 'must be greater than AGC target DC min' : null,
  }),
  agc_step_ma_x10: numeric({
    key: 'agc_step_ma_x10',
    section: 'dcAgc',
    label: 'AGC step',
    min: 1, max: 100, step: 1,
    scale: 0.1, unit: 'mA',
    help: 'LED current increment per AGC update.',
  }),
  agc_adaptive_step: toggle({
    key: 'agc_adaptive_step',
    section: 'dcAgc',
    label: 'Adaptive step size',
    help: 'Scale AGC step by DC error magnitude (1×–4×). Faster recovery from motion artifacts.',
  }),

  // --- Bandpass ---
  bandpass_low_hz_x100: numeric({
    key: 'bandpass_low_hz_x100',
    section: 'bandpass',
    label: 'Bandpass low',
    min: 1, max: 2000, step: 1,
    scale: 0.01, unit: 'Hz',
    validate: (v, c) =>
      v >= c.bandpass_high_hz_x100 ? 'must be less than bandpass high' : null,
  }),
  bandpass_high_hz_x100: numeric({
    key: 'bandpass_high_hz_x100',
    section: 'bandpass',
    label: 'Bandpass high',
    min: 2, max: 5000, step: 1,
    scale: 0.01, unit: 'Hz',
    validate: (v, c) =>
      v <= c.bandpass_low_hz_x100 ? 'must be greater than bandpass low' : null,
  }),

  // --- Elgendi ---
  elgendi_w1_ms: numeric({
    key: 'elgendi_w1_ms',
    section: 'elgendi',
    label: 'W1 (peak window)',
    min: 10, max: 1000, step: 1,
    unit: 'ms',
    validate: (v, c) =>
      v >= c.elgendi_w2_ms ? 'must be less than W2' : null,
  }),
  elgendi_w2_ms: numeric({
    key: 'elgendi_w2_ms',
    section: 'elgendi',
    label: 'W2 (beat window)',
    min: 50, max: 3000, step: 1,
    unit: 'ms',
    validate: (v, c) =>
      v <= c.elgendi_w1_ms ? 'must be greater than W1' : null,
  }),
  elgendi_beta_x1000: numeric({
    key: 'elgendi_beta_x1000',
    section: 'elgendi',
    label: 'Beta (offset)',
    min: 0, max: 500, step: 1,
    scale: 0.001,
  }),

  // --- IBI Validation ---
  ibi_min_ms: numeric({
    key: 'ibi_min_ms',
    section: 'ibi',
    label: 'IBI min',
    min: 200, max: 2000, step: 5,
    unit: 'ms',
    help: '300 ms ≈ 200 BPM ceiling.',
    validate: (v, c) =>
      v >= c.ibi_max_ms ? 'must be less than IBI max' : null,
  }),
  ibi_max_ms: numeric({
    key: 'ibi_max_ms',
    section: 'ibi',
    label: 'IBI max',
    min: 400, max: 3000, step: 5,
    unit: 'ms',
    help: '2000 ms ≈ 30 BPM floor.',
    validate: (v, c) =>
      v <= c.ibi_min_ms ? 'must be greater than IBI min' : null,
  }),
  ibi_max_delta_pct: numeric({
    key: 'ibi_max_delta_pct',
    section: 'ibi',
    label: 'Max IBI delta',
    min: 0, max: 100, step: 1,
    unit: '%',
    help: 'Maximum percent change between consecutive IBIs.',
  }),

  // --- Signal Quality ---
  sqi_threshold_x100: numeric({
    key: 'sqi_threshold_x100',
    section: 'sqi',
    label: 'SQI threshold',
    min: 0, max: 100, step: 1,
    scale: 0.01,
    help: 'Beats below this SQI are flagged low_sqi.',
  }),

  // --- Adaptive Detector (config_version 4) ---
  detector_mode: enumField({
    key: 'detector_mode',
    section: 'detector',
    label: 'Detector mode',
    help: 'FIXED keeps the proven Elgendi rule-based detector. ADAPTIVE adds online template matching, Kalman gating, and self-tuning α — set OFF to revert without reflashing.',
    options: [
      { value: NarbisDetectorMode.FIXED,    label: 'OFF — Fixed Elgendi' },
      { value: NarbisDetectorMode.ADAPTIVE, label: 'ON — Adaptive (NCC + Kalman)' },
    ],
  }),
  template_window_ms: numeric({
    key: 'template_window_ms',
    section: 'detector',
    label: 'Template window',
    min: 80, max: 1000, step: 10,
    unit: 'ms',
    help: 'Matched-filter window length. Half this is added to detection latency (look-ahead). 200 ms ≈ 100 ms latency at 200 Hz.',
  }),
  template_max_beats: numeric({
    key: 'template_max_beats',
    section: 'detector',
    label: 'Template depth',
    min: 1, max: 16, step: 1,
    help: 'Number of recent accepted beats averaged into the matched-filter template.',
  }),
  template_warmup_beats: numeric({
    key: 'template_warmup_beats',
    section: 'detector',
    label: 'Template warmup',
    min: 0, max: 32, step: 1,
    help: 'Beats accepted before NCC gating activates.',
  }),
  ncc_min_x1000: numeric({
    key: 'ncc_min_x1000',
    section: 'detector',
    label: 'NCC admit threshold',
    min: 0, max: 1000, step: 10,
    scale: 0.001,
    help: 'Minimum normalized cross-correlation against template to accept a candidate.',
    validate: (v, c) =>
      v > c.ncc_learn_min_x1000 ? 'must be ≤ NCC learn threshold' : null,
  }),
  ncc_learn_min_x1000: numeric({
    key: 'ncc_learn_min_x1000',
    section: 'detector',
    label: 'NCC learn threshold',
    min: 0, max: 1000, step: 10,
    scale: 0.001,
    help: 'Minimum NCC for a beat to update the template — prevents corruption during artifact bursts.',
    validate: (v, c) =>
      v < c.ncc_min_x1000 ? 'must be ≥ NCC admit threshold' : null,
  }),
  kalman_q_ms2: numeric({
    key: 'kalman_q_ms2',
    section: 'detector',
    label: 'Kalman Q (process noise)',
    min: 1, max: 10000, step: 50,
    unit: 'ms²',
    help: 'Per-beat IBI drift variance. Higher = more responsive, lower = smoother.',
  }),
  kalman_r_ms2: numeric({
    key: 'kalman_r_ms2',
    section: 'detector',
    label: 'Kalman R (measurement noise)',
    min: 1, max: 50000, step: 100,
    unit: 'ms²',
    help: 'Baseline measurement-noise variance; auto-bumped during artifact bursts.',
  }),
  kalman_sigma_x10: numeric({
    key: 'kalman_sigma_x10',
    section: 'detector',
    label: 'Kalman gate width',
    min: 5, max: 100, step: 1,
    scale: 0.1, unit: 'σ',
    help: 'Reject IBIs more than this many σ from the predicted value.',
  }),
  kalman_warmup_beats: numeric({
    key: 'kalman_warmup_beats',
    section: 'detector',
    label: 'Kalman warmup',
    min: 0, max: 32, step: 1,
    help: 'Beats accepted before the σ-gate activates.',
  }),
  alpha_min_x1000: numeric({
    key: 'alpha_min_x1000',
    section: 'detector',
    label: 'α floor',
    min: 1, max: 999, step: 1,
    scale: 0.001,
    help: 'Lower bound of the self-tuning Elgendi β/α offset.',
    validate: (v, c) =>
      v >= c.alpha_max_x1000 ? 'must be < α ceiling' : null,
  }),
  alpha_max_x1000: numeric({
    key: 'alpha_max_x1000',
    section: 'detector',
    label: 'α ceiling',
    min: 2, max: 1000, step: 1,
    scale: 0.001,
    help: 'Upper bound of the self-tuning Elgendi β/α offset.',
    validate: (v, c) =>
      v <= c.alpha_min_x1000 ? 'must be > α floor' : null,
  }),
  watchdog_max_consec_rejects: numeric({
    key: 'watchdog_max_consec_rejects',
    section: 'detector',
    label: 'Watchdog: consecutive rejects',
    min: 1, max: 100, step: 1,
    help: 'Reset learned state after this many rejections in a row.',
  }),
  watchdog_silence_ms: numeric({
    key: 'watchdog_silence_ms',
    section: 'detector',
    label: 'Watchdog: silence',
    min: 500, max: 60000, step: 100,
    unit: 'ms',
    help: 'Reset learned state after this long without an accepted beat.',
  }),
  refractory_ibi_pct: numeric({
    key: 'refractory_ibi_pct',
    section: 'detector',
    label: 'Refractory factor',
    min: 0, max: 100, step: 1,
    unit: '%',
    help: 'Refractory floor = max(IBI min, this% × current IBI). 0 disables — works in FIXED mode too.',
  }),

  // --- Transport & Mode ---
  ble_profile: enumField({
    key: 'ble_profile',
    section: 'transport',
    label: 'BLE profile',
    options: [
      { value: NarbisBleProfile.BATCHED,     label: 'Batched (~500 ms)' },
      { value: NarbisBleProfile.LOW_LATENCY, label: 'Low latency (per-beat)' },
    ],
  }),
  data_format: enumField({
    key: 'data_format',
    section: 'transport',
    label: 'Data format',
    options: [
      { value: NarbisDataFormat.IBI_ONLY,     label: 'IBI only' },
      { value: NarbisDataFormat.RAW_PPG,      label: 'Raw PPG' },
      { value: NarbisDataFormat.IBI_PLUS_RAW, label: 'IBI + Raw PPG' },
    ],
  }),
  ble_batch_period_ms: numeric({
    key: 'ble_batch_period_ms',
    section: 'transport',
    label: 'BLE batch period',
    min: 100, max: 2000, step: 10,
    unit: 'ms',
  }),
  battery_low_mv: numeric({
    key: 'battery_low_mv',
    section: 'transport',
    label: 'Battery low threshold',
    min: 2800, max: 4200, step: 10,
    unit: 'mV',
  }),
  light_sleep_enabled: toggle({
    key: 'light_sleep_enabled',
    section: 'transport',
    label: 'Light sleep enabled',
    help: 'Enables MCU light sleep between samples to save power.',
  }),

  // --- Diagnostics ---
  diagnostics_enabled: toggle({
    key: 'diagnostics_enabled',
    section: 'diagnostics',
    label: 'Diagnostics enabled',
    help: 'Master switch; mask below selects active streams.',
  }),
  diagnostics_mask: bitmask({
    key: 'diagnostics_mask',
    section: 'diagnostics',
    label: 'Diagnostic streams',
    bits: [
      { bit: 0, label: 'Pre-filter samples',    help: 'DC-removed PPG' },
      { bit: 1, label: 'Post-filter samples',   help: 'Bandpass output' },
      { bit: 2, label: 'Peak candidates',       help: 'Elgendi candidates pre-validator' },
      { bit: 3, label: 'AGC events',            help: 'LED current adjustments' },
      { bit: 4, label: 'FIFO occupancy',        help: 'MAX3010x FIFO depth at drain' },
      { bit: 5, label: 'Detector stats',        help: 'Adaptive detector NCC / α / Kalman snapshot per beat' },
    ],
  }),
};

export const VISIBLE_KEYS_BY_SECTION: Record<SectionId, ConfigKey[]> = (() => {
  const map: Record<SectionId, ConfigKey[]> = {
    sensorLed: [], dcAgc: [], bandpass: [], elgendi: [],
    ibi: [], sqi: [], detector: [], transport: [], diagnostics: [],
  };
  for (const key of Object.keys(FIELD_SCHEMA) as ConfigKey[]) {
    const spec = FIELD_SCHEMA[key];
    if (spec.hidden) continue;
    map[spec.section].push(key);
  }
  return map;
})();

export const ALL_FIELD_KEYS = Object.keys(FIELD_SCHEMA) as ConfigKey[];
