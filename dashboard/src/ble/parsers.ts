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

// Diagnostic stream record format. Firmware does not yet emit structured
// diagnostic records; this parser returns [] for any payload until the format
// is finalized and the firmware ships emission. When that lands, decode the
// record-type byte + per-type payload here.
export type DiagnosticSample =
  | { kind: 'filtered'; value: number; timestamp: number }
  | { kind: 'peak'; amplitude: number; rejected: boolean; timestamp: number };

export function parseDiagnostic(_dv: DataView, _baseTimestamp: number): DiagnosticSample[] {
  return [];
}
