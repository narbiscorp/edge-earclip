import {
  NarbisBleProfile,
  NarbisDataFormat,
} from '../../ble/parsers';
import type { NarbisRuntimeConfig } from '../../ble/parsers';

export type SectionId =
  | 'sensorLed'
  | 'dcAgc'
  | 'bandpass'
  | 'elgendi'
  | 'ibi'
  | 'sqi'
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
    ],
  }),
};

export const VISIBLE_KEYS_BY_SECTION: Record<SectionId, ConfigKey[]> = (() => {
  const map: Record<SectionId, ConfigKey[]> = {
    sensorLed: [], dcAgc: [], bandpass: [], elgendi: [],
    ibi: [], sqi: [], transport: [], diagnostics: [],
  };
  for (const key of Object.keys(FIELD_SCHEMA) as ConfigKey[]) {
    const spec = FIELD_SCHEMA[key];
    if (spec.hidden) continue;
    map[spec.section].push(key);
  }
  return map;
})();

export const ALL_FIELD_KEYS = Object.keys(FIELD_SCHEMA) as ConfigKey[];
