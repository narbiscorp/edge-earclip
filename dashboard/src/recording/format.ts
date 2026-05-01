import type {
  Annotation,
  BeatRecord,
  ConfigChangeEntry,
  MetricsRecord,
  PolarBeatRecordTimed,
  RawSampleRecord,
  RecordingManifest,
  ReplayEvent,
} from './types';

const RAW_HEADER = [
  'timestamp_ms',
  'sample_index',
  'red',
  'ir',
  'green',
  'dc_red',
  'dc_ir',
  'led_red_ma',
  'led_ir_ma',
  'led_green_ma',
  'saturation_flags',
];

const BEAT_HEADER = [
  'beat_timestamp_ms',
  'ibi_ms',
  'bpm',
  'sqi',
  'is_artifact',
  'rejection_reason',
  'detection_offset_ms',
  'channel_used',
];

const METRICS_HEADER = [
  'timestamp_ms',
  'window_seconds',
  'beats_in_window',
  'mean_hr_bpm',
  'sdnn_ms',
  'rmssd_ms',
  'pnn50_pct',
  'vlf_power',
  'lf_power',
  'hf_power',
  'lf_hf_ratio',
  'total_power',
  'peak_freq_hz',
  'peak_power',
  'hm_coherence',
  'resonance_coherence',
  'sqi_avg',
];

const ANNOTATION_HEADER = ['timestamp_ms', 'event_type', 'annotation_text', 'source'];

const H10_BEAT_HEADER = ['timestamp_ms', 'bpm', 'rr_intervals_ms'];

const COMPARISON_HEADER = ['timestamp_ms', 'earclip_ibi_ms', 'h10_ibi_ms', 'dt_ms'];

/** RFC-4180-ish quoting: wrap in double quotes and escape internal quotes if the field
 * contains a comma, quote, CR, or LF. Numbers and booleans pass through. */
export function csvField(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  const s = String(v);
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function csvRow(fields: Array<string | number | boolean | null | undefined>): string {
  return fields.map(csvField).join(',');
}

function fmtNum(n: number | null | undefined, decimals?: number): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '';
  if (decimals === undefined) return String(n);
  return n.toFixed(decimals);
}

export function writeRawSamplesCSV(samples: RawSampleRecord[]): string {
  const lines: string[] = [RAW_HEADER.join(',')];
  for (const r of samples) {
    lines.push(
      csvRow([
        r.timestamp,
        r.sample_index,
        r.red,
        r.ir,
        '', // green — not supported by protocol v1
        r.dc_red ?? '',
        r.dc_ir ?? '',
        r.led_red_ma !== null ? fmtNum(r.led_red_ma, 1) : '',
        r.led_ir_ma !== null ? fmtNum(r.led_ir_ma, 1) : '',
        '', // led_green_ma — not supported by protocol v1
        '', // saturation_flags — not supported by protocol v1
      ]),
    );
  }
  return lines.join('\n') + '\n';
}

export function writeBeatsCSV(beats: BeatRecord[]): string {
  const lines: string[] = [BEAT_HEADER.join(',')];
  for (const b of beats) {
    lines.push(
      csvRow([
        b.timestamp,
        b.ibi_ms,
        b.bpm,
        b.sqi ?? '',
        b.is_artifact,
        b.rejection_reason,
        '', // detection_offset_ms — firmware doesn't expose peak-vs-beat lag
        b.channel_used,
      ]),
    );
  }
  return lines.join('\n') + '\n';
}

export function writeMetricsCSV(metrics: MetricsRecord[]): string {
  const lines: string[] = [METRICS_HEADER.join(',')];
  for (const m of metrics) {
    const s = m.snapshot;
    lines.push(
      csvRow([
        m.timestamp,
        m.window_seconds,
        s.beatCount,
        fmtNum(s.meanHr, 2),
        fmtNum(s.sdnn, 2),
        fmtNum(s.rmssd, 2),
        fmtNum(s.pnn50 * 100, 2),
        fmtNum(s.vlf, 4),
        fmtNum(s.lf, 4),
        fmtNum(s.hf, 4),
        fmtNum(s.lfHfRatio, 4),
        fmtNum(s.totalPower, 4),
        fmtNum(s.resonanceFreq_hz, 4),
        fmtNum(s.resonancePower, 4),
        fmtNum(s.hmCoherence, 4),
        fmtNum(s.resonanceCoherence, 4),
        m.sqi_avg !== null ? fmtNum(m.sqi_avg / 100, 4) : '',
      ]),
    );
  }
  return lines.join('\n') + '\n';
}

export function writeAnnotationsCSV(annotations: Annotation[]): string {
  const lines: string[] = [ANNOTATION_HEADER.join(',')];
  for (const a of annotations) {
    lines.push(csvRow([a.timestamp, a.eventType, a.text, a.source]));
  }
  return lines.join('\n') + '\n';
}

export function writeConfigHistoryJSON(history: ConfigChangeEntry[]): string {
  const out = history.map((e) => ({
    timestamp_ms: e.timestamp,
    config: serializeConfig(e.config),
  }));
  return JSON.stringify(out, null, 2);
}

function serializeConfig(cfg: ConfigChangeEntry['config']): Record<string, unknown> {
  return { ...cfg };
}

export function writeManifestJSON(manifest: RecordingManifest): string {
  return JSON.stringify(manifest, null, 2);
}

export function writeReplayJSON(events: ReplayEvent[]): string {
  if (events.length === 0) return '[]';
  const parts: string[] = ['['];
  for (let i = 0; i < events.length; i++) {
    parts.push((i > 0 ? ',\n' : '\n') + JSON.stringify(events[i]));
  }
  parts.push('\n]');
  return parts.join('');
}

export function writeH10BeatsCSV(beats: PolarBeatRecordTimed[]): string {
  const lines: string[] = [H10_BEAT_HEADER.join(',')];
  for (const b of beats) {
    lines.push(csvRow([b.timestamp, b.bpm, b.rr.join('|')]));
  }
  return lines.join('\n') + '\n';
}

export function writeH10MetricsCSV(metrics: MetricsRecord[]): string {
  return writeMetricsCSV(metrics);
}

export interface ComparisonRow {
  timestamp: number;
  earclip_ibi_ms: number;
  h10_ibi_ms: number | null;
  dt_ms: number | null;
}

export function writeComparisonCSV(rows: ComparisonRow[]): string {
  const lines: string[] = [COMPARISON_HEADER.join(',')];
  for (const r of rows) {
    lines.push(
      csvRow([
        r.timestamp,
        r.earclip_ibi_ms,
        r.h10_ibi_ms ?? '',
        r.dt_ms !== null ? fmtNum(r.dt_ms, 1) : '',
      ]),
    );
  }
  return lines.join('\n') + '\n';
}

export const UNSUPPORTED_COLUMN_NOTES: string[] = [
  'raw_samples.green: not supported by protocol v1 (MAX30101 green channel not exposed).',
  'raw_samples.dc_red, dc_ir: forward-filled from SQI cadence (not per-sample).',
  'raw_samples.led_*_ma: derived from active runtime config; refreshed on each config change.',
  'raw_samples.led_green_ma, saturation_flags: not supported by protocol v1.',
  'beats.detection_offset_ms: firmware does not expose peak-vs-beat lag.',
  'beats.channel_used: derived from current config (defaults to "ir").',
  'reference_h10/h10_raw_ecg.csv: skipped; HRM-only Polar driver does not stream ECG.',
];

export const FILE_NAMES = {
  manifest: 'manifest.json',
  rawSamples: 'raw_samples.csv',
  beats: 'beats.csv',
  metrics: 'metrics_1hz.csv',
  annotations: 'annotations.csv',
  configHistory: 'config_history.json',
  replay: 'replay.json',
  h10Beats: 'reference_h10/h10_beats.csv',
  h10Metrics: 'reference_h10/h10_metrics_1hz.csv',
  comparison: 'comparison.csv',
} as const;
