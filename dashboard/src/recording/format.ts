import type {
  AccPacketRecord,
  Annotation,
  BatteryRecord,
  BeatRecord,
  BleLogRecord,
  ConfigChangeEntry,
  MetricsRecord,
  PolarBeatRecordTimed,
  RawSampleRecord,
  RecordingManifest,
  ReplayEvent,
  V2AccelBatchRecord,
  V2EventRecordTimed,
  V2IbiRecordTimed,
  V2PpgBatchRecord,
  V2StatusRecord,
} from './types';
import {
  ACC_FS_G, ACC_ODR_HZ, ACCF_FIFO_OVERRUN, ACCF_FS_MASK, AGC_STATE_NAME, RATE_SPS, TIA_RF_OHMS,
  accelCountsPerG, accelPeriodUs, ibiFlagNames, ppgFlagNames, ppgPeriodUs,
} from '../ble/v2/protocol';
import { V2LinkStats } from '../ble/v2/linkStats';

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
  'acc_measured_bpm',
  'acc_resp_confidence',
  'modeb_verified_ratio',
  'modeb_state',
];

const BATTERY_HEADER = ['timestamp_ms', 'mv', 'soc_pct', 'charging', 'source'];

const ANNOTATION_HEADER = ['timestamp_ms', 'event_type', 'annotation_text', 'source'];

const H10_BEAT_HEADER = ['timestamp_ms', 'bpm', 'rr_intervals_ms'];

const ACC_HEADER = ['timestamp_ms', 'sample_rate_hz', 'x', 'y', 'z'];

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
        fmtNum(s.accMeasuredBpm, 2),
        fmtNum(s.accRespConfidence, 3),
        fmtNum(s.modeBVerifiedRatio, 3),
        s.modeBState ?? '',
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

export function writeBatteryCSV(battery: BatteryRecord[]): string {
  const lines: string[] = [BATTERY_HEADER.join(',')];
  for (const b of battery) {
    lines.push(csvRow([b.timestamp, b.mv ?? '', b.soc_pct, b.charging, b.source]));
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

/** Raw H10 accelerometer, one row per sample. Per-sample timestamps are interpolated backward from
 * each packet's `timestamp` (its newest sample) at 1000/sampleRateHz — same scheme as raw PPG. */
export function writeAccSamplesCSV(packets: AccPacketRecord[]): string {
  const lines: string[] = [ACC_HEADER.join(',')];
  for (const p of packets) {
    const period = p.sampleRateHz > 0 ? 1000 / p.sampleRateHz : 0;
    const n = p.samples.length;
    for (let i = 0; i < n; i++) {
      const ts = p.timestamp - (n - 1 - i) * period;
      const s = p.samples[i];
      lines.push(csvRow([ts, p.sampleRateHz, s.x, s.y, s.z]));
    }
  }
  return lines.join('\n') + '\n';
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

/* ------------------------------------------------------------------ */
/* V2.1 (AFE4404) full-fidelity capture                                */
/* ------------------------------------------------------------------ */

const V2_PPG_HEADER = [
  'host_ms', 'dev_us', 'seq', 'i', 'n', 'rate_sps', 'flags', 'flag_names',
  'ir', 'red', 'amb', 'led_ir_ma', 'led_red_ma', 'tia_rf_kohm',
];

const V2_ACCEL_HEADER = [
  'host_ms', 'dev_us', 'seq', 'i', 'n', 'odr_hz', 'fs_g', 'fifo_overrun',
  'x', 'y', 'z', 'x_g', 'y_g', 'z_g',
];

const V2_STATUS_HEADER = [
  'host_ms', 'uptime_s', 'sys_state', 'flags', 'batt_mv', 'batt_pct', 'rate_sps',
  'led_ir_ma', 'led_red_ma', 'tia_rf_kohm', 'tia_cf_code', 'gate_duty_pct',
  'notif_drops', 'i2c_errors', 'ibi_last_ms', 'hr_bpm', 'btn_pressed',
  'agc_state', 'agc_reacq_count',
];

const V2_IBI_HEADER = [
  'host_ms', 'dev_t_beat_us', 'seq', 'ibi_ms', 'bpm', 'confidence', 'flags', 'flag_names',
];

const V2_EVENT_HEADER = [
  'host_ms', 'arrival_ms', 'seq', 'type', 'type_name', 'dev_t_us', 'fields', 'raw_hex',
];

function hex8(v: number): string {
  return '0x' + (v & 0xff).toString(16).padStart(2, '0');
}

function rfKohm(code: number | null | undefined): number | null {
  if (code === null || code === undefined) return null;
  const ohms = TIA_RF_OHMS[code];
  return ohms !== undefined ? ohms / 1000 : null;
}

/** One row per sample, verbatim device values. `seq` is +1 per notification:
 * a jump means lost batches, a drop to 0 means acquisition restarted. */
export function writeV2PpgRawCSV(batches: V2PpgBatchRecord[]): string {
  const lines: string[] = [V2_PPG_HEADER.join(',')];
  for (const b of batches) {
    const n = b.ir.length;
    const sps = RATE_SPS[b.rateCode] ?? null;
    const periodUs = ppgPeriodUs(b.rateCode);
    const flags = hex8(b.flags);
    const names = ppgFlagNames(b.flags);
    const rf = rfKohm(b.tiaGainCode);
    for (let i = 0; i < n; i++) {
      lines.push(csvRow([
        fmtNum(b.hostFirstMs + i * b.periodMs, 3),
        Math.round(b.t0Us + i * periodUs),
        b.seq, i, n, sps, flags, names,
        b.ir[i], b.red[i], b.amb ? b.amb[i] : null,
        b.ledIrMa, b.ledRedMa, rf,
      ]));
    }
  }
  return lines.join('\n') + '\n';
}

/** One row per accelerometer sample: raw counts plus the same in g. */
export function writeV2AccelRawCSV(batches: V2AccelBatchRecord[]): string {
  const lines: string[] = [V2_ACCEL_HEADER.join(',')];
  for (const b of batches) {
    const n = b.x.length;
    const fsCode = b.flags & ACCF_FS_MASK;
    const perG = accelCountsPerG(fsCode);
    const periodUs = accelPeriodUs(b.odrCode);
    const overrun = (b.flags & ACCF_FIFO_OVERRUN) !== 0;
    for (let i = 0; i < n; i++) {
      lines.push(csvRow([
        fmtNum(b.hostFirstMs + i * b.periodMs, 3),
        Math.round(b.t0Us + i * periodUs),
        b.seq, i, n, ACC_ODR_HZ[b.odrCode] ?? null, ACC_FS_G[fsCode] ?? null, overrun,
        b.x[i], b.y[i], b.z[i],
        fmtNum(b.x[i] / perG, 4), fmtNum(b.y[i] / perG, 4), fmtNum(b.z[i] / perG, 4),
      ]));
    }
  }
  return lines.join('\n') + '\n';
}

export function writeV2StatusCSV(statuses: V2StatusRecord[]): string {
  const lines: string[] = [V2_STATUS_HEADER.join(',')];
  for (const s of statuses) {
    lines.push(csvRow([
      s.timestamp, s.uptimeS, s.sysState, hex8(s.flags), s.battMv, s.battPct,
      RATE_SPS[s.ppgRateCode] ?? null, s.ledIrMa, s.ledRedMa, rfKohm(s.tiaGainCode),
      s.tiaCfCode, fmtNum(s.gateDutyX100 / 100, 2), s.notifDropCount, s.i2cErrCount,
      s.ibiLastMs, s.hrBpm, s.btnPressed,
      AGC_STATE_NAME[s.agcState] ?? s.agcState, s.agcReacqCount,
    ]));
  }
  return lines.join('\n') + '\n';
}

export function writeV2IbiCSV(ibis: V2IbiRecordTimed[]): string {
  const lines: string[] = [V2_IBI_HEADER.join(',')];
  for (const r of ibis) {
    lines.push(csvRow([
      fmtNum(r.timestamp, 3), r.tBeatUs, r.seq, r.ibiMs,
      r.ibiMs > 0 ? fmtNum(60000 / r.ibiMs, 1) : null,
      r.confidence, hex8(r.flags), ibiFlagNames(r.flags),
    ]));
  }
  return lines.join('\n') + '\n';
}

export function writeV2EventsCSV(events: V2EventRecordTimed[]): string {
  const lines: string[] = [V2_EVENT_HEADER.join(',')];
  for (const e of events) {
    const fields = Object.entries(e.fields).map(([k, v]) => `${k}=${v}`).join(';');
    lines.push(csvRow([
      fmtNum(e.timestamp, 3), e.arrivalMs, e.seq, e.type, e.typeName, e.tUs, fields, e.rawHex,
    ]));
  }
  return lines.join('\n') + '\n';
}

/** Records that share a seq arrived in one notification — count packets. */
function packetSeqs<T extends { seq: number }>(rows: T[]): Array<{ seq: number; n: number }> {
  const out: Array<{ seq: number; n: number }> = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last.seq === r.seq) last.n += 1;
    else out.push({ seq: r.seq, n: 1 });
  }
  return out;
}

/** Link health recomputed from the recorded data itself, so the summary
 * describes exactly what is in the zip (not the live session counters). */
export function writeV2LinkStatsJSON(input: {
  fwVersion: string | null;
  batches: V2PpgBatchRecord[];
  accel?: V2AccelBatchRecord[];
  ibis: V2IbiRecordTimed[];
  statuses: V2StatusRecord[];
  events: V2EventRecordTimed[];
}): string {
  const { batches } = input;
  const stats = new V2LinkStats(batches[0]?.hostFirstMs ?? 0);
  for (const b of batches) stats.onPpg(b);
  for (const a of input.accel ?? []) stats.onAccel(a);
  for (const p of packetSeqs(input.ibis)) stats.onIbi(p.seq, p.n);
  const eventPackets = packetSeqs(input.events).length;
  for (let i = 0; i < eventPackets; i++) stats.onEvent();
  for (const s of input.statuses) stats.onStatus(s);
  const snap = stats.snapshot();
  const first = batches[0];
  const last = batches[batches.length - 1];
  const lastSampleMs = last ? last.hostFirstMs + (last.ir.length - 1) * last.periodMs : null;
  return JSON.stringify({
    firmware: input.fwVersion,
    computed_from: 'the data in this zip (v2/ppg_raw.csv, ibi.csv, status.csv, events.csv)',
    first_sample_host_ms: first ? first.hostFirstMs : null,
    last_sample_host_ms: lastSampleMs,
    duration_s: first && lastSampleMs !== null ? (lastSampleMs - first.hostFirstMs) / 1000 : 0,
    ppg_batches: snap.ppgBatches,
    ppg_samples: snap.ppgSamples,
    ppg_lost_batches: snap.ppgLostBatches,
    ppg_seq_restarts: snap.ppgSeqRestarts,
    clipped_batches: snap.clippedBatches,
    agc_settling_batches: snap.agcSettlingBatches,
    wear_off_batches: snap.wearOffBatches,
    gated_batches: snap.gatedBatches,
    nominal_sps: snap.nominalSps,
    measured_sps_device_clock: snap.measuredSps !== null ? Number(snap.measuredSps.toFixed(3)) : null,
    ibi_packets: snap.ibiPackets,
    ibi_records: snap.ibiRecords,
    ibi_lost_packets: snap.ibiLostPackets,
    accel_batches: snap.accelBatches,
    accel_samples: snap.accelSamples,
    accel_lost_batches: snap.accelLostBatches,
    accel_fifo_overrun_batches: snap.accelFifoOverruns,
    event_packets: snap.eventPackets,
    status_frames: snap.statusFrames,
    device_notif_drops_delta:
      snap.deviceDrops !== null && snap.deviceDropsStart !== null
        ? snap.deviceDrops - snap.deviceDropsStart : null,
    device_i2c_errors_delta:
      snap.i2cErrors !== null && snap.i2cErrorsStart !== null
        ? snap.i2cErrors - snap.i2cErrorsStart : null,
  }, null, 2);
}

export function writeBleLogTxt(entries: BleLogRecord[]): string {
  return entries
    .map((e) => `${new Date(e.timestamp).toISOString()} [${e.source}] ${e.level.toUpperCase()} ${e.message}`)
    .join('\n') + '\n';
}

export const V2_README = `V2.1 earclip (AFE4404) raw capture
==================================
Everything the earclip sent while recording, verbatim. All host_ms columns
share one clock anchored to the device's own microsecond clock, so PPG
samples, beats and events line up exactly (BLE jitter does not move them).

ppg_raw.csv — one row per PPG sample
  host_ms      sample time on the host clock (ms since 1970, device-anchored)
  dev_us       device clock, microseconds since boot (exact)
  seq          batch number, +1 per BLE notification. A jump = lost batches;
               a drop to 0 = the device restarted acquisition
  i, n         index within the batch, batch size
  rate_sps     sample rate of this batch
  flags        batch flags byte, decoded in flag_names:
                 GATE          artifact gate active
                 AGC_SETTLING  AGC just moved LED current / TIA gain (expect a step)
                 USB           board on USB power
                 RATE_CHANGED  first batch after a rate change
                 AMB           amb column is valid for this batch
                 WEAR_OFF      off-ear detected
                 CLIPPED       ADC hit full scale (too much light or gain)
  ir, red      raw AFE counts (signed 22-bit; ambient-subtracted on the device
               when the amb_subtract knob is on)
  amb          ambient-phase counts (blank when the batch carried none)
  led_ir_ma, led_red_ma, tia_rf_kohm
               drive state from the latest STATUS (up to 1 s stale; exact
               AGC step times are in events.csv)

accel_raw.csv — one row per accelerometer sample (LIS2DH12): raw counts
  x, y, z and the same in g (x_g, y_g, z_g), output rate odr_hz, range fs_g,
  fifo_overrun (the sensor FIFO filled before the firmware drained it).
  Use it to explain PPG artifacts: motion shows here first.

status.csv — every STATUS frame (1 Hz + on change): battery, rate, LED
  currents, TIA gain, gate duty, notif_drops (device-side BLE queue drops,
  cumulative), i2c_errors (cumulative), hr_bpm, agc_state (OFF / ACQUIRE /
  LOCKED; firmware proto 1.2+, older firmware reads OFF) and agc_reacq_count

ibi.csv — every beat from the on-device detector: device beat time, IBI,
  confidence (0..100), flags (GATED, AGC_SETTLING, INTERPOLATED,
  FIRST_AFTER_GAP). INTERPOLATED only means the peak time was refined to
  sub-sample precision, as it is on nearly every good beat; it is not an
  artifact flag

events.csv — device events: AGC_STEP (led, oldMa->newMa, oldRf->newRf codes),
  GATE, WEAR, MARKER, ERROR, RATE_CHANGE, AGC_OFFDAC; raw_hex is the payload

link_stats.json — computed from the files above: lost batches, restarts,
  clipped / AGC-settling batch counts, the sample rate implied by the device
  clock, and how far the device's drop / I2C error counters moved

../ble_log.txt — connection log: connects (with firmware version),
  disconnects, decode errors, lost-batch warnings

TIA RF codes: 0=500k 1=250k 2=100k 3=50k 4=25k 5=10k 6=1M 7=2M (not monotonic)
`;

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
  battery: 'battery.csv',
  metrics: 'metrics_1hz.csv',
  annotations: 'annotations.csv',
  configHistory: 'config_history.json',
  replay: 'replay.json',
  h10Beats: 'reference_h10/h10_beats.csv',
  h10Metrics: 'reference_h10/h10_metrics_1hz.csv',
  accSamples: 'reference_h10/acc_samples.csv',
  comparison: 'comparison.csv',
  v2PpgRaw: 'v2/ppg_raw.csv',
  v2AccelRaw: 'v2/accel_raw.csv',
  v2Status: 'v2/status.csv',
  v2Ibi: 'v2/ibi.csv',
  v2Events: 'v2/events.csv',
  v2LinkStats: 'v2/link_stats.json',
  v2Readme: 'v2/README.txt',
  bleLog: 'ble_log.txt',
  protocolJson: 'protocol/protocol.json',
  protocolBlocks: 'protocol/blocks.csv',
  protocolCues: 'protocol/cues.csv',
  protocolReadme: 'protocol/README.txt',
} as const;
