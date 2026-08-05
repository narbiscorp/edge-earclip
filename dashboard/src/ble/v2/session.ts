/*
 * session.ts — GATT session for the V2 earclip (AFE4404 / V2.1 hardware).
 *
 * Owns discovery, notification subscriptions and the CONTROL request/response
 * correlation for one connected V2 device. It deliberately knows nothing
 * about the dashboard's state: it takes callbacks and hands back parsed
 * frames, so narbisDevice can translate them into the same events the V1
 * earclip emits and every downstream consumer stays unchanged.
 *
 * CONTROL contract (firmware proto.h): the central writes
 * [op][tid][payload] and the device answers with a NOTIFICATION on the same
 * characteristic carrying [op|0x80][tid][status][payload]. tid 0 is reserved
 * for device-internal traffic (e.g. the LED auto-off timer's synthetic
 * request), so unsolicited tid-0 frames are dropped rather than matched.
 */
import {
  V2_SENSOR_SVC, V2_CHR_PPG, V2_CHR_ACCEL, V2_CHR_IBI, V2_CHR_EVENT,
  V2_CHR_STATUS, V2_CHR_CONTROL,
  parseV2Ppg, parseV2Ibi, parseV2Status, parseV2CtrlResponse,
  CTRL_STATUS_NAME,
  type V2PpgBatch, type V2IbiRecord, type V2Status,
} from './protocol';

const CTRL_TIMEOUT_MS = 6000;

export interface V2SessionCallbacks {
  onPpg?: (b: V2PpgBatch) => void;
  onIbi?: (records: V2IbiRecord[], seq: number) => void;
  onStatus?: (s: V2Status) => void;
  onEvent?: (raw: Uint8Array) => void;
  onError?: (err: unknown, phase: string) => void;
  onPhase?: (phase: string) => void;
}

interface Pending {
  resolve: (r: { status: number; payload: Uint8Array }) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  op: number;
}

/** Returns true if this GATT server exposes the V2 sensor service. Used by
 * narbisDevice to pick a protocol without asking the user which board it is. */
export async function detectV2(server: BluetoothRemoteGATTServer): Promise<boolean> {
  try {
    await server.getPrimaryService(V2_SENSOR_SVC);
    return true;
  } catch {
    return false;
  }
}

export class V2Session {
  private chControl: BluetoothRemoteGATTCharacteristic | null = null;
  private listeners: Array<{
    target: BluetoothRemoteGATTCharacteristic;
    listener: (ev: Event) => void;
  }> = [];
  private pending = new Map<number, Pending>();
  private nextTid = 1;

  constructor(
    private server: BluetoothRemoteGATTServer,
    private cb: V2SessionCallbacks,
  ) {}

  async open(): Promise<void> {
    this.cb.onPhase?.('v2-discovering-characteristics');
    const svc = await this.server.getPrimaryService(V2_SENSOR_SVC);

    const [chPpg, chIbi, chStatus, chCtrl] = await Promise.all([
      svc.getCharacteristic(V2_CHR_PPG),
      svc.getCharacteristic(V2_CHR_IBI),
      svc.getCharacteristic(V2_CHR_STATUS),
      svc.getCharacteristic(V2_CHR_CONTROL),
    ]);
    this.chControl = chCtrl;

    this.cb.onPhase?.('v2-subscribing');
    /* CONTROL first: responses must be correlatable before we send anything. */
    this.attach(chCtrl, this.onCtrlNotify);
    await chCtrl.startNotifications();

    this.attach(chStatus, this.onStatusNotify);
    await chStatus.startNotifications();

    this.attach(chPpg, this.onPpgNotify);
    await chPpg.startNotifications();

    this.attach(chIbi, this.onIbiNotify);
    await chIbi.startNotifications();

    /* EVENT is optional telemetry (AGC steps, gate spans, wear, markers) —
     * a firmware without it must not break the session. */
    try {
      const chEvent = await svc.getCharacteristic(V2_CHR_EVENT);
      this.attach(chEvent, this.onEventNotify);
      await chEvent.startNotifications();
    } catch (err) {
      this.cb.onError?.(err, 'v2-event-optional');
    }
    /* ACCEL is subscribed only so the firmware's subscription-gated
     * acquisition sees a consumer if we later ask for accel; we do not
     * parse it here (respiration has its own path). */
    try {
      await svc.getCharacteristic(V2_CHR_ACCEL);
    } catch {
      /* absent on some builds — harmless */
    }
  }

  close(): void {
    for (const { target, listener } of this.listeners) {
      try { target.removeEventListener('characteristicvaluechanged', listener); } catch { /* gone */ }
    }
    this.listeners = [];
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('session closed'));
    }
    this.pending.clear();
    this.chControl = null;
  }

  /** Send a CONTROL request and resolve with its correlated response.
   * `req` must be a builder output from protocol.ts; byte 1 (tid) is
   * overwritten here so callers never manage transaction ids. */
  async control(req: Uint8Array): Promise<{ status: number; payload: Uint8Array }> {
    if (!this.chControl) throw new Error('V2 CONTROL not available');
    const tid = this.allocTid();
    const frame = req.slice();
    frame[1] = tid;
    const op = frame[0];

    const result = new Promise<{ status: number; payload: Uint8Array }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(tid);
        reject(new Error(`CONTROL 0x${op.toString(16)} timed out after ${CTRL_TIMEOUT_MS} ms`));
      }, CTRL_TIMEOUT_MS);
      this.pending.set(tid, { resolve, reject, timer, op });
    });

    try {
      await this.chControl.writeValueWithResponse(
        frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer,
      );
    } catch (err) {
      const p = this.pending.get(tid);
      if (p) { clearTimeout(p.timer); this.pending.delete(tid); }
      throw err;
    }
    return result;
  }

  /** control() + throw on a non-OK device status, with the status name. */
  async controlOk(req: Uint8Array): Promise<Uint8Array> {
    const r = await this.control(req);
    if (r.status !== 0) {
      const name = CTRL_STATUS_NAME[r.status] ?? `status ${r.status}`;
      throw new Error(
        name === 'WRONG_STATE'
          ? 'WRONG_STATE — start streaming first (the PPG engine must be running)'
          : name,
      );
    }
    return r.payload;
  }

  private allocTid(): number {
    /* 1..255; tid 0 is device-internal. Skip ids still awaiting a reply so a
     * slow response can never be matched to the wrong request. */
    for (let i = 0; i < 255; i++) {
      const tid = this.nextTid;
      this.nextTid = this.nextTid >= 255 ? 1 : this.nextTid + 1;
      if (!this.pending.has(tid)) return tid;
    }
    throw new Error('no free CONTROL transaction id');
  }

  private attach(ch: BluetoothRemoteGATTCharacteristic, listener: (ev: Event) => void): void {
    ch.addEventListener('characteristicvaluechanged', listener);
    this.listeners.push({ target: ch, listener });
  }

  private valueOf(ev: Event): DataView | null {
    const v = (ev.target as BluetoothRemoteGATTCharacteristic).value;
    return v ?? null;
  }

  private onCtrlNotify = (ev: Event): void => {
    const v = this.valueOf(ev);
    if (!v) return;
    try {
      const r = parseV2CtrlResponse(v);
      const p = this.pending.get(r.tid);
      if (!p) return;   /* tid 0 / late reply after timeout — ignore */
      clearTimeout(p.timer);
      this.pending.delete(r.tid);
      p.resolve({ status: r.status, payload: r.payload });
    } catch (err) {
      this.cb.onError?.(err, 'v2-control-parse');
    }
  };

  private onPpgNotify = (ev: Event): void => {
    const v = this.valueOf(ev);
    if (!v) return;
    try { this.cb.onPpg?.(parseV2Ppg(v)); }
    catch (err) { this.cb.onError?.(err, 'v2-ppg-parse'); }
  };

  private onIbiNotify = (ev: Event): void => {
    const v = this.valueOf(ev);
    if (!v) return;
    try {
      const { records, seq } = parseV2Ibi(v);
      this.cb.onIbi?.(records, seq);
    } catch (err) { this.cb.onError?.(err, 'v2-ibi-parse'); }
  };

  private onStatusNotify = (ev: Event): void => {
    const v = this.valueOf(ev);
    if (!v) return;
    try { this.cb.onStatus?.(parseV2Status(v)); }
    catch (err) { this.cb.onError?.(err, 'v2-status-parse'); }
  };

  private onEventNotify = (ev: Event): void => {
    const v = this.valueOf(ev);
    if (!v) return;
    this.cb.onEvent?.(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  };
}
