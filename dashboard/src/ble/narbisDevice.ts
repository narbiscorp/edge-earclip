import {
  NARBIS_SVC_UUID,
  NARBIS_CHR_IBI_UUID,
  NARBIS_CHR_SQI_UUID,
  NARBIS_CHR_RAW_PPG_UUID,
  NARBIS_CHR_BATTERY_UUID,
  NARBIS_CHR_CONFIG_UUID,
  NARBIS_CHR_CONFIG_WRITE_UUID,
  NARBIS_CHR_MODE_UUID,
  NARBIS_CHR_PEER_ROLE_UUID,
  NARBIS_CHR_DIAGNOSTICS_UUID,
  HEART_RATE_SERVICE,
  BATTERY_SERVICE,
  DEVICE_INFO_SERVICE,
} from './characteristics';

// Path B: dashboard announces its role via NARBIS_CHR_PEER_ROLE so the
// earclip applies the LOW_LATENCY conn-update profile to this slot.
const NARBIS_PEER_ROLE_DASHBOARD = 0x01;

// Persistence keys for Web Bluetooth pairing. device.id is opaque/origin-
// scoped; Chrome auto-matches a previously-accepted device on subsequent
// requestDevice() calls without re-prompting.
const PAIRED_DEVICE_ID_KEY = 'narbisPairedDeviceId';
const PAIRED_DEVICE_NAME_KEY = 'narbisPairedDeviceName';

export function getPairedDeviceName(): string | null {
  try {
    return localStorage.getItem(PAIRED_DEVICE_NAME_KEY);
  } catch {
    return null;
  }
}

export function forgetPairedDevice(): void {
  try {
    localStorage.removeItem(PAIRED_DEVICE_ID_KEY);
    localStorage.removeItem(PAIRED_DEVICE_NAME_KEY);
  } catch {
    /* ignore */
  }
}
import {
  parseNarbisIBI,
  parseSQI,
  parseRawPPG,
  parseNarbisBattery,
  parseBattery,
  parseConfig,
  parseDiagnostic,
  serializeConfig,
  type NarbisIbiPayload,
  type NarbisRawPpgPayload,
  type NarbisSqiPayload,
  type NarbisBatteryPayload,
  type NarbisRuntimeConfig,
  type DiagnosticSample,
} from './parsers';
import { edgeDevice } from './edgeDevice';

export type NarbisStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface NarbisBeatEvent {
  bpm: number;
  ibi_ms: number;
  confidence: number;
  flags: number;
  sqi: number | null;
  timestamp: number;
}

export interface NarbisRawSampleEvent extends NarbisRawPpgPayload {
  timestamp: number;
}

export interface NarbisSqiEvent extends NarbisSqiPayload {
  timestamp: number;
}

export interface NarbisDiagnosticEvent {
  samples: DiagnosticSample[];
  timestamp: number;
}

export interface NarbisBatteryEvent {
  soc_pct: number;
  mv?: number;
  charging?: number;
  source: 'standard' | 'narbis';
  timestamp: number;
}

export interface NarbisDisconnectedDetail {
  reason: 'user' | 'gatt' | 'error';
  error?: Error;
}

export interface NarbisErrorDetail {
  error: Error;
  phase: string;
}

const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

interface ListenerHandle {
  target: BluetoothRemoteGATTCharacteristic;
  type: string;
  listener: (ev: Event) => void;
}

export class NarbisDevice extends EventTarget {
  private device: BluetoothDevice | null = null;
  private server: BluetoothRemoteGATTServer | null = null;
  private chConfigWrite: BluetoothRemoteGATTCharacteristic | null = null;
  private chMode: BluetoothRemoteGATTCharacteristic | null = null;
  private listeners: ListenerHandle[] = [];
  private intentionalDisconnect = false;
  private _status: NarbisStatus = 'disconnected';
  private _deviceName: string | null = null;
  private lastSqi: number | null = null;

  get status(): NarbisStatus {
    return this._status;
  }

  get deviceName(): string | null {
    return this._deviceName;
  }

  async connect(): Promise<void> {
    if (this._status === 'connecting' || this._status === 'connected') return;
    if (!navigator.bluetooth) {
      throw new Error('Web Bluetooth is not available in this browser');
    }
    this.intentionalDisconnect = false;
    this.setStatus('connecting');
    try {
      // Two filters in OR: prefer service-UUID match (works on
      // Linux/Android/macOS and many Windows configs); fall back to
      // name prefix on Windows builds where the WinRT BT stack strips
      // 128-bit service UUIDs from the advertisement before Chrome
      // sees them. The earclip name is "Narbis Earclip <MAC suffix>".
      // NARBIS_SVC_UUID is moved into optionalServices so the
      // post-connect getPrimaryService() call is permitted regardless
      // of which filter actually matched.
      const device = await navigator.bluetooth.requestDevice({
        filters: [
          { services: [NARBIS_SVC_UUID] },
          { namePrefix: 'Narbis Earclip' },
        ],
        optionalServices: [
          NARBIS_SVC_UUID,
          HEART_RATE_SERVICE,
          BATTERY_SERVICE,
          DEVICE_INFO_SERVICE,
        ],
      });
      this.device = device;
      this._deviceName = device.name ?? 'Narbis Earclip';
      try {
        localStorage.setItem(PAIRED_DEVICE_ID_KEY, device.id);
        localStorage.setItem(PAIRED_DEVICE_NAME_KEY, this._deviceName);
      } catch {
        /* ignore quota / private-mode errors */
      }
      device.addEventListener('gattserverdisconnected', this.onGattDisconnected);
      // MTU 247 negotiated by browser/OS; not configurable from JS.
      await this.openSession();
      this.setStatus('connected');
      this.dispatch('connected', { name: this._deviceName });
    } catch (err) {
      this.setStatus('disconnected');
      this.cleanupConnection();
      // Multi-central earclip rejects new connects when both slots are full.
      // Web Bluetooth surfaces this as a generic GATT connect failure on
      // the second peer; rewrap so the UI can show a useful hint.
      if (err instanceof Error &&
          /failed|gatt|connection/i.test(err.message) &&
          this.device !== null) {
        throw new Error(
          'earclip is already paired with two devices — disconnect glasses or another browser tab and retry',
        );
      }
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    if (this.device?.gatt?.connected) {
      this.device.gatt.disconnect();
    } else {
      this.setStatus('disconnected');
      this.cleanupConnection();
      this.dispatch('disconnected', { reason: 'user' } as NarbisDisconnectedDetail);
      this.intentionalDisconnect = false;
    }
  }

  /** Write a runtime config to the earclip. Prefers the direct path if
   * the dashboard holds an open earclip session; otherwise falls through
   * to the glasses' relay (Path B Phase 1: 0xC3 forward). Throws only if
   * neither path is available. */
  async writeConfig(cfg: NarbisRuntimeConfig): Promise<void> {
    const blob = serializeConfig(cfg);
    if (this.chConfigWrite) {
      await this.chConfigWrite.writeValueWithResponse(toBufferSource(blob));
      return;
    }
    if (edgeDevice.isConnected) {
      await edgeDevice.forwardEarclipConfigWrite(blob);
      return;
    }
    throw new Error('not connected to earclip (direct or via glasses)');
  }

  async writeMode(profile: number, format: number): Promise<void> {
    if (!this.chMode) throw new Error('not connected');
    const buf = new Uint8Array([profile & 0xff, format & 0xff]);
    await this.chMode.writeValueWithResponse(toBufferSource(buf));
  }

  private async openSession(): Promise<void> {
    if (!this.device?.gatt) throw new Error('no GATT server');
    this.server = await this.device.gatt.connect();

    const narbisSvc = await this.server.getPrimaryService(NARBIS_SVC_UUID);

    const [chIbi, chSqi, chRaw, chBatt, chCfg, chCfgWrite, chMode] = await Promise.all([
      narbisSvc.getCharacteristic(NARBIS_CHR_IBI_UUID),
      narbisSvc.getCharacteristic(NARBIS_CHR_SQI_UUID),
      narbisSvc.getCharacteristic(NARBIS_CHR_RAW_PPG_UUID),
      narbisSvc.getCharacteristic(NARBIS_CHR_BATTERY_UUID),
      narbisSvc.getCharacteristic(NARBIS_CHR_CONFIG_UUID),
      narbisSvc.getCharacteristic(NARBIS_CHR_CONFIG_WRITE_UUID),
      narbisSvc.getCharacteristic(NARBIS_CHR_MODE_UUID),
    ]);
    this.chConfigWrite = chCfgWrite;
    this.chMode = chMode;

    // Announce role to the earclip so it applies LOW_LATENCY conn-params
    // to this slot. Pre-Path-B firmware lacks this characteristic — log
    // and continue (older earclip falls back to BATCHED, which is fine).
    try {
      const chPeerRole = await narbisSvc.getCharacteristic(NARBIS_CHR_PEER_ROLE_UUID);
      await chPeerRole.writeValueWithResponse(
        toBufferSource(new Uint8Array([NARBIS_PEER_ROLE_DASHBOARD])),
      );
    } catch (err) {
      this.emitError(err, 'peer-role-optional');
    }

    this.attach(chIbi, this.onIbiNotify);
    this.attach(chSqi, this.onSqiNotify);
    this.attach(chRaw, this.onRawNotify);
    this.attach(chBatt, this.onNarbisBatteryNotify);
    this.attach(chCfg, this.onConfigNotify);
    await Promise.all([
      chIbi.startNotifications(),
      chSqi.startNotifications(),
      chRaw.startNotifications(),
      chBatt.startNotifications(),
      chCfg.startNotifications(),
    ]);

    try {
      const chDiag = await narbisSvc.getCharacteristic(NARBIS_CHR_DIAGNOSTICS_UUID);
      this.attach(chDiag, this.onDiagnosticNotify);
      await chDiag.startNotifications();
    } catch (err) {
      this.emitError(err, 'diagnostic-svc-optional');
    }

    try {
      const cfgValue = await chCfg.readValue();
      const cfg = parseConfig(cfgValue);
      this.dispatch('configChanged', cfg);
    } catch (err) {
      this.emitError(err, 'config-read');
    }

    try {
      const battSvc = await this.server.getPrimaryService(BATTERY_SERVICE);
      const battCh = await battSvc.getCharacteristic(0x2a19);
      this.attach(battCh, this.onStandardBatteryNotify);
      await battCh.startNotifications();
      try {
        const v = await battCh.readValue();
        const { soc_pct } = parseBattery(v);
        this.dispatch('batteryReceived', {
          soc_pct,
          source: 'standard',
          timestamp: Date.now(),
        } as NarbisBatteryEvent);
      } catch (err) {
        this.emitError(err, 'battery-read');
      }
    } catch (err) {
      this.emitError(err, 'battery-svc-optional');
    }
  }

  private attach(ch: BluetoothRemoteGATTCharacteristic, listener: (ev: Event) => void): void {
    ch.addEventListener('characteristicvaluechanged', listener);
    this.listeners.push({ target: ch, type: 'characteristicvaluechanged', listener });
  }

  private onGattDisconnected = (): void => {
    if (this.intentionalDisconnect) {
      this.setStatus('disconnected');
      this.cleanupConnection();
      this.dispatch('disconnected', { reason: 'user' } as NarbisDisconnectedDetail);
      this.intentionalDisconnect = false;
      return;
    }
    this.setStatus('reconnecting');
    this.cleanupConnection({ keepDevice: true });
    this.dispatch('disconnected', { reason: 'gatt' } as NarbisDisconnectedDetail);
    void this.reconnectLoop();
  };

  private async reconnectLoop(): Promise<void> {
    let attempt = 0;
    while (!this.intentionalDisconnect && this.device) {
      const delay = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)];
      await sleep(delay);
      if (this.intentionalDisconnect || !this.device) return;
      try {
        await this.openSession();
        this.setStatus('connected');
        this.dispatch('connected', { name: this._deviceName ?? 'Narbis Earclip' });
        return;
      } catch (err) {
        this.emitError(err, `reconnect-attempt-${attempt + 1}`);
        attempt += 1;
      }
    }
  }

  private onIbiNotify = (ev: Event): void => {
    try {
      const dv = (ev.target as BluetoothRemoteGATTCharacteristic).value;
      if (!dv) return;
      const ibi: NarbisIbiPayload = parseNarbisIBI(dv);
      const detail: NarbisBeatEvent = {
        bpm: ibi.ibi_ms > 0 ? Math.round(60000 / ibi.ibi_ms) : 0,
        ibi_ms: ibi.ibi_ms,
        confidence: ibi.confidence_x100,
        flags: ibi.flags,
        sqi: this.lastSqi,
        timestamp: Date.now(),
      };
      this.dispatch('beatReceived', detail);
    } catch (err) {
      this.emitError(err, 'ibi-parse');
    }
  };

  private onSqiNotify = (ev: Event): void => {
    try {
      const dv = (ev.target as BluetoothRemoteGATTCharacteristic).value;
      if (!dv) return;
      const sqi = parseSQI(dv);
      this.lastSqi = sqi.sqi_x100;
      const detail: NarbisSqiEvent = { ...sqi, timestamp: Date.now() };
      this.dispatch('sqiReceived', detail);
    } catch (err) {
      this.emitError(err, 'sqi-parse');
    }
  };

  private onRawNotify = (ev: Event): void => {
    try {
      const dv = (ev.target as BluetoothRemoteGATTCharacteristic).value;
      if (!dv) return;
      const raw = parseRawPPG(dv);
      const detail: NarbisRawSampleEvent = { ...raw, timestamp: Date.now() };
      this.dispatch('rawSampleReceived', detail);
    } catch (err) {
      this.emitError(err, 'raw-ppg-parse');
    }
  };

  private onNarbisBatteryNotify = (ev: Event): void => {
    try {
      const dv = (ev.target as BluetoothRemoteGATTCharacteristic).value;
      if (!dv) return;
      const batt: NarbisBatteryPayload = parseNarbisBattery(dv);
      const detail: NarbisBatteryEvent = {
        soc_pct: batt.soc_pct,
        mv: batt.mv,
        charging: batt.charging,
        source: 'narbis',
        timestamp: Date.now(),
      };
      this.dispatch('batteryReceived', detail);
    } catch (err) {
      this.emitError(err, 'narbis-battery-parse');
    }
  };

  private onStandardBatteryNotify = (ev: Event): void => {
    try {
      const dv = (ev.target as BluetoothRemoteGATTCharacteristic).value;
      if (!dv) return;
      const { soc_pct } = parseBattery(dv);
      const detail: NarbisBatteryEvent = {
        soc_pct,
        source: 'standard',
        timestamp: Date.now(),
      };
      this.dispatch('batteryReceived', detail);
    } catch (err) {
      this.emitError(err, 'standard-battery-parse');
    }
  };

  private onConfigNotify = (ev: Event): void => {
    try {
      const dv = (ev.target as BluetoothRemoteGATTCharacteristic).value;
      if (!dv) return;
      const cfg = parseConfig(dv);
      this.dispatch('configChanged', cfg);
    } catch (err) {
      this.emitError(err, 'config-parse');
    }
  };

  private onDiagnosticNotify = (ev: Event): void => {
    try {
      const dv = (ev.target as BluetoothRemoteGATTCharacteristic).value;
      if (!dv) return;
      const ts = Date.now();
      const samples = parseDiagnostic(dv, ts);
      if (samples.length === 0) return;
      this.dispatch('diagnosticReceived', { samples, timestamp: ts } as NarbisDiagnosticEvent);
    } catch (err) {
      this.emitError(err, 'diagnostic-parse');
    }
  };

  private cleanupConnection(opts: { keepDevice?: boolean } = {}): void {
    for (const h of this.listeners) {
      h.target.removeEventListener(h.type, h.listener);
    }
    this.listeners = [];
    this.server = null;
    this.chConfigWrite = null;
    this.chMode = null;
    this.lastSqi = null;
    if (!opts.keepDevice) {
      if (this.device) {
        this.device.removeEventListener('gattserverdisconnected', this.onGattDisconnected);
      }
      this.device = null;
      this._deviceName = null;
    }
  }

  private setStatus(s: NarbisStatus): void {
    this._status = s;
  }

  private dispatch<T>(type: string, detail: T): void {
    this.dispatchEvent(new CustomEvent<T>(type, { detail }));
  }

  private emitError(err: unknown, phase: string): void {
    const error = err instanceof Error ? err : new Error(String(err));
    this.dispatch('error', { error, phase } as NarbisErrorDetail);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toBufferSource(buf: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(buf.byteLength);
  new Uint8Array(out).set(buf);
  return out;
}

export const narbisDevice = new NarbisDevice();
