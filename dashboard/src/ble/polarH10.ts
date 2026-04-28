import { HEART_RATE_SERVICE } from './characteristics';
import { parseHeartRateMeasurement } from './parsers';

export type PolarStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface PolarBeatEvent {
  bpm: number;
  rrIntervals_ms: number[];
  timestamp: number;
}

export interface PolarDisconnectedDetail {
  reason: 'user' | 'gatt' | 'error';
  error?: Error;
}

export interface PolarErrorDetail {
  error: Error;
  phase: string;
}

const HEART_RATE_MEASUREMENT_UUID = 0x2a37;
const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

interface ListenerHandle {
  target: BluetoothRemoteGATTCharacteristic;
  type: string;
  listener: (ev: Event) => void;
}

export class PolarH10 extends EventTarget {
  private device: BluetoothDevice | null = null;
  private server: BluetoothRemoteGATTServer | null = null;
  private listeners: ListenerHandle[] = [];
  private intentionalDisconnect = false;
  private _status: PolarStatus = 'disconnected';
  private _deviceName: string | null = null;

  get status(): PolarStatus {
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
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [HEART_RATE_SERVICE] }, { namePrefix: 'Polar' }],
        optionalServices: [HEART_RATE_SERVICE],
      });
      this.device = device;
      this._deviceName = device.name ?? 'Polar H10';
      device.addEventListener('gattserverdisconnected', this.onGattDisconnected);
      await this.openSession();
      this.setStatus('connected');
      this.dispatch('connected', { name: this._deviceName });
    } catch (err) {
      this.setStatus('disconnected');
      this.cleanupConnection();
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
      this.dispatch('disconnected', { reason: 'user' } as PolarDisconnectedDetail);
      this.intentionalDisconnect = false;
    }
  }

  private async openSession(): Promise<void> {
    if (!this.device?.gatt) throw new Error('no GATT server');
    this.server = await this.device.gatt.connect();

    const hrSvc = await this.server.getPrimaryService(HEART_RATE_SERVICE);
    const hrCh = await hrSvc.getCharacteristic(HEART_RATE_MEASUREMENT_UUID);
    hrCh.addEventListener('characteristicvaluechanged', this.onHrNotify);
    this.listeners.push({ target: hrCh, type: 'characteristicvaluechanged', listener: this.onHrNotify });
    await hrCh.startNotifications();
  }

  private onGattDisconnected = (): void => {
    if (this.intentionalDisconnect) {
      this.setStatus('disconnected');
      this.cleanupConnection();
      this.dispatch('disconnected', { reason: 'user' } as PolarDisconnectedDetail);
      this.intentionalDisconnect = false;
      return;
    }
    this.setStatus('reconnecting');
    this.cleanupConnection({ keepDevice: true });
    this.dispatch('disconnected', { reason: 'gatt' } as PolarDisconnectedDetail);
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
        this.dispatch('connected', { name: this._deviceName ?? 'Polar H10' });
        return;
      } catch (err) {
        this.emitError(err, `reconnect-attempt-${attempt + 1}`);
        attempt += 1;
      }
    }
  }

  private onHrNotify = (ev: Event): void => {
    try {
      const dv = (ev.target as BluetoothRemoteGATTCharacteristic).value;
      if (!dv) return;
      const { bpm, rrIntervals_ms } = parseHeartRateMeasurement(dv);
      const detail: PolarBeatEvent = { bpm, rrIntervals_ms, timestamp: Date.now() };
      this.dispatch('beatReceived', detail);
    } catch (err) {
      this.emitError(err, 'hr-parse');
    }
  };

  private cleanupConnection(opts: { keepDevice?: boolean } = {}): void {
    for (const h of this.listeners) {
      h.target.removeEventListener(h.type, h.listener);
    }
    this.listeners = [];
    this.server = null;
    if (!opts.keepDevice) {
      if (this.device) {
        this.device.removeEventListener('gattserverdisconnected', this.onGattDisconnected);
      }
      this.device = null;
      this._deviceName = null;
    }
  }

  private setStatus(s: PolarStatus): void {
    this._status = s;
  }

  private dispatch<T>(type: string, detail: T): void {
    this.dispatchEvent(new CustomEvent<T>(type, { detail }));
  }

  private emitError(err: unknown, phase: string): void {
    const error = err instanceof Error ? err : new Error(String(err));
    this.dispatch('error', { error, phase } as PolarErrorDetail);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const polarH10 = new PolarH10();
