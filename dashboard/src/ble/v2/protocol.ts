/*
 * protocol.ts — wire contract for the V2 earclip (AFE4404 / V2.1 hardware,
 * repo `narbis-earclip-fw`). This is a DIFFERENT device from the V1 earclip
 * (MAX30102) whose protocol lives in ../../../protocol/. Both are supported;
 * narbisDevice auto-detects which one it connected to.
 *
 * Source of truth is the firmware's generated tools/testapp/proto_consts.js
 * (itself generated from proto.h + knob_list.h). Keep the constants below in
 * sync with it — the layouts are asserted by parser length checks so a drift
 * surfaces as a thrown parse error, never as silently wrong data.
 */

/* ---- service + characteristics (128-bit, Web Bluetooth lowercase form) ---- */
export const V2_SENSOR_SVC = 'a5e90100-c6a0-43c0-b0d0-6e6172626973';
export const V2_CHR_PPG = 'a5e90101-c6a0-43c0-b0d0-6e6172626973';
export const V2_CHR_ACCEL = 'a5e90102-c6a0-43c0-b0d0-6e6172626973';
export const V2_CHR_IBI = 'a5e90103-c6a0-43c0-b0d0-6e6172626973';
export const V2_CHR_EVENT = 'a5e90104-c6a0-43c0-b0d0-6e6172626973';
export const V2_CHR_STATUS = 'a5e90105-c6a0-43c0-b0d0-6e6172626973';
export const V2_CHR_CONTROL = 'a5e90106-c6a0-43c0-b0d0-6e6172626973';
export const V2_CHR_PROTO_VER = 'a5e90107-c6a0-43c0-b0d0-6e6172626973';

/* ---- packet sizes ---- */
export const PPG_HDR_SIZE = 15;
export const ACCEL_HDR_SIZE = 15;
export const IBI_HDR_SIZE = 5;
export const IBI_REC_SIZE = 12;
export const STATUS_SIZE = 32;

/* ---- PPG batch flags ---- */
export const PPGF_GATE = 0x01;
export const PPGF_AGC_SETTLING = 0x02;
export const PPGF_USB_PRESENT = 0x04;
export const PPGF_RATE_CHANGED = 0x08;
export const PPGF_AMB = 0x10;
export const PPGF_WEAR_OFF = 0x20;
export const PPGF_CLIPPED = 0x40;

/* ---- IBI record flags ---- */
export const IBIF_GATED = 0x01;
export const IBIF_AGC_SETTLING = 0x02;
export const IBIF_INTERPOLATED = 0x04;

/* ---- stream mask (STREAM_START / STREAM_STOP payload) ---- */
export const STREAM_PPG = 1;
export const STREAM_ACCEL = 2;
export const STREAM_IBI = 4;
export const STREAM_EVENT = 8;

/* ---- CONTROL opcodes (response = op | 0x80) ---- */
export const OP_STREAM_START = 0x01;
export const OP_STREAM_STOP = 0x02;
export const OP_SET_RATE = 0x03;
export const OP_KNOB_GET = 0x10;
export const OP_KNOB_SET = 0x11;
export const OP_KNOB_SAVE = 0x12;
export const OP_KNOB_RESET = 0x13;
export const OP_TIME_SYNC = 0x20;
export const OP_MARKER = 0x30;
export const OP_AGC_FREEZE = 0x40;
export const OP_AGC_MANUAL = 0x41;
export const OP_RESP_FLAG = 0x80;

/* AGC_MANUAL apply mask */
export const AGC_APPLY_IR = 1;
export const AGC_APPLY_RED = 2;
export const AGC_APPLY_GAIN = 4;

export const CTRL_STATUS_NAME: Record<number, string> = {
  0: 'OK', 1: 'UNKNOWN_OP', 2: 'BAD_LEN', 3: 'BAD_PARAM', 4: 'OUT_OF_RANGE',
  5: 'READ_ONLY', 6: 'BUSY', 7: 'WRONG_STATE', 8: 'NVS_ERR', 9: 'CRC_ERR',
  10: 'VERSION_MISMATCH', 11: 'NEEDS_RESTART', 12: 'UNAUTHORIZED', 13: 'LOWBATT',
};

/* rate code -> sps. The AFE lights each LED only during its sampling window,
 * so this also sets optical duty (see the functest dashboard's notes). */
export const RATE_SPS: Record<number, number> = { 0: 50, 1: 100, 2: 200, 3: 250, 4: 500 };
export const SPS_RATE_CODE: Record<number, number> = { 50: 0, 100: 1, 200: 2, 250: 3, 500: 4 };

/* TIA feedback resistor per code — NOT monotonic in code order (SBAS689D). */
export const TIA_RF_OHMS: Record<number, number> = {
  0: 500_000, 1: 250_000, 2: 100_000, 3: 50_000,
  4: 25_000, 5: 10_000, 6: 1_000_000, 7: 2_000_000,
};

/* Hard ceilings enforced by firmware too (SFH 7016 DC limits). */
export const LED_IR_MAX_MA = 50;
export const LED_RED_MAX_MA = 40;

/* ---- knob ids we expose in the tuning UI ---- */
export const KNOB = {
  PPG_RATE: 0x0301,
  AMB_SUBTRACT: 0x0303,
  AGC_EN: 0x0401,
  AGC_PERIOD_MS: 0x0402,
  AGC_TARGET_PCT: 0x0403,
  AGC_DEADBAND_PCT: 0x0404,
  AGC_STEP_MA: 0x0405,
  AGC_MIN_MA_IR: 0x0406,
  AGC_MAX_MA_IR: 0x0407,
  AGC_MIN_MA_RED: 0x0408,
  AGC_MAX_MA_RED: 0x0409,
  AGC_SETTLE_MS: 0x040a,
  AGC_HOLD_MS: 0x040b,
  HP_FC_X100: 0x0501,
  BP_LO_X100: 0x0502,
  BP_HI_X100: 0x0503,
  NOTCH_EN: 0x0504,
  NOTCH_HZ: 0x0505,
  IBI_CHANNEL: 0x0601,
  SSF_WIN_MS: 0x0602,
  THR_FRAC_X100: 0x0603,
  THR_TAU_MS: 0x0604,
  REFRACT_MS: 0x0605,
  INTERP_EN: 0x0606,
  IBI_MIN_MS: 0x0607,
  IBI_MAX_MS: 0x0608,
  GATE_EN: 0x0701,
} as const;

/* ---- parsed shapes ---- */
export interface V2PpgBatch {
  seq: number;
  t0Us: number;
  rateCode: number;
  flags: number;
  ir: number[];
  red: number[];
  amb: number[] | null;
}

export interface V2IbiRecord {
  tBeatUs: number;
  ibiMs: number;
  confidence: number;
  flags: number;
}

export interface V2Status {
  sysState: number;
  flags: number;
  battMv: number;
  battPct: number;
  ppgRateCode: number;
  ledIrMa: number;
  ledRedMa: number;
  tiaGainCode: number;
  tiaCfCode: number;
  gateDutyX100: number;
  notifDropCount: number;
  i2cErrCount: number;
  uptimeS: number;
  ibiLastMs: number;
  hrBpm: number;
  btnPressed: number;
}

function dv(v: DataView | ArrayBuffer): DataView {
  return v instanceof DataView ? v : new DataView(v);
}

/* u64 little-endian as a JS number. Device clock is microseconds since boot;
 * stays exact well past any session length (2^53 us ≈ 285 years). */
function u64(d: DataView, off: number): number {
  return d.getUint32(off, true) + d.getUint32(off + 4, true) * 4294967296;
}

export function parseV2Ppg(buf: DataView | ArrayBuffer): V2PpgBatch {
  const d = dv(buf);
  if (d.byteLength < PPG_HDR_SIZE) throw new Error(`PPG too short: ${d.byteLength}`);
  const seq = d.getUint32(0, true);
  const t0Us = u64(d, 4);
  const rateCode = d.getUint8(12);
  const n = d.getUint8(13);
  const flags = d.getUint8(14);
  const hasAmb = (flags & PPGF_AMB) !== 0;
  const stride = hasAmb ? 12 : 8;
  if (d.byteLength !== PPG_HDR_SIZE + n * stride) {
    throw new Error(`PPG len ${d.byteLength} != ${PPG_HDR_SIZE + n * stride}`);
  }
  const ir: number[] = new Array(n);
  const red: number[] = new Array(n);
  const amb: number[] | null = hasAmb ? new Array(n) : null;
  for (let i = 0, off = PPG_HDR_SIZE; i < n; i++, off += stride) {
    ir[i] = d.getInt32(off, true);
    red[i] = d.getInt32(off + 4, true);
    if (amb) amb[i] = d.getInt32(off + 8, true);
  }
  return { seq, t0Us, rateCode, flags, ir, red, amb };
}

export function parseV2Ibi(buf: DataView | ArrayBuffer): { seq: number; records: V2IbiRecord[] } {
  const d = dv(buf);
  if (d.byteLength < IBI_HDR_SIZE) throw new Error(`IBI too short: ${d.byteLength}`);
  const seq = d.getUint32(0, true);
  const n = d.getUint8(4);
  if (d.byteLength !== IBI_HDR_SIZE + n * IBI_REC_SIZE) {
    throw new Error(`IBI len ${d.byteLength} != ${IBI_HDR_SIZE + n * IBI_REC_SIZE}`);
  }
  const records: V2IbiRecord[] = new Array(n);
  for (let i = 0, off = IBI_HDR_SIZE; i < n; i++, off += IBI_REC_SIZE) {
    records[i] = {
      tBeatUs: u64(d, off),
      ibiMs: d.getUint16(off + 8, true),
      confidence: d.getUint8(off + 10),
      flags: d.getUint8(off + 11),
    };
  }
  return { seq, records };
}

export function parseV2Status(buf: DataView | ArrayBuffer): V2Status {
  const d = dv(buf);
  if (d.byteLength < STATUS_SIZE) throw new Error(`STATUS too short: ${d.byteLength}`);
  return {
    sysState: d.getUint8(0),
    flags: d.getUint8(1),
    battMv: d.getUint16(2, true),
    battPct: d.getUint8(4),
    ppgRateCode: d.getUint8(5),
    ledIrMa: d.getUint8(6),
    ledRedMa: d.getUint8(7),
    tiaGainCode: d.getUint8(8),
    tiaCfCode: d.getUint8(9),
    gateDutyX100: d.getUint16(10, true),
    notifDropCount: d.getUint32(12, true),
    i2cErrCount: d.getUint16(16, true),
    uptimeS: d.getUint32(20, true),
    ibiLastMs: d.getUint16(24, true),
    hrBpm: d.getUint8(26),
    btnPressed: d.byteLength > 27 ? d.getUint8(27) : 0,
  };
}

/* ---- CONTROL envelope: request [op][tid][payload], response [op|0x80][tid][status][payload] ---- */
export interface V2CtrlResponse {
  op: number;
  tid: number;
  status: number;
  payload: Uint8Array;
}

export function parseV2CtrlResponse(buf: DataView | ArrayBuffer): V2CtrlResponse {
  const d = dv(buf);
  if (d.byteLength < 3) throw new Error(`CONTROL resp too short: ${d.byteLength}`);
  const bytes = new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  return {
    op: d.getUint8(0) & ~OP_RESP_FLAG,
    tid: d.getUint8(1),
    status: d.getUint8(2),
    payload: bytes.slice(3),
  };
}

export function buildStreamStart(mask: number): Uint8Array {
  return new Uint8Array([OP_STREAM_START, 0, mask & 0xff]);
}
export function buildStreamStop(mask: number): Uint8Array {
  return new Uint8Array([OP_STREAM_STOP, 0, mask & 0xff]);
}
export function buildSetRate(rateCode: number): Uint8Array {
  return new Uint8Array([OP_SET_RATE, 0, rateCode & 0xff]);
}
export function buildAgcFreeze(freeze: boolean): Uint8Array {
  return new Uint8Array([OP_AGC_FREEZE, 0, freeze ? 1 : 0]);
}
/** Manual LED/TIA override. Only fields named in `applyMask` are written;
 * requires the PPG engine to be running or the device answers WRONG_STATE. */
export function buildAgcManual(
  irMa: number, redMa: number, rfCode: number, applyMask: number,
): Uint8Array {
  return new Uint8Array([
    OP_AGC_MANUAL, 0,
    Math.max(0, Math.min(LED_IR_MAX_MA, irMa | 0)),
    Math.max(0, Math.min(LED_RED_MAX_MA, redMa | 0)),
    rfCode & 7,
    applyMask & 7,
  ]);
}
export function buildKnobSet(id: number, value: number): Uint8Array {
  const b = new Uint8Array(8);
  b[0] = OP_KNOB_SET; b[1] = 0;
  new DataView(b.buffer).setUint16(2, id, true);
  new DataView(b.buffer).setInt32(4, value | 0, true);
  return b;
}
export function buildKnobGet(id: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = OP_KNOB_GET; b[1] = 0;
  new DataView(b.buffer).setUint16(2, id, true);
  return b;
}
export function buildKnobSave(): Uint8Array {
  return new Uint8Array([OP_KNOB_SAVE, 0]);
}
export function buildMarker(id: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = OP_MARKER; b[1] = 0;
  new DataView(b.buffer).setUint16(2, id & 0xffff, true);
  return b;
}

/** KNOB_GET response payload: [u16 id][i32 value]. */
export function parseKnobValue(payload: Uint8Array): { id: number; value: number } {
  if (payload.length < 6) throw new Error('KNOB_GET payload too short');
  const d = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return { id: d.getUint16(0, true), value: d.getInt32(2, true) };
}
