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

/* ---- ACCEL batch flags + rates ---- */
export const ACCF_FS_MASK = 0x03;
export const ACCF_FIFO_OVERRUN = 0x04;
export const ACC_ODR_HZ: Record<number, number> = { 0: 10, 1: 25, 2: 50, 3: 100, 4: 200, 5: 400 };
/** Full-scale range in g per fs code (LIS2DH12). */
export const ACC_FS_G: Record<number, number> = { 0: 2, 1: 4, 2: 8, 3: 16 };

/** Counts per g. Wire samples are RIGHT-justified 12-bit HR digits (the
 * firmware FIFO drain shifts >>4), so this is the datasheet digits/g. */
export function accelCountsPerG(fsCode: number): number {
  return [1000, 500, 250, 1000 / 12][fsCode & ACCF_FS_MASK];
}

/* ---- IBI record flags ---- */
export const IBIF_GATED = 0x01;
export const IBIF_AGC_SETTLING = 0x02;
/** Peak time refined to sub-sample precision. Normal — set on nearly every good beat; NOT an artifact flag. */
export const IBIF_INTERPOLATED = 0x04;
export const IBIF_FIRST_AFTER_GAP = 0x08;
/** Proto 1.3: the interval failed the on-device plausibility check — more
 * than ibi_art_tol_pct (15 %) off BOTH the median of the last 5 accepted
 * intervals and the previous accepted one. Still sent (flagged, never
 * dropped, confidence capped); the dashboard treats it like GATED. */
export const IBIF_ARTIFACT = 0x10;
/** First protocol version whose beats can carry IBIF_ARTIFACT. */
export const PROTO_VER_ARTIFACT = 0x0103;

/* ---- EVENT batch: [u32 seq][u8 n] + n × {u8 type, u8 len, payload[len]};
 * every payload starts with the event's u64 device time (µs). ---- */
export const EVENT_HDR_SIZE = 5;
export const EV_AGC_STEP = 1;
export const EV_GATE = 2;
export const EV_WEAR = 3;
export const EV_MARKER = 4;
export const EV_ERROR = 5;
export const EV_RATE_CHANGE = 6;
export const EV_AGC_OFFDAC = 7;
export const EV_SELFTEST_DONE = 8;
export const EV_AGC_STATE = 9;     /* proto 1.2: {state, reason, reacq_count} */
const EV_NAME: Record<number, string> = {
  [EV_AGC_STEP]: 'AGC_STEP', [EV_GATE]: 'GATE', [EV_WEAR]: 'WEAR',
  [EV_MARKER]: 'MARKER', [EV_ERROR]: 'ERROR', [EV_RATE_CHANGE]: 'RATE_CHANGE',
  [EV_AGC_OFFDAC]: 'AGC_OFFDAC', [EV_SELFTEST_DONE]: 'SELFTEST_DONE',
  [EV_AGC_STATE]: 'AGC_STATE',
};
export const MARKER_SRC_BUTTON = 0;
export const MARKER_SRC_HOST = 1;

/* ---- AGC acquire -> lock (firmware nc_agc.h, proto 1.2) ---- */
export const AGC_ST_OFF = 0;       /* stream stopped, AGC disabled, or frozen */
export const AGC_ST_ACQUIRE = 1;   /* ladder adjusting toward the target band */
export const AGC_ST_LOCKED = 2;    /* no adjustments: raw signal is step-free */
export const AGC_STATE_NAME: Record<number, string> = {
  [AGC_ST_OFF]: 'OFF', [AGC_ST_ACQUIRE]: 'ACQUIRE', [AGC_ST_LOCKED]: 'LOCKED',
};
/** Why the AGC entered its current state (EV_AGC_STATE reason). 6 is the
 * firmware's MANUAL: frozen or unfrozen by the host (AGC_FREEZE). */
export const AGC_REASON_NAME: Record<number, string> = {
  0: 'stream start', 1: 'clean beats', 2: 'stable level', 3: 'sustained clipping',
  4: 'level drifted', 5: 'put on', 6: 'manual', 7: 'mode change',
};
/** First protocol version whose STATUS carries agc_state (bytes 28/29). */
export const PROTO_VER_AGC_STATE = 0x0102;

/* ---- STATUS flags byte (proto_consts.js STF_*; on the wire since 1.0) ---- */
/** The AGC is frozen by the host (AGC_FREEZE): LEDs / gain hold what was set. */
export const STF_AGC_FROZEN = 0x20;

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
  AGC_OFFDAC_EN: 0x040c,
  /* acquire -> lock (proto 1.2 firmware; older firmware answers BAD_PARAM) */
  AGC_MODE: 0x040d,            /* 0 continuous (legacy), 1 acquire then lock,
                                  2 optimize then lock (v0.3.0-31+ default)   */
  AGC_LOCK_BEATS: 0x040e,      /* consecutive clean beats that lock (6)      */
  AGC_LOCK_STABLE_MS: 0x040f,  /* in band + idle this long also locks (8000) */
  AGC_LOCK_BAND_PCT: 0x0410,   /* lock band = target ± this % of FS (38)     */
  AGC_REACQ_SAT_MS: 0x0411,    /* clipping this long re-acquires (3000)      */
  AGC_REACQ_DRIFT_MS: 0x0412,  /* out of band + no beats this long (15000)   */
  AGC_REACQ_MIN_S: 0x0413,     /* never re-acquire sooner after a lock (180;
                                  30 before v0.3.0-31)                         */
  /* optimizer (agc_mode 2, v0.3.0-31+; older firmware answers BAD_PARAM) */
  AGC_PREF_MA_IR: 0x0416,      /* preferred IR current it solves around (25) */
  AGC_PREF_MA_RED: 0x0417,     /* preferred red current (20)                 */
  AGC_DRIFT_BAND: 0x0418,      /* re-run when raw DC leaves target ± this,
                                  in counts (500000)                          */
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
  /* beat plausibility (proto 1.3; older firmware answers BAD_PARAM) */
  IBI_ART_EN: 0x060a,          /* flag implausible intervals ARTIFACT (1)    */
  IBI_ART_TOL_PCT: 0x060b,     /* ARTIFACT if > this % off BOTH the median
                                  of recent beats and the last one (15)      */
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

export interface V2AccelBatch {
  seq: number;
  /** Device time of the FIRST sample (µs since boot). */
  t0Us: number;
  odrCode: number;
  flags: number;
  x: number[];
  y: number[];
  z: number[];
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
  /** AGC_ST_* — proto 1.2; reads 0 (OFF) on older firmware, whose byte 28
   * is reserved, so gate any display on the protocol version. */
  agcState: number;
  /** Re-acquisitions since stream start (proto 1.2). */
  agcReacqCount: number;
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

/** ACCEL batch: [u32 seq][u64 t0_us][u8 odr][u8 n][u8 flags] + n × {i16 x,y,z}. */
export function parseV2Accel(buf: DataView | ArrayBuffer): V2AccelBatch {
  const d = dv(buf);
  if (d.byteLength < ACCEL_HDR_SIZE) throw new Error(`ACCEL too short: ${d.byteLength}`);
  const n = d.getUint8(13);
  if (d.byteLength !== ACCEL_HDR_SIZE + n * 6) {
    throw new Error(`ACCEL len ${d.byteLength} != ${ACCEL_HDR_SIZE + n * 6}`);
  }
  const x: number[] = new Array(n);
  const y: number[] = new Array(n);
  const z: number[] = new Array(n);
  for (let i = 0, off = ACCEL_HDR_SIZE; i < n; i++, off += 6) {
    x[i] = d.getInt16(off, true);
    y[i] = d.getInt16(off + 2, true);
    z[i] = d.getInt16(off + 4, true);
  }
  return {
    seq: d.getUint32(0, true), t0Us: u64(d, 4), odrCode: d.getUint8(12),
    flags: d.getUint8(14), x, y, z,
  };
}

/** Device-clock spacing between accel samples at this ODR code. */
export function accelPeriodUs(odrCode: number): number {
  return 1e6 / (ACC_ODR_HZ[odrCode] ?? 50);
}

/** Device-clock spacing between consecutive samples at this rate code. */
export function ppgPeriodUs(rateCode: number): number {
  return 1e6 / (RATE_SPS[rateCode] ?? 100);
}

/** Device time of sample `i` in a batch. `t0Us` is the FIRST sample's time
 * (firmware nc_ppg_batch_add stamps t0 on the first add after reset). */
export function ppgSampleUs(b: Pick<V2PpgBatch, 't0Us' | 'rateCode'>, i: number): number {
  return b.t0Us + i * ppgPeriodUs(b.rateCode);
}

/** Device time of the newest sample — the instant the v1-style raw event
 * timestamp means everywhere downstream (charts, recorder). */
export function ppgNewestUs(b: Pick<V2PpgBatch, 't0Us' | 'rateCode' | 'ir'>): number {
  return ppgSampleUs(b, Math.max(0, b.ir.length - 1));
}

function flagNames(flags: number, table: Array<[number, string]>): string {
  return table.filter(([bit]) => (flags & bit) !== 0).map(([, name]) => name).join('|');
}

/** "AGC_SETTLING|CLIPPED" style decoding of a PPG batch's flags byte. */
export function ppgFlagNames(flags: number): string {
  return flagNames(flags, [
    [PPGF_GATE, 'GATE'], [PPGF_AGC_SETTLING, 'AGC_SETTLING'],
    [PPGF_USB_PRESENT, 'USB'], [PPGF_RATE_CHANGED, 'RATE_CHANGED'],
    [PPGF_AMB, 'AMB'], [PPGF_WEAR_OFF, 'WEAR_OFF'], [PPGF_CLIPPED, 'CLIPPED'],
  ]);
}

export function ibiFlagNames(flags: number): string {
  return flagNames(flags, [
    [IBIF_GATED, 'GATED'], [IBIF_AGC_SETTLING, 'AGC_SETTLING'],
    [IBIF_INTERPOLATED, 'INTERPOLATED'], [IBIF_FIRST_AFTER_GAP, 'FIRST_AFTER_GAP'],
    [IBIF_ARTIFACT, 'ARTIFACT'],
  ]);
}

export interface V2Event {
  type: number;
  typeName: string;
  /** Device time of the event (µs since boot); null for a payload < 8 bytes. */
  tUs: number | null;
  /** Decoded type-specific fields; empty when the type/length is unknown. */
  fields: Record<string, number>;
  /** Payload bytes (after the 2-byte record header) as lowercase hex. */
  rawHex: string;
}

function hex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/* Payload length per known type, mirrored from proto_consts.js EVLEN_*. A
 * length mismatch leaves `fields` empty rather than misreading bytes. */
const EV_LEN: Record<number, number> = {
  [EV_AGC_STEP]: 13, [EV_GATE]: 10, [EV_WEAR]: 9, [EV_MARKER]: 11,
  [EV_ERROR]: 14, [EV_RATE_CHANGE]: 10, [EV_AGC_OFFDAC]: 11, [EV_SELFTEST_DONE]: 10,
  [EV_AGC_STATE]: 11,
};

function decodeEventFields(type: number, d: DataView): Record<string, number> {
  if (EV_LEN[type] !== d.byteLength) return {};
  switch (type) {
    case EV_AGC_STEP:
      return { led: d.getUint8(8), oldMa: d.getUint8(9), newMa: d.getUint8(10),
               oldRf: d.getUint8(11), newRf: d.getUint8(12) };
    case EV_GATE: return { state: d.getUint8(8), reasonMask: d.getUint8(9) };
    case EV_WEAR: return { worn: d.getUint8(8) };
    case EV_MARKER: return { source: d.getUint8(8), markerId: d.getUint16(9, true) };
    case EV_ERROR: return { code: d.getUint16(8, true), arg: d.getUint32(10, true) };
    case EV_RATE_CHANGE: return { oldCode: d.getUint8(8), newCode: d.getUint8(9) };
    case EV_AGC_OFFDAC:
      return { phase: d.getUint8(8), oldCode: d.getUint8(9), newCode: d.getUint8(10) };
    case EV_SELFTEST_DONE: return { passCount: d.getUint8(8), failCount: d.getUint8(9) };
    case EV_AGC_STATE:
      return { state: d.getUint8(8), reason: d.getUint8(9), reacqCount: d.getUint8(10) };
    default: return {};
  }
}

export function parseV2EventBatch(buf: DataView | ArrayBuffer): { seq: number; events: V2Event[] } {
  const d = dv(buf);
  if (d.byteLength < EVENT_HDR_SIZE) throw new Error(`EVENT too short: ${d.byteLength}`);
  const bytes = new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  const seq = d.getUint32(0, true);
  const n = d.getUint8(4);
  const events: V2Event[] = [];
  let off = EVENT_HDR_SIZE;
  for (let i = 0; i < n; i++) {
    if (off + 2 > bytes.length) throw new Error('EVENT truncated record header');
    const type = bytes[off];
    const len = bytes[off + 1];
    off += 2;
    if (off + len > bytes.length) throw new Error('EVENT truncated record payload');
    const pd = new DataView(d.buffer, d.byteOffset + off, len);
    events.push({
      type,
      typeName: EV_NAME[type] ?? `TYPE_${type}`,
      tUs: len >= 8 ? u64(pd, 0) : null,
      fields: decodeEventFields(type, pd),
      rawHex: hex(bytes.subarray(off, off + len)),
    });
    off += len;
  }
  if (off !== bytes.length) throw new Error(`EVENT trailing bytes after ${n} records`);
  return { seq, events };
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
    agcState: d.getUint8(28),
    agcReacqCount: d.getUint8(29),
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
