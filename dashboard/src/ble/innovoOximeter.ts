/*
 * innovoOximeter.ts — the Innovo iP900BP-B fingertip pulse oximeter over Web Bluetooth: a reference
 * SpO2, pulse and perfusion index beside the earclip's own pulse ox (metrics/spo2.ts), as the
 * Polar H10 is the reference for beats.
 *
 * What it sends, as worked out by an independent logger (github.com/jbeale1/innovo-ip900bp-b-ble-logger;
 * no code taken from it):
 *   - once a second, 13 bytes starting 0x3E: [1] SpO2 %, [3] pulse bpm, [5] respiration /min,
 *     [11] perfusion index × 10 (%). All four 0 = no finger;
 *   - 24 times a second, 2 bytes starting 0x01: [1] the pleth waveform, 0..255.
 * It needs no pairing and no command: every notify characteristic is subscribed. It advertises as
 * "iP900BPB".
 *
 * Its service UUID is not published, and a browser only opens services it was told about up front,
 * so it is offered the ones these oximeters usually use (OXIMETER_SERVICES). A connect that finds
 * none of them says so: read the device's real one (nRF Connect, or bleak on a PC) and add it.
 *
 * Rated ±2 % over 70–100 % SpO2 (the maker's listing).
 */

/** Services offered to the browser for the oximeter. Its own is unconfirmed: add it here once read. */
export const OXIMETER_SERVICES: BluetoothServiceUUID[] = [
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART (e.g. Contec PC-60FW)
  '0000ffe0-0000-1000-8000-00805f9b34fb', // FFE0 serial bridge (HM-10 style)
  '0000fff0-0000-1000-8000-00805f9b34fb', // FFF0 vendor service
  '49535343-fe7d-4ae5-8fa9-9fafd205e455', // Microchip / ISSC transparent UART (e.g. BerryMed)
  'cdeacb80-5235-4c07-8846-93a37ee6b86d', // seen on other fingertip oximeters
  0x1822, // Bluetooth SIG Pulse Oximeter Service
];

export const OXIMETER_NAME_PREFIXES = ['iP900', 'Innovo'];

/** One second's summary. null = the oximeter shows no reading (no finger, still acquiring). */
export interface OximeterReading {
  spo2: number | null;
  pulseBpm: number | null;
  respPerMin: number | null;
  piPct: number | null;
}

export interface OximeterPackets {
  readings: OximeterReading[];
  /** Pleth waveform samples, 0..255, in arrival order. */
  pleth: number[];
  /** Bytes that matched neither packet. */
  unknownBytes: number;
}

const SUMMARY = 0x3e;
const SUMMARY_LEN = 13;
const PLETH = 0x01;
const PLETH_LEN = 2;

function orNull(v: number, max: number): number | null {
  return v > 0 && v <= max ? v : null;
}

/** Decode one notification. It normally carries a single packet; back-to-back ones are split. */
export function parseOximeterPackets(bytes: Uint8Array): OximeterPackets {
  const out: OximeterPackets = { readings: [], pleth: [], unknownBytes: 0 };
  let i = 0;
  while (i < bytes.length) {
    if (bytes[i] === SUMMARY && bytes.length - i >= SUMMARY_LEN) {
      out.readings.push({
        spo2: orNull(bytes[i + 1], 100),
        pulseBpm: orNull(bytes[i + 3], 250),
        respPerMin: orNull(bytes[i + 5], 70),
        piPct: bytes[i + 11] > 0 ? bytes[i + 11] / 10 : null,
      });
      i += SUMMARY_LEN;
    } else if (bytes[i] === PLETH && bytes.length - i >= PLETH_LEN) {
      out.pleth.push(bytes[i + 1]);
      i += PLETH_LEN;
    } else {
      out.unknownBytes++;
      i++;
    }
  }
  return out;
}

export type OximeterStatus = 'disconnected' | 'connecting' | 'reconnecting' | 'connected';

export interface OximeterStatusDetail {
  status: OximeterStatus;
  name: string | null;
  /** Why it is not connected, when that is news (a failed connect, no known service). */
  message?: string;
}

export interface OximeterReadingDetail {
  reading: OximeterReading;
  timestamp: number;
  /** The packet, lowercase hex: recordings keep it, the layout is a third party's decode. */
  hex: string;
}

export interface OximeterPlethDetail {
  values: number[];
  timestamp: number;
}

/** It turns itself off a few seconds after the finger comes out: keep trying this long. */
const RECONNECT_FOR_MS = 120_000;
const RECONNECT_EVERY_MS = 3_000;

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** Events: 'status' (OximeterStatusDetail), 'reading' (OximeterReadingDetail), 'pleth' (OximeterPlethDetail). */
class InnovoOximeter extends EventTarget {
  private _status: OximeterStatus = 'disconnected';
  private device: BluetoothDevice | null = null;
  private chars: BluetoothRemoteGATTCharacteristic[] = [];
  private wanted = false;
  private reconnectUntil = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  get status(): OximeterStatus {
    return this._status;
  }

  get deviceName(): string | null {
    return this.device?.name ?? null;
  }

  async connect(): Promise<void> {
    if (!navigator.bluetooth) throw new Error('Web Bluetooth is not available in this browser');
    this.wanted = true;
    this.setStatus('connecting');
    let device: BluetoothDevice;
    try {
      device = await navigator.bluetooth.requestDevice({
        filters: OXIMETER_NAME_PREFIXES.map((namePrefix) => ({ namePrefix })),
        optionalServices: OXIMETER_SERVICES,
      });
    } catch (err) {
      this.wanted = false;
      this.setStatus('disconnected');
      throw err;
    }
    if (this.device && this.device !== device) {
      this.device.removeEventListener('gattserverdisconnected', this.onGattDisconnected);
    }
    this.device = device;
    device.addEventListener('gattserverdisconnected', this.onGattDisconnected);
    try {
      await this.open();
    } catch (err) {
      this.wanted = false;
      this.device.gatt?.disconnect();
      this.setStatus('disconnected', (err as Error).message);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.wanted = false;
    this.clearReconnect();
    await this.unsubscribe();
    this.device?.gatt?.disconnect();
    this.setStatus('disconnected');
  }

  /** Connect GATT and subscribe to every notify / indicate characteristic of the known services. */
  private async open(): Promise<void> {
    const gatt = this.device?.gatt;
    if (!gatt) throw new Error('no GATT server on the oximeter');
    const server = await gatt.connect();
    let services: BluetoothRemoteGATTService[] = [];
    try {
      services = await server.getPrimaryServices();
    } catch {
      services = [];
    }
    const chars: BluetoothRemoteGATTCharacteristic[] = [];
    for (const svc of services) {
      let list: BluetoothRemoteGATTCharacteristic[] = [];
      try {
        list = await svc.getCharacteristics();
      } catch {
        continue;
      }
      for (const ch of list) {
        if (!ch.properties.notify && !ch.properties.indicate) continue;
        try {
          ch.addEventListener('characteristicvaluechanged', this.onNotify);
          await ch.startNotifications();
          chars.push(ch);
        } catch {
          ch.removeEventListener('characteristicvaluechanged', this.onNotify);
        }
      }
    }
    if (chars.length === 0) {
      throw new Error(
        `Connected to ${this.device?.name ?? 'the oximeter'}, but it has none of the services the ` +
          'dashboard knows (OXIMETER_SERVICES in ble/innovoOximeter.ts). Read its service UUID ' +
          '(nRF Connect, or bleak on a PC) and add it there.',
      );
    }
    this.chars = chars;
    this.clearReconnect();
    this.setStatus('connected');
  }

  private async unsubscribe(): Promise<void> {
    const chars = this.chars;
    this.chars = [];
    for (const ch of chars) {
      ch.removeEventListener('characteristicvaluechanged', this.onNotify);
      try {
        await ch.stopNotifications();
      } catch {
        /* already gone with the link */
      }
    }
  }

  private onNotify = (e: Event): void => {
    const v = (e.target as BluetoothRemoteGATTCharacteristic).value;
    if (!v) return;
    const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    const now = Date.now();
    const p = parseOximeterPackets(bytes);
    for (const reading of p.readings) {
      this.dispatchEvent(new CustomEvent<OximeterReadingDetail>('reading', {
        detail: { reading, timestamp: now, hex: hex(bytes) },
      }));
    }
    if (p.pleth.length > 0) {
      this.dispatchEvent(new CustomEvent<OximeterPlethDetail>('pleth', { detail: { values: p.pleth, timestamp: now } }));
    }
  };

  private onGattDisconnected = (): void => {
    this.chars = [];
    if (!this.wanted) {
      this.setStatus('disconnected');
      return;
    }
    if (this._status === 'connected') this.reconnectUntil = Date.now() + RECONNECT_FOR_MS;
    this.setStatus('reconnecting');
    this.scheduleReconnect();
  };

  private scheduleReconnect(): void {
    this.clearReconnect();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.wanted) return;
      if (Date.now() > this.reconnectUntil) {
        this.wanted = false;
        this.setStatus('disconnected', 'the oximeter stayed off for 2 min; connect it again');
        return;
      }
      this.open().catch(() => this.scheduleReconnect());
    }, RECONNECT_EVERY_MS);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setStatus(status: OximeterStatus, message?: string): void {
    this._status = status;
    this.dispatchEvent(new CustomEvent<OximeterStatusDetail>('status', {
      detail: { status, name: this.deviceName, message },
    }));
  }
}

export const innovoOximeter = new InnovoOximeter();
