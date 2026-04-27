/*
 * narbis_protocol.ts — TypeScript mirror of narbis_protocol.h.
 *
 * Wire layout, enum values, and CRC-16 implementation are byte-for-byte
 * compatible with the C code. protocol/check_sync.py verifies that every
 * struct/enum has a matching counterpart on both sides.
 *
 * Conventions:
 *   - All multi-byte ints are LITTLE-ENDIAN on the wire (matches the C side).
 *   - All struct fields use plain `number` (or `bigint` only where >32 bits).
 *   - There are no booleans on the wire — use 0/1 numbers, mirroring C uint8_t.
 */

import {
  NARBIS_SVC_UUID,
  NARBIS_CHR_IBI_UUID,
  NARBIS_CHR_SQI_UUID,
  NARBIS_CHR_RAW_PPG_UUID,
  NARBIS_CHR_BATTERY_UUID,
  NARBIS_CHR_CONFIG_UUID,
  NARBIS_CHR_CONFIG_WRITE_UUID,
  NARBIS_CHR_MODE_UUID,
  NARBIS_CHR_OTA_CONTROL_UUID,
  NARBIS_CHR_DIAGNOSTICS_UUID,
} from "./uuids";

export {
  NARBIS_SVC_UUID,
  NARBIS_CHR_IBI_UUID,
  NARBIS_CHR_SQI_UUID,
  NARBIS_CHR_RAW_PPG_UUID,
  NARBIS_CHR_BATTERY_UUID,
  NARBIS_CHR_CONFIG_UUID,
  NARBIS_CHR_CONFIG_WRITE_UUID,
  NARBIS_CHR_MODE_UUID,
  NARBIS_CHR_OTA_CONTROL_UUID,
  NARBIS_CHR_DIAGNOSTICS_UUID,
};

// =============================================================
// Protocol version
// =============================================================

export const NARBIS_PROTOCOL_VERSION = 1;

// =============================================================
// Sizes (must mirror the C macros)
// =============================================================

export const NARBIS_HEADER_SIZE = 12;
export const NARBIS_CRC_SIZE = 2;
export const NARBIS_FRAME_OVERHEAD = NARBIS_HEADER_SIZE + NARBIS_CRC_SIZE;
export const NARBIS_MAX_FRAME_SIZE = 250;
export const NARBIS_MAX_PAYLOAD_SIZE = NARBIS_MAX_FRAME_SIZE - NARBIS_FRAME_OVERHEAD;
export const NARBIS_RAW_PPG_MAX_SAMPLES = 29;

// =============================================================
// Enums (values match the C side exactly)
// =============================================================

export enum NarbisMsgType {
  IBI = 0x01,
  RAW_PPG = 0x02,
  BATTERY = 0x03,
  SQI = 0x04,
  HEARTBEAT = 0x05,
  CONFIG_ACK = 0x06,
}

export enum NarbisTransportMode {
  EDGE_ONLY = 0,
  HYBRID = 1,
}

export enum NarbisBleProfile {
  BATCHED = 0,
  LOW_LATENCY = 1,
}

export enum NarbisDataFormat {
  IBI_ONLY = 0,
  RAW_PPG = 1,
  IBI_PLUS_RAW = 2,
}

export enum NarbisConfigAckStatus {
  OK = 0,
  RANGE_ERROR = 1,
  UNKNOWN_FIELD = 2,
  REQUIRES_REBOOT = 3,
}

// Beat-event flag bitmask (mirrors NARBIS_BEAT_FLAG_*).
export const NARBIS_BEAT_FLAG_ARTIFACT = 0x01;
export const NARBIS_BEAT_FLAG_LOW_SQI = 0x02;
export const NARBIS_BEAT_FLAG_INTERPOLATED = 0x04;
export const NARBIS_BEAT_FLAG_LOW_CONFIDENCE = 0x08;

// =============================================================
// Interfaces — wire-format payloads
// (names align with check_sync.py's xxx_t ↔ Xxx alias map)
// =============================================================

export interface NarbisIbiPayload {
  ibi_ms: number;
  confidence_x100: number;
  flags: number;
}

export interface NarbisRawSample {
  red: number;
  ir: number;
}

export interface NarbisRawPpgPayload {
  sample_rate_hz: number;
  n_samples: number;
  samples: NarbisRawSample[];
}

export interface NarbisBatteryPayload {
  mv: number;
  soc_pct: number;
  charging: number;
}

export interface NarbisSqiPayload {
  sqi_x100: number;
  dc_red: number;
  dc_ir: number;
  perfusion_idx_x1000: number;
}

export interface NarbisHeartbeatPayload {
  uptime_s: number;
  free_heap: number;
  rssi_dbm: number;
  mode_byte: number;
  reserved: number;
}

export interface NarbisConfigAckPayload {
  config_version: number;
  status: number;
  field_id: number;
}

export interface NarbisHeader {
  msg_type: number;
  device_id: number;
  seq_num: number;
  timestamp_ms: number;
  payload_len: number;
  protocol_version: number;
  reserved: number;
}

export type NarbisPayload =
  | { type: NarbisMsgType.IBI; ibi: NarbisIbiPayload }
  | { type: NarbisMsgType.RAW_PPG; raw_ppg: NarbisRawPpgPayload }
  | { type: NarbisMsgType.BATTERY; battery: NarbisBatteryPayload }
  | { type: NarbisMsgType.SQI; sqi: NarbisSqiPayload }
  | { type: NarbisMsgType.HEARTBEAT; heartbeat: NarbisHeartbeatPayload }
  | { type: NarbisMsgType.CONFIG_ACK; config_ack: NarbisConfigAckPayload };

export interface NarbisPacket {
  header: NarbisHeader;
  payload: NarbisPayload;
  crc16: number;
}

// Internal-only structure mirrored for dashboard tooling that replays
// firmware logs. Never appears on the wire.
export interface BeatEvent {
  timestamp_ms: number;
  ibi_ms: number;
  prev_ibi_ms: number;
  confidence_x100: number;
  flags: number;
  peak_amplitude: number;
  sample_index: number;
}

// =============================================================
// Runtime config — must mirror narbis_runtime_config_t exactly
// =============================================================

export interface NarbisRuntimeConfig {
  config_version: number;
  sample_rate_hz: number;
  led_red_ma_x10: number;
  led_ir_ma_x10: number;
  agc_enabled: number;
  reserved_agc: number;
  agc_update_period_ms: number;
  agc_target_dc_min: number;
  agc_target_dc_max: number;
  agc_step_ma_x10: number;
  bandpass_low_hz_x100: number;
  bandpass_high_hz_x100: number;
  elgendi_w1_ms: number;
  elgendi_w2_ms: number;
  elgendi_beta_x1000: number;
  sqi_threshold_x100: number;
  ibi_min_ms: number;
  ibi_max_ms: number;
  ibi_max_delta_pct: number;
  transport_mode: number;
  ble_profile: number;
  data_format: number;
  ble_batch_period_ms: number;
  partner_mac: Uint8Array; // length 6
  espnow_channel: number;
  diagnostics_enabled: number;
  light_sleep_enabled: number;
  reserved_pwr: number;
  battery_low_mv: number;
}

// =============================================================
// CRC-16-CCITT-FALSE (poly 0x1021, init 0xFFFF, no reflect, no xor-out)
// =============================================================

export function narbisCrc16(data: Uint8Array, len?: number): number {
  const n = len ?? data.length;
  let crc = 0xffff;
  for (let i = 0; i < n; i++) {
    crc ^= data[i] << 8;
    for (let b = 0; b < 8; b++) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc & 0xffff;
}

// =============================================================
// Per-payload (de)serialization. Each fn returns the new offset.
// =============================================================

function serializeIbi(view: DataView, off: number, p: NarbisIbiPayload): number {
  view.setUint16(off, p.ibi_ms, true); off += 2;
  view.setUint8(off, p.confidence_x100); off += 1;
  view.setUint8(off, p.flags); off += 1;
  return off;
}

function deserializeIbi(view: DataView, off: number): { value: NarbisIbiPayload; offset: number } {
  const ibi_ms = view.getUint16(off, true); off += 2;
  const confidence_x100 = view.getUint8(off); off += 1;
  const flags = view.getUint8(off); off += 1;
  return { value: { ibi_ms, confidence_x100, flags }, offset: off };
}

function serializeRawPpg(view: DataView, off: number, p: NarbisRawPpgPayload): number {
  if (p.n_samples > NARBIS_RAW_PPG_MAX_SAMPLES) {
    throw new Error(`raw_ppg n_samples ${p.n_samples} exceeds max ${NARBIS_RAW_PPG_MAX_SAMPLES}`);
  }
  if (p.samples.length !== p.n_samples) {
    throw new Error(`raw_ppg n_samples ${p.n_samples} doesn't match samples.length ${p.samples.length}`);
  }
  view.setUint16(off, p.sample_rate_hz, true); off += 2;
  view.setUint16(off, p.n_samples, true); off += 2;
  for (let i = 0; i < p.n_samples; i++) {
    view.setUint32(off, p.samples[i].red, true); off += 4;
    view.setUint32(off, p.samples[i].ir, true); off += 4;
  }
  return off;
}

function deserializeRawPpg(
  view: DataView,
  off: number,
): { value: NarbisRawPpgPayload; offset: number } {
  const sample_rate_hz = view.getUint16(off, true); off += 2;
  const n_samples = view.getUint16(off, true); off += 2;
  if (n_samples > NARBIS_RAW_PPG_MAX_SAMPLES) {
    throw new Error(`raw_ppg n_samples ${n_samples} exceeds max ${NARBIS_RAW_PPG_MAX_SAMPLES}`);
  }
  const samples: NarbisRawSample[] = [];
  for (let i = 0; i < n_samples; i++) {
    const red = view.getUint32(off, true); off += 4;
    const ir = view.getUint32(off, true); off += 4;
    samples.push({ red, ir });
  }
  return { value: { sample_rate_hz, n_samples, samples }, offset: off };
}

function serializeBattery(view: DataView, off: number, p: NarbisBatteryPayload): number {
  view.setUint16(off, p.mv, true); off += 2;
  view.setUint8(off, p.soc_pct); off += 1;
  view.setUint8(off, p.charging); off += 1;
  return off;
}

function deserializeBattery(
  view: DataView,
  off: number,
): { value: NarbisBatteryPayload; offset: number } {
  const mv = view.getUint16(off, true); off += 2;
  const soc_pct = view.getUint8(off); off += 1;
  const charging = view.getUint8(off); off += 1;
  return { value: { mv, soc_pct, charging }, offset: off };
}

function serializeSqi(view: DataView, off: number, p: NarbisSqiPayload): number {
  view.setUint16(off, p.sqi_x100, true); off += 2;
  view.setUint32(off, p.dc_red, true); off += 4;
  view.setUint32(off, p.dc_ir, true); off += 4;
  view.setUint16(off, p.perfusion_idx_x1000, true); off += 2;
  return off;
}

function deserializeSqi(view: DataView, off: number): { value: NarbisSqiPayload; offset: number } {
  const sqi_x100 = view.getUint16(off, true); off += 2;
  const dc_red = view.getUint32(off, true); off += 4;
  const dc_ir = view.getUint32(off, true); off += 4;
  const perfusion_idx_x1000 = view.getUint16(off, true); off += 2;
  return { value: { sqi_x100, dc_red, dc_ir, perfusion_idx_x1000 }, offset: off };
}

function serializeHeartbeat(view: DataView, off: number, p: NarbisHeartbeatPayload): number {
  view.setUint32(off, p.uptime_s, true); off += 4;
  view.setUint32(off, p.free_heap, true); off += 4;
  view.setInt8(off, p.rssi_dbm); off += 1;
  view.setUint8(off, p.mode_byte); off += 1;
  view.setUint16(off, p.reserved, true); off += 2;
  return off;
}

function deserializeHeartbeat(
  view: DataView,
  off: number,
): { value: NarbisHeartbeatPayload; offset: number } {
  const uptime_s = view.getUint32(off, true); off += 4;
  const free_heap = view.getUint32(off, true); off += 4;
  const rssi_dbm = view.getInt8(off); off += 1;
  const mode_byte = view.getUint8(off); off += 1;
  const reserved = view.getUint16(off, true); off += 2;
  return { value: { uptime_s, free_heap, rssi_dbm, mode_byte, reserved }, offset: off };
}

function serializeConfigAck(view: DataView, off: number, p: NarbisConfigAckPayload): number {
  view.setUint16(off, p.config_version, true); off += 2;
  view.setUint8(off, p.status); off += 1;
  view.setUint8(off, p.field_id); off += 1;
  return off;
}

function deserializeConfigAck(
  view: DataView,
  off: number,
): { value: NarbisConfigAckPayload; offset: number } {
  const config_version = view.getUint16(off, true); off += 2;
  const status = view.getUint8(off); off += 1;
  const field_id = view.getUint8(off); off += 1;
  return { value: { config_version, status, field_id }, offset: off };
}

// =============================================================
// Header (de)serialization
// =============================================================

function serializeHeader(view: DataView, off: number, h: NarbisHeader): number {
  view.setUint8(off, h.msg_type); off += 1;
  view.setUint8(off, h.device_id); off += 1;
  view.setUint16(off, h.seq_num, true); off += 2;
  view.setUint32(off, h.timestamp_ms, true); off += 4;
  view.setUint16(off, h.payload_len, true); off += 2;
  view.setUint8(off, h.protocol_version); off += 1;
  view.setUint8(off, h.reserved); off += 1;
  return off;
}

function deserializeHeader(view: DataView, off: number): { value: NarbisHeader; offset: number } {
  const msg_type = view.getUint8(off); off += 1;
  const device_id = view.getUint8(off); off += 1;
  const seq_num = view.getUint16(off, true); off += 2;
  const timestamp_ms = view.getUint32(off, true); off += 4;
  const payload_len = view.getUint16(off, true); off += 2;
  const protocol_version = view.getUint8(off); off += 1;
  const reserved = view.getUint8(off); off += 1;
  return {
    value: { msg_type, device_id, seq_num, timestamp_ms, payload_len, protocol_version, reserved },
    offset: off,
  };
}

// =============================================================
// Public packet (de)serialize
// =============================================================

export function payloadSize(pkt: NarbisPacket): number {
  switch (pkt.payload.type) {
    case NarbisMsgType.IBI:
      return 4;
    case NarbisMsgType.RAW_PPG:
      return 4 + pkt.payload.raw_ppg.n_samples * 8;
    case NarbisMsgType.BATTERY:
      return 4;
    case NarbisMsgType.SQI:
      return 12;
    case NarbisMsgType.HEARTBEAT:
      return 12;
    case NarbisMsgType.CONFIG_ACK:
      return 4;
  }
}

export function serializePacket(pkt: NarbisPacket): Uint8Array {
  const payload_len = payloadSize(pkt);
  if (payload_len > NARBIS_MAX_PAYLOAD_SIZE) {
    throw new Error(`payload_len ${payload_len} exceeds max ${NARBIS_MAX_PAYLOAD_SIZE}`);
  }
  const total = NARBIS_HEADER_SIZE + payload_len + NARBIS_CRC_SIZE;
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);

  const hdr: NarbisHeader = {
    ...pkt.header,
    payload_len,
    protocol_version: NARBIS_PROTOCOL_VERSION,
    reserved: 0,
  };
  let off = serializeHeader(view, 0, hdr);

  switch (pkt.payload.type) {
    case NarbisMsgType.IBI:
      off = serializeIbi(view, off, pkt.payload.ibi); break;
    case NarbisMsgType.RAW_PPG:
      off = serializeRawPpg(view, off, pkt.payload.raw_ppg); break;
    case NarbisMsgType.BATTERY:
      off = serializeBattery(view, off, pkt.payload.battery); break;
    case NarbisMsgType.SQI:
      off = serializeSqi(view, off, pkt.payload.sqi); break;
    case NarbisMsgType.HEARTBEAT:
      off = serializeHeartbeat(view, off, pkt.payload.heartbeat); break;
    case NarbisMsgType.CONFIG_ACK:
      off = serializeConfigAck(view, off, pkt.payload.config_ack); break;
  }

  const crc = narbisCrc16(buf, NARBIS_HEADER_SIZE + payload_len);
  view.setUint16(off, crc, true);
  return buf;
}

export function deserializePacket(buf: Uint8Array): NarbisPacket {
  if (buf.length < NARBIS_HEADER_SIZE + NARBIS_CRC_SIZE) {
    throw new Error(`buffer too small: ${buf.length}`);
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const { value: header } = deserializeHeader(view, 0);

  if (header.protocol_version !== NARBIS_PROTOCOL_VERSION) {
    throw new Error(`protocol version mismatch: got ${header.protocol_version}`);
  }
  if (header.payload_len > NARBIS_MAX_PAYLOAD_SIZE) {
    throw new Error(`payload_len ${header.payload_len} exceeds max`);
  }
  const total = NARBIS_HEADER_SIZE + header.payload_len + NARBIS_CRC_SIZE;
  if (buf.length < total) {
    throw new Error(`buffer truncated: have ${buf.length}, need ${total}`);
  }

  const expectedCrc = narbisCrc16(buf, NARBIS_HEADER_SIZE + header.payload_len);
  const gotCrc = view.getUint16(NARBIS_HEADER_SIZE + header.payload_len, true);
  if (expectedCrc !== gotCrc) {
    throw new Error(`crc mismatch: expected 0x${expectedCrc.toString(16)}, got 0x${gotCrc.toString(16)}`);
  }

  let off = NARBIS_HEADER_SIZE;
  let payload: NarbisPayload;
  switch (header.msg_type as NarbisMsgType) {
    case NarbisMsgType.IBI: {
      const r = deserializeIbi(view, off); off = r.offset;
      payload = { type: NarbisMsgType.IBI, ibi: r.value };
      break;
    }
    case NarbisMsgType.RAW_PPG: {
      const r = deserializeRawPpg(view, off); off = r.offset;
      payload = { type: NarbisMsgType.RAW_PPG, raw_ppg: r.value };
      break;
    }
    case NarbisMsgType.BATTERY: {
      const r = deserializeBattery(view, off); off = r.offset;
      payload = { type: NarbisMsgType.BATTERY, battery: r.value };
      break;
    }
    case NarbisMsgType.SQI: {
      const r = deserializeSqi(view, off); off = r.offset;
      payload = { type: NarbisMsgType.SQI, sqi: r.value };
      break;
    }
    case NarbisMsgType.HEARTBEAT: {
      const r = deserializeHeartbeat(view, off); off = r.offset;
      payload = { type: NarbisMsgType.HEARTBEAT, heartbeat: r.value };
      break;
    }
    case NarbisMsgType.CONFIG_ACK: {
      const r = deserializeConfigAck(view, off); off = r.offset;
      payload = { type: NarbisMsgType.CONFIG_ACK, config_ack: r.value };
      break;
    }
    default:
      throw new Error(`unknown msg_type 0x${header.msg_type.toString(16)}`);
  }

  if (off - NARBIS_HEADER_SIZE !== header.payload_len) {
    throw new Error(
      `payload_len ${header.payload_len} doesn't match consumed ${off - NARBIS_HEADER_SIZE}`,
    );
  }

  return { header, payload, crc16: gotCrc };
}

// =============================================================
// Config (de)serialize
// =============================================================

export const NARBIS_CONFIG_STRUCT_SIZE = 56; // sum of field sizes; verified by C-side test
export const NARBIS_CONFIG_WIRE_SIZE = NARBIS_CONFIG_STRUCT_SIZE + NARBIS_CRC_SIZE;

export function serializeConfig(cfg: NarbisRuntimeConfig): Uint8Array {
  const buf = new Uint8Array(NARBIS_CONFIG_WIRE_SIZE);
  const view = new DataView(buf.buffer);
  let o = 0;
  view.setUint16(o, cfg.config_version, true); o += 2;
  view.setUint16(o, cfg.sample_rate_hz, true); o += 2;
  view.setUint16(o, cfg.led_red_ma_x10, true); o += 2;
  view.setUint16(o, cfg.led_ir_ma_x10, true); o += 2;
  view.setUint8(o, cfg.agc_enabled); o += 1;
  view.setUint8(o, cfg.reserved_agc); o += 1;
  view.setUint16(o, cfg.agc_update_period_ms, true); o += 2;
  view.setUint32(o, cfg.agc_target_dc_min, true); o += 4;
  view.setUint32(o, cfg.agc_target_dc_max, true); o += 4;
  view.setUint16(o, cfg.agc_step_ma_x10, true); o += 2;
  view.setUint16(o, cfg.bandpass_low_hz_x100, true); o += 2;
  view.setUint16(o, cfg.bandpass_high_hz_x100, true); o += 2;
  view.setUint16(o, cfg.elgendi_w1_ms, true); o += 2;
  view.setUint16(o, cfg.elgendi_w2_ms, true); o += 2;
  view.setUint16(o, cfg.elgendi_beta_x1000, true); o += 2;
  view.setUint16(o, cfg.sqi_threshold_x100, true); o += 2;
  view.setUint16(o, cfg.ibi_min_ms, true); o += 2;
  view.setUint16(o, cfg.ibi_max_ms, true); o += 2;
  view.setUint8(o, cfg.ibi_max_delta_pct); o += 1;
  view.setUint8(o, cfg.transport_mode); o += 1;
  view.setUint8(o, cfg.ble_profile); o += 1;
  view.setUint8(o, cfg.data_format); o += 1;
  view.setUint16(o, cfg.ble_batch_period_ms, true); o += 2;
  if (cfg.partner_mac.length !== 6) {
    throw new Error(`partner_mac must be 6 bytes, got ${cfg.partner_mac.length}`);
  }
  buf.set(cfg.partner_mac, o); o += 6;
  view.setUint8(o, cfg.espnow_channel); o += 1;
  view.setUint8(o, cfg.diagnostics_enabled); o += 1;
  view.setUint8(o, cfg.light_sleep_enabled); o += 1;
  view.setUint8(o, cfg.reserved_pwr); o += 1;
  view.setUint16(o, cfg.battery_low_mv, true); o += 2;

  if (o !== NARBIS_CONFIG_STRUCT_SIZE) {
    throw new Error(`config size mismatch: wrote ${o}, expected ${NARBIS_CONFIG_STRUCT_SIZE}`);
  }
  const crc = narbisCrc16(buf, NARBIS_CONFIG_STRUCT_SIZE);
  view.setUint16(o, crc, true);
  return buf;
}

export function deserializeConfig(buf: Uint8Array): NarbisRuntimeConfig {
  if (buf.length < NARBIS_CONFIG_WIRE_SIZE) {
    throw new Error(`config buffer too small: ${buf.length}`);
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const expectedCrc = narbisCrc16(buf, NARBIS_CONFIG_STRUCT_SIZE);
  const gotCrc = view.getUint16(NARBIS_CONFIG_STRUCT_SIZE, true);
  if (expectedCrc !== gotCrc) {
    throw new Error(`config crc mismatch: expected 0x${expectedCrc.toString(16)}, got 0x${gotCrc.toString(16)}`);
  }
  let o = 0;
  const config_version = view.getUint16(o, true); o += 2;
  const sample_rate_hz = view.getUint16(o, true); o += 2;
  const led_red_ma_x10 = view.getUint16(o, true); o += 2;
  const led_ir_ma_x10 = view.getUint16(o, true); o += 2;
  const agc_enabled = view.getUint8(o); o += 1;
  const reserved_agc = view.getUint8(o); o += 1;
  const agc_update_period_ms = view.getUint16(o, true); o += 2;
  const agc_target_dc_min = view.getUint32(o, true); o += 4;
  const agc_target_dc_max = view.getUint32(o, true); o += 4;
  const agc_step_ma_x10 = view.getUint16(o, true); o += 2;
  const bandpass_low_hz_x100 = view.getUint16(o, true); o += 2;
  const bandpass_high_hz_x100 = view.getUint16(o, true); o += 2;
  const elgendi_w1_ms = view.getUint16(o, true); o += 2;
  const elgendi_w2_ms = view.getUint16(o, true); o += 2;
  const elgendi_beta_x1000 = view.getUint16(o, true); o += 2;
  const sqi_threshold_x100 = view.getUint16(o, true); o += 2;
  const ibi_min_ms = view.getUint16(o, true); o += 2;
  const ibi_max_ms = view.getUint16(o, true); o += 2;
  const ibi_max_delta_pct = view.getUint8(o); o += 1;
  const transport_mode = view.getUint8(o); o += 1;
  const ble_profile = view.getUint8(o); o += 1;
  const data_format = view.getUint8(o); o += 1;
  const ble_batch_period_ms = view.getUint16(o, true); o += 2;
  const partner_mac = buf.slice(o, o + 6); o += 6;
  const espnow_channel = view.getUint8(o); o += 1;
  const diagnostics_enabled = view.getUint8(o); o += 1;
  const light_sleep_enabled = view.getUint8(o); o += 1;
  const reserved_pwr = view.getUint8(o); o += 1;
  const battery_low_mv = view.getUint16(o, true); o += 2;

  return {
    config_version, sample_rate_hz, led_red_ma_x10, led_ir_ma_x10,
    agc_enabled, reserved_agc, agc_update_period_ms,
    agc_target_dc_min, agc_target_dc_max, agc_step_ma_x10,
    bandpass_low_hz_x100, bandpass_high_hz_x100,
    elgendi_w1_ms, elgendi_w2_ms, elgendi_beta_x1000,
    sqi_threshold_x100, ibi_min_ms, ibi_max_ms, ibi_max_delta_pct,
    transport_mode, ble_profile, data_format, ble_batch_period_ms,
    partner_mac, espnow_channel,
    diagnostics_enabled, light_sleep_enabled, reserved_pwr, battery_low_mv,
  };
}
