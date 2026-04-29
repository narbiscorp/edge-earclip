import {
  deserializeConfig,
  NARBIS_RAW_PPG_MAX_SAMPLES,
  type NarbisIbiPayload,
  type NarbisRawPpgPayload,
  type NarbisRawSample,
  type NarbisBatteryPayload,
  type NarbisSqiPayload,
  type NarbisRuntimeConfig,
} from '../../../protocol/narbis_protocol';

export {
  serializeConfig,
  deserializeConfig,
  NarbisMsgType,
  NarbisTransportMode,
  NarbisBleProfile,
  NarbisDataFormat,
  NARBIS_BEAT_FLAG_ARTIFACT,
  NARBIS_BEAT_FLAG_LOW_SQI,
  NARBIS_BEAT_FLAG_INTERPOLATED,
  NARBIS_BEAT_FLAG_LOW_CONFIDENCE,
} from '../../../protocol/narbis_protocol';

export type {
  NarbisIbiPayload,
  NarbisRawPpgPayload,
  NarbisRawSample,
  NarbisBatteryPayload,
  NarbisSqiPayload,
  NarbisRuntimeConfig,
} from '../../../protocol/narbis_protocol';

export interface HeartRateMeasurement {
  bpm: number;
  rrIntervals_ms: number[];
}

const HRM_FLAG_VALUE_FORMAT_UINT16 = 0x01;
const HRM_FLAG_RR_PRESENT = 0x10;

export function parseHeartRateMeasurement(dv: DataView): HeartRateMeasurement {
  const flags = dv.getUint8(0);
  let off = 1;
  let bpm: number;
  if (flags & HRM_FLAG_VALUE_FORMAT_UINT16) {
    bpm = dv.getUint16(off, true);
    off += 2;
  } else {
    bpm = dv.getUint8(off);
    off += 1;
  }
  const rrIntervals_ms: number[] = [];
  if (flags & HRM_FLAG_RR_PRESENT) {
    while (off + 2 <= dv.byteLength) {
      const raw = dv.getUint16(off, true);
      off += 2;
      rrIntervals_ms.push(Math.round((raw * 1000) / 1024));
    }
  }
  return { bpm, rrIntervals_ms };
}

export function parseNarbisIBI(dv: DataView): NarbisIbiPayload {
  if (dv.byteLength < 4) throw new Error(`narbis IBI payload too short: ${dv.byteLength}`);
  return {
    ibi_ms: dv.getUint16(0, true),
    confidence_x100: dv.getUint8(2),
    flags: dv.getUint8(3),
  };
}

export function parseRawPPG(dv: DataView): NarbisRawPpgPayload {
  if (dv.byteLength < 4) throw new Error(`raw PPG header too short: ${dv.byteLength}`);
  const sample_rate_hz = dv.getUint16(0, true);
  const n_samples = dv.getUint16(2, true);
  if (n_samples > NARBIS_RAW_PPG_MAX_SAMPLES) {
    throw new Error(`raw PPG n_samples ${n_samples} exceeds max ${NARBIS_RAW_PPG_MAX_SAMPLES}`);
  }
  const expected = 4 + n_samples * 8;
  if (dv.byteLength < expected) {
    throw new Error(`raw PPG payload truncated: have ${dv.byteLength}, need ${expected}`);
  }
  const samples: NarbisRawSample[] = [];
  let off = 4;
  for (let i = 0; i < n_samples; i++) {
    const red = dv.getUint32(off, true); off += 4;
    const ir = dv.getUint32(off, true); off += 4;
    samples.push({ red, ir });
  }
  return { sample_rate_hz, n_samples, samples };
}

export function parseSQI(dv: DataView): NarbisSqiPayload {
  if (dv.byteLength < 12) throw new Error(`SQI payload too short: ${dv.byteLength}`);
  return {
    sqi_x100: dv.getUint16(0, true),
    dc_red: dv.getUint32(2, true),
    dc_ir: dv.getUint32(6, true),
    perfusion_idx_x1000: dv.getUint16(10, true),
  };
}

export function parseBattery(dv: DataView): { soc_pct: number } {
  if (dv.byteLength < 1) throw new Error(`battery payload too short: ${dv.byteLength}`);
  return { soc_pct: dv.getUint8(0) };
}

export function parseNarbisBattery(dv: DataView): NarbisBatteryPayload {
  if (dv.byteLength < 4) throw new Error(`narbis battery payload too short: ${dv.byteLength}`);
  return {
    mv: dv.getUint16(0, true),
    soc_pct: dv.getUint8(2),
    charging: dv.getUint8(3),
  };
}

export function parseConfig(dv: DataView): NarbisRuntimeConfig {
  return deserializeConfig(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
}

// Diagnostic stream record format (firmware/main/diagnostics.c):
//   Frame:  [seq u16][n u8] then n × record
//   Record: [stream_id u8][len u8][payload …]
//
// Stream payloads (must match narbis_protocol.h NARBIS_DIAG_STREAM_*
// and the structs pushed in firmware/main/main.c):
//   PRE_FILTER  (0x01): u32 timestamp_ms, i32 ac, u32 dc           (12 B)
//   POST_FILTER (0x02): u32 timestamp_ms, i32 filtered             ( 8 B)
//   PEAK_CAND   (0x04): u32 timestamp_ms, i32 amplitude            ( 8 B)
//   AGC_EVENT   (0x08): not yet decoded (firmware doesn't emit)
//   FIFO_OCCUP  (0x10): not yet decoded
//
// Records inside one frame share a small time window (≤ DIAG_DRAIN_PERIOD_MS
// = 100 ms). Firmware timestamps are MCU-monotonic; we anchor the latest
// record in the frame to the BLE-arrival time and back-shift earlier ones
// by their firmware-timestamp delta. This preserves intra-frame ordering
// without needing a clock-sync handshake.
export const DIAG_STREAM_PRE_FILTER  = 0x01;
export const DIAG_STREAM_POST_FILTER = 0x02;
export const DIAG_STREAM_PEAK_CAND   = 0x04;

export type DiagnosticSample =
  | { kind: 'filtered'; value: number; timestamp: number }
  | { kind: 'peak'; amplitude: number; rejected: boolean; timestamp: number };

interface RawRecord {
  fwTs: number;
  sample: DiagnosticSample;
}

export function parseDiagnostic(dv: DataView, baseTimestamp: number): DiagnosticSample[] {
  if (dv.byteLength < 3) return [];
  // [0..1]: seq u16 LE — currently unused, reserved for drop detection.
  const n = dv.getUint8(2);
  let off = 3;
  const raw: RawRecord[] = [];
  let latestFwTs = 0;

  for (let i = 0; i < n; i++) {
    if (off + 2 > dv.byteLength) break;
    const streamId = dv.getUint8(off);
    const len = dv.getUint8(off + 1);
    off += 2;
    if (off + len > dv.byteLength) break;

    if (streamId === DIAG_STREAM_POST_FILTER && len >= 8) {
      const fwTs = dv.getUint32(off, true);
      const value = dv.getInt32(off + 4, true);
      raw.push({ fwTs, sample: { kind: 'filtered', value, timestamp: 0 } });
      if (fwTs > latestFwTs) latestFwTs = fwTs;
    } else if (streamId === DIAG_STREAM_PEAK_CAND && len >= 8) {
      const fwTs = dv.getUint32(off, true);
      const amplitude = dv.getInt32(off + 4, true);
      raw.push({ fwTs, sample: { kind: 'peak', amplitude, rejected: false, timestamp: 0 } });
      if (fwTs > latestFwTs) latestFwTs = fwTs;
    }
    // PRE_FILTER and other streams parsed but not displayed yet — skip.
    off += len;
  }

  // Back-shift each record from `baseTimestamp` (latest = notification arrival)
  // by the firmware-timestamp delta, so older records sit slightly to the
  // left of the right edge of the chart.
  const out: DiagnosticSample[] = new Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    const ts = baseTimestamp - (latestFwTs - r.fwTs);
    out[i] = { ...r.sample, timestamp: ts };
  }
  return out;
}
