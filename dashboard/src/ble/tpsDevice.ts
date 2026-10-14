/*
 * tpsDevice — Web Bluetooth link to a Thought Technology TPS fingertip sensor (v2, BLE).
 *
 * What this driver can and cannot do, and why:
 *   - It finds the sensor (name prefix "TPS"), connects, reads Device Information, enumerates
 *     every service/characteristic the browser lets it see, subscribes to every notifying
 *     characteristic, and keeps link statistics (notifications/s, bytes/s, gaps) plus a short
 *     raw packet log. That is the diagnostics screen.
 *   - It does NOT decode physiology. The TPS data stream is encrypted and is decoded by Thought
 *     Technology's own mobile SDK; the Narbis phone apps use that SDK. The browser cannot read the
 *     signals until TT provides a web-usable path. The training screens therefore run from a
 *     simulated source on the web until then (see tps/tpsSource.ts).
 *
 * Shape follows polarH10.ts: a singleton EventTarget, string status, CustomEvent dispatch.
 */

export type TpsLinkStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

/** TT data service / notify characteristic, as any BLE scanner shows them on the sensor. */
export const TPS_DATA_SERVICE = '0200180d-4202-eba1-ed11-5e727adcdef0';
export const TPS_DATA_CHAR = '02002b08-4202-eba1-ed11-5e727adcdef0';
/** Also advertised by some units; enumerated when present. */
export const TPS_AUX_SERVICE = '00001854-0000-1000-8000-00805f9b34fb';
export const TPS_NAME_PREFIX = 'TPS';
/** Nominal frame size used only to express byte rates as frames/s in the diagnostics. */
export const TPS_FRAME_BYTES = 7;

const OPTIONAL_SERVICES: BluetoothServiceUUID[] = [
  TPS_DATA_SERVICE,
  TPS_AUX_SERVICE,
  'device_information',
  'battery_service',
];

export interface TpsDeviceInfo {
  name: string | null;
  id: string | null;
  manufacturer: string | null;
  model: string | null;
  serial: string | null;
  firmware: string | null;
  hardware: string | null;
  software: string | null;
}

export interface TpsGattCharacteristic {
  uuid: string;
  properties: string[];
  notifying: boolean;
  notifications: number;
  bytes: number;
  lastHex: string | null;
  lastAt: number | null;
  /** First read value for readable characteristics (hex), when the read succeeded. */
  readHex: string | null;
}

export interface TpsGattService {
  uuid: string;
  characteristics: TpsGattCharacteristic[];
}

export interface TpsLinkStats {
  notifications: number;
  bytes: number;
  /** bytes / TPS_FRAME_BYTES. */
  frames: number;
  notifPerSec: number;
  bytesPerSec: number;
  framesPerSec: number;
  firstAt: number | null;
  lastAt: number | null;
  lastGapMs: number | null;
  maxGapMs: number | null;
  /** Packet sizes seen (size → count), to spot a changing MTU or a second stream. */
  sizes: Record<number, number>;
}

export interface TpsPacketDetail {
  timestamp: number;
  serviceUuid: string;
  charUuid: string;
  bytes: Uint8Array;
  hex: string;
}

export interface TpsLogDetail {
  level: 'info' | 'warn' | 'error' | 'rx' | 'tx';
  message: string;
}

export function toHex(bytes: Uint8Array, max = 64): string {
  const n = Math.min(bytes.length, max);
  let s = '';
  for (let i = 0; i < n; i++) s += bytes[i].toString(16).padStart(2, '0') + (i + 1 < n ? ' ' : '');
  return bytes.length > max ? `${s} … (+${bytes.length - max})` : s;
}

export function emptyStats(): TpsLinkStats {
  return {
    notifications: 0, bytes: 0, frames: 0, notifPerSec: 0, bytesPerSec: 0, framesPerSec: 0,
    firstAt: null, lastAt: null, lastGapMs: null, maxGapMs: null, sizes: {},
  };
}

/**
 * Pure link-rate accounting, kept out of the Bluetooth code so it can be unit tested. Rates are
 * measured over a sliding window (default 2 s) of packet arrivals.
 */
export class LinkStatsTracker {
  readonly stats: TpsLinkStats = emptyStats();
  private readonly windowMs: number;
  private readonly arrivals: Array<{ t: number; bytes: number }> = [];

  constructor(windowMs = 2000) {
    this.windowMs = windowMs;
  }

  onPacket(t: number, byteCount: number): TpsLinkStats {
    const s = this.stats;
    s.notifications += 1;
    s.bytes += byteCount;
    s.frames = Math.floor(s.bytes / TPS_FRAME_BYTES);
    s.sizes[byteCount] = (s.sizes[byteCount] ?? 0) + 1;
    if (s.firstAt === null) s.firstAt = t;
    if (s.lastAt !== null) {
      const gap = t - s.lastAt;
      s.lastGapMs = gap;
      s.maxGapMs = s.maxGapMs === null ? gap : Math.max(s.maxGapMs, gap);
    }
    s.lastAt = t;
    this.arrivals.push({ t, bytes: byteCount });
    const cutoff = t - this.windowMs;
    while (this.arrivals.length > 0 && this.arrivals[0].t < cutoff) this.arrivals.shift();
    const span = this.arrivals.length > 1 ? (t - this.arrivals[0].t) / 1000 : 0;
    if (span > 0) {
      const b = this.arrivals.reduce((acc, a) => acc + a.bytes, 0);
      s.notifPerSec = (this.arrivals.length - 1) / span;
      s.bytesPerSec = (b - this.arrivals[0].bytes) / span;
      s.framesPerSec = s.bytesPerSec / TPS_FRAME_BYTES;
    } else {
      // Only this packet inside the window: the stream paused longer than the window, so the rate is 0.
      s.notifPerSec = 0;
      s.bytesPerSec = 0;
      s.framesPerSec = 0;
    }
    return s;
  }

  reset(): void {
    Object.assign(this.stats, emptyStats());
    this.arrivals.length = 0;
  }
}

const PAIRED_KEY = 'tpsPairedDeviceName';
export function getTpsPairedDeviceName(): string | null {
  try { return localStorage.getItem(PAIRED_KEY); } catch { return null; }
}

const RAW_LOG_MAX = 60;
const RECONNECT_ATTEMPTS = 6;

function propsOf(ch: BluetoothRemoteGATTCharacteristic): string[] {
  const p = ch.properties;
  const out: string[] = [];
  if (p.read) out.push('read');
  if (p.write) out.push('write');
  if (p.writeWithoutResponse) out.push('writeNoRsp');
  if (p.notify) out.push('notify');
  if (p.indicate) out.push('indicate');
  if (p.broadcast) out.push('broadcast');
  return out;
}

async function readString(svc: BluetoothRemoteGATTService, name: BluetoothCharacteristicUUID): Promise<string | null> {
  try {
    const ch = await svc.getCharacteristic(name);
    const v = await ch.readValue();
    return new TextDecoder().decode(v.buffer).replace(/\0+$/, '');
  } catch {
    return null;
  }
}

export class TpsDevice extends EventTarget {
  private device: BluetoothDevice | null = null;
  private server: BluetoothRemoteGATTServer | null = null;
  private _status: TpsLinkStatus = 'disconnected';
  private _info: TpsDeviceInfo = TpsDevice.blankInfo();
  private _services: TpsGattService[] = [];
  private readonly tracker = new LinkStatsTracker();
  private readonly _rawLog: TpsPacketDetail[] = [];
  private listeners: Array<{ target: EventTarget; type: string; listener: EventListener }> = [];
  private intentionalDisconnect = false;
  private sessionGen = 0;

  static blankInfo(): TpsDeviceInfo {
    return { name: null, id: null, manufacturer: null, model: null, serial: null, firmware: null, hardware: null, software: null };
  }

  get status(): TpsLinkStatus { return this._status; }
  get info(): TpsDeviceInfo { return this._info; }
  get services(): TpsGattService[] { return this._services; }
  get stats(): TpsLinkStats { return this.tracker.stats; }
  get rawLog(): readonly TpsPacketDetail[] { return this._rawLog; }

  async connect(): Promise<void> {
    if (this._status === 'connecting' || this._status === 'connected') return;
    if (typeof navigator === 'undefined' || !navigator.bluetooth) {
      throw new Error('Web Bluetooth is not available in this browser (use Chrome or Edge on desktop/Android).');
    }
    const gen = ++this.sessionGen;
    this.intentionalDisconnect = false;
    this.setStatus('connecting');
    try {
      let device = this.device;
      if (!device) {
        this.log('info', 'opening device chooser (name prefix "TPS")');
        device = await navigator.bluetooth.requestDevice({
          // Windows strips 128-bit UUIDs from advertisements, so the name filter is the one that works there.
          filters: [{ namePrefix: TPS_NAME_PREFIX }, { services: [TPS_DATA_SERVICE] }],
          optionalServices: OPTIONAL_SERVICES,
        });
        this.device = device;
        device.addEventListener('gattserverdisconnected', this.onGattDisconnected);
        try { localStorage.setItem(PAIRED_KEY, device.name ?? 'TPS'); } catch { /* ignore */ }
      }
      await this.openSession(gen);
      if (gen !== this.sessionGen) return;
      this.setStatus('connected');
      this.dispatch('connected', { name: this._info.name });
    } catch (err) {
      if (gen !== this.sessionGen) return;
      this.setStatus('disconnected');
      this.cleanupConnection({ keepDevice: this.device !== null });
      this.emitError(err, 'connect');
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    this.sessionGen++;
    const dev = this.device;
    this.cleanupConnection();
    this.device = null;
    if (dev) {
      dev.removeEventListener('gattserverdisconnected', this.onGattDisconnected);
      try { dev.gatt?.disconnect(); } catch { /* already gone */ }
    }
    this.setStatus('disconnected');
    this.dispatch('disconnected', { reason: 'user' });
    this.log('info', 'disconnected by user');
  }

  private async openSession(gen: number): Promise<void> {
    const dev = this.device;
    if (!dev?.gatt) throw new Error('no GATT server');
    this.tracker.reset();
    this._rawLog.length = 0;
    this._services = [];
    this.server = await dev.gatt.connect();
    if (gen !== this.sessionGen) return;
    this._info = { ...TpsDevice.blankInfo(), name: dev.name ?? null, id: dev.id ?? null };
    this.dispatch('info', this._info);
    this.log('info', `GATT connected to ${dev.name ?? dev.id}`);

    // Device Information — firmware revision is the first thing to check in a support case.
    try {
      const dis = await this.server.getPrimaryService('device_information');
      const [manufacturer, model, serial, firmware, hardware, software] = await Promise.all([
        readString(dis, 'manufacturer_name_string'),
        readString(dis, 'model_number_string'),
        readString(dis, 'serial_number_string'),
        readString(dis, 'firmware_revision_string'),
        readString(dis, 'hardware_revision_string'),
        readString(dis, 'software_revision_string'),
      ]);
      this._info = { ...this._info, manufacturer, model, serial, firmware, hardware, software };
      this.dispatch('info', this._info);
      this.log('info', `device information: fw ${firmware ?? '?'} model ${model ?? '?'} serial ${serial ?? '?'}`);
    } catch (err) {
      this.log('warn', `device information service not readable: ${(err as Error).message}`);
    }

    // Enumerate everything the browser lets us see (only services in optionalServices are visible).
    let services: BluetoothRemoteGATTService[] = [];
    try {
      services = await this.server.getPrimaryServices();
    } catch (err) {
      this.log('warn', `getPrimaryServices failed: ${(err as Error).message}`);
    }
    for (const svc of services) {
      const entry: TpsGattService = { uuid: svc.uuid, characteristics: [] };
      let chars: BluetoothRemoteGATTCharacteristic[] = [];
      try { chars = await svc.getCharacteristics(); } catch (err) {
        this.log('warn', `getCharacteristics(${svc.uuid}) failed: ${(err as Error).message}`);
      }
      for (const ch of chars) {
        const rec: TpsGattCharacteristic = {
          uuid: ch.uuid, properties: propsOf(ch), notifying: false,
          notifications: 0, bytes: 0, lastHex: null, lastAt: null, readHex: null,
        };
        if (ch.properties.read && svc.uuid !== BluetoothUUID.getService('device_information')) {
          try {
            const v = await ch.readValue();
            rec.readHex = toHex(new Uint8Array(v.buffer));
          } catch { /* not readable right now */ }
        }
        if (ch.properties.notify || ch.properties.indicate) {
          const listener = (ev: Event): void => this.onNotify(svc.uuid, rec, ev);
          this.attach(ch, listener);
          try {
            await ch.startNotifications();
            rec.notifying = true;
            this.log('info', `notifications ON ${ch.uuid}`);
          } catch (err) {
            this.log('warn', `startNotifications(${ch.uuid}) failed: ${(err as Error).message}`);
          }
        }
        entry.characteristics.push(rec);
      }
      this._services.push(entry);
    }
    this.dispatch('gatt', this._services);
    if (!this._services.some((s) => s.uuid === TPS_DATA_SERVICE)) {
      this.log('warn', `TPS data service ${TPS_DATA_SERVICE} not found — an older sensor may not be BLE`);
    }
  }

  private onNotify(serviceUuid: string, rec: TpsGattCharacteristic, ev: Event): void {
    const target = ev.target as BluetoothRemoteGATTCharacteristic;
    const dv = target.value;
    if (!dv) return;
    const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
    const t = Date.now();
    rec.notifications += 1;
    rec.bytes += bytes.length;
    rec.lastAt = t;
    rec.lastHex = toHex(bytes, 24);
    const stats = this.tracker.onPacket(t, bytes.length);
    const detail: TpsPacketDetail = { timestamp: t, serviceUuid, charUuid: rec.uuid, bytes, hex: toHex(bytes) };
    this._rawLog.push(detail);
    if (this._rawLog.length > RAW_LOG_MAX) this._rawLog.shift();
    this.dispatch('packet', detail);
    this.dispatch('stats', stats);
  }

  private attach(ch: BluetoothRemoteGATTCharacteristic, listener: (ev: Event) => void): void {
    ch.addEventListener('characteristicvaluechanged', listener);
    this.listeners.push({ target: ch, type: 'characteristicvaluechanged', listener });
  }

  private onGattDisconnected = (): void => {
    if (this.intentionalDisconnect) return;
    this.setStatus('reconnecting');
    this.cleanupConnection({ keepDevice: true });
    this.dispatch('disconnected', { reason: 'gatt' });
    this.log('warn', 'link dropped — reconnecting');
    void this.reconnectLoop(++this.sessionGen);
  };

  private async reconnectLoop(gen: number): Promise<void> {
    for (let attempt = 0; attempt < RECONNECT_ATTEMPTS; attempt++) {
      if (gen !== this.sessionGen || this.intentionalDisconnect || !this.device) return;
      await new Promise((r) => setTimeout(r, Math.min(8000, 1000 * 2 ** attempt)));
      if (gen !== this.sessionGen || this.intentionalDisconnect || !this.device) return;
      try {
        await this.openSession(gen);
        if (gen !== this.sessionGen) return;
        this.setStatus('connected');
        this.dispatch('connected', { name: this._info.name });
        this.log('info', `reconnected (attempt ${attempt + 1})`);
        return;
      } catch (err) {
        this.emitError(err, `reconnect-attempt-${attempt + 1}`);
      }
    }
    if (gen !== this.sessionGen) return;
    this.setStatus('disconnected');
    this.cleanupConnection({ keepDevice: true });
    this.log('error', 'reconnect gave up');
  }

  private cleanupConnection(opts: { keepDevice?: boolean } = {}): void {
    for (const { target, type, listener } of this.listeners) target.removeEventListener(type, listener);
    this.listeners = [];
    try { if (this.server?.connected) this.server.disconnect(); } catch { /* ignore */ }
    this.server = null;
    if (!opts.keepDevice) this.device = null;
  }

  private setStatus(s: TpsLinkStatus): void {
    if (s === this._status) return;
    this._status = s;
    this.dispatch('status', s);
  }

  private log(level: TpsLogDetail['level'], message: string): void {
    this.dispatch('log', { level, message } as TpsLogDetail);
  }

  private emitError(err: unknown, phase: string): void {
    const message = err instanceof Error ? err.message : String(err);
    this.log('error', `${phase}: ${message}`);
    this.dispatch('error', { error: err, phase });
  }

  private dispatch<T>(type: string, detail: T): void {
    this.dispatchEvent(new CustomEvent<T>(type, { detail }));
  }
}

export const tpsDevice = new TpsDevice();
