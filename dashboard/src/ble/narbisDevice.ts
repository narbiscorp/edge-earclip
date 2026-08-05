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
import { V2Session, detectV2 } from './v2/session';
import {
  V2_SENSOR_SVC,
  STREAM_PPG, STREAM_IBI, STREAM_EVENT,
  RATE_SPS, SPS_RATE_CODE,
  AGC_APPLY_IR, AGC_APPLY_RED, AGC_APPLY_GAIN,
  buildStreamStart, buildStreamStop, buildSetRate, buildAgcFreeze,
  buildAgcManual, buildKnobSet, buildKnobGet, buildKnobSave, buildMarker,
  parseKnobValue,
  type V2Status, type V2PpgBatch, type V2IbiRecord,
} from './v2/protocol';

export type NarbisStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

/* Which earclip generation we are talking to.
 *   v1 — original MAX30102 board, protocol in ../../protocol/
 *   v2 — V2.1 AFE4404 board, protocol in ./v2/protocol.ts
 * Detected at connect time from the advertised GATT services; the user never
 * has to say which board is in their hand. Both emit the SAME dashboard
 * events (beatReceived / rawSampleReceived / batteryReceived / ...) so every
 * chart, recorder and metric downstream is generation-agnostic. */
export type NarbisProtocolVersion = 'v1' | 'v2' | null;

/** Live V2 telemetry mirrored out of STATUS notifications, for the tuning UI. */
export interface NarbisV2StatusEvent extends V2Status {
  timestamp: number;
}

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

/* Non-error progress signal. Emitted at every meaningful step so the UI
 * can show "discovering services…" instead of an opaque "connecting…"
 * during the multi-second openSession() handshake. `attempt` is set on
 * reconnect-loop events so the panel can show "reconnecting (3)…". */
export interface NarbisPhaseDetail {
  phase: string;
  attempt?: number;
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
  /* V2 (AFE4404) session — null while disconnected or when talking to a v1
   * earclip. Its presence is the single source of truth for `isV2`. */
  private v2Session: V2Session | null = null;
  private _protocol: NarbisProtocolVersion = null;
  private _v2Status: V2Status | null = null;
  /* Device clock (µs since boot) of the first PPG sample we saw, paired with
   * the host time at that moment. Lets us stamp every later sample on the
   * host timeline without accumulating BLE jitter: batches carry an exact
   * device t0, so we anchor once and add device deltas. */
  private v2ClockAnchor: { devUs: number; hostMs: number } | null = null;

  get status(): NarbisStatus {
    return this._status;
  }

  /** Which earclip generation is connected (null when disconnected). */
  get protocolVersion(): NarbisProtocolVersion {
    return this._protocol;
  }

  /** True when the connected board is the V2.1 AFE4404 earclip. Drives which
   * tuning UI the dashboard shows. */
  get isV2(): boolean {
    return this._protocol === 'v2';
  }

  /** Last STATUS frame from a V2 device (LED currents, TIA gain, rate, HR,
   * battery, counters). Null on v1 or before the first notification. */
  get v2Status(): V2Status | null {
    return this._v2Status;
  }

  /** Sample rate the V2 device is currently running, in Hz. */
  get v2SampleRate(): number {
    const code = this._v2Status?.ppgRateCode;
    return code !== undefined ? (RATE_SPS[code] ?? 100) : 100;
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
    this.emitPhase('requesting-device');
    try {
      // Two filters in OR: prefer service-UUID match (works on
      // Linux/Android/macOS and many Windows configs); fall back to
      // name prefix on Windows builds where the WinRT BT stack strips
      // 128-bit service UUIDs from the advertisement before Chrome
      // sees them. The earclip name is "Narbis Earclip <MAC suffix>".
      // NARBIS_SVC_UUID is moved into optionalServices so the
      // post-connect getPrimaryService() call is permitted regardless
      // of which filter actually matched.
      // Filters are an OR-set covering BOTH earclip generations:
      //   v1 — custom service UUID, or name "Narbis Earclip <MAC suffix>"
      //   v2 — Narbis Sensor Service, or name "Narbis Edge Earclip[ TEST]"
      // Service-UUID matching is preferred (Linux/Android/macOS and many
      // Windows configs); the name prefixes are the fallback for Windows
      // builds whose WinRT stack strips 128-bit UUIDs from the
      // advertisement before Chrome sees them. Note "Narbis Earclip" is
      // NOT a prefix of "Narbis Edge Earclip", so v2 needs its own entry.
      // Both services also go in optionalServices so the post-connect
      // getPrimaryService() probe is permitted whichever filter matched.
      const device = await navigator.bluetooth.requestDevice({
        filters: [
          { services: [NARBIS_SVC_UUID] },
          { services: [V2_SENSOR_SVC] },
          { namePrefix: 'Narbis Earclip' },
          { namePrefix: 'Narbis Edge Earclip' },
        ],
        optionalServices: [
          NARBIS_SVC_UUID,
          V2_SENSOR_SVC,
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
      this.emitPhase('ready');
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

  /** Fully forget this earclip: disconnects, releases the Web Bluetooth
   * permission grant (so the browser drops its cached device handle
   * instead of auto-matching it next time), and clears the localStorage
   * pairing keys.
   *
   * Without `device.forget()` the browser keeps the device cached for
   * ~30 s after disconnect. The next requestDevice() returns the same
   * cached entry whose GATT service descriptor may now be stale → the
   * post-connect getPrimaryService() throws NotFoundError → the
   * reconnect loop retries the same stale handle and fails the same
   * way. This is exactly the "needs multiple Forget+Connect cycles to
   * actually work" symptom users hit. Calling forget() here clears
   * the cache properly so the next pair is a clean slate.
   *
   * `device.forget()` shipped in Chrome 114 (May 2023). Older browsers
   * fall back to disconnect + localStorage clear, which is the previous
   * behaviour — strictly no worse than before. */
  async forget(): Promise<void> {
    this.intentionalDisconnect = true;
    const dev = this.device;

    if (dev?.gatt?.connected) {
      try { dev.gatt.disconnect(); } catch { /* ignore */ }
    }

    if (dev !== null) {
      // Feature-detect: BluetoothDevice.forget is in the Web Bluetooth
      // spec but not in lib.dom.d.ts ambient types yet.
      const maybeForget = (dev as unknown as { forget?: () => Promise<void> }).forget;
      if (typeof maybeForget === 'function') {
        try {
          await maybeForget.call(dev);
        } catch (err) {
          this.emitError(err, 'forget');
        }
      }
    }

    if (this.device !== null) {
      this.cleanupConnection();
    }
    this.intentionalDisconnect = false;

    forgetPairedDevice();

    this.setStatus('disconnected');
    this.dispatch('disconnected', { reason: 'user' } as NarbisDisconnectedDetail);
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

  /** Write a runtime config to a v1 earclip over the direct BLE session.
   * (The glasses relay path was removed with the rest of the on-glasses
   * support — the training dashboard talks to the earclip directly.)
   * V2 devices configure through the knob registry instead; see v2KnobSet. */
  async writeConfig(cfg: NarbisRuntimeConfig): Promise<void> {
    if (this._protocol === 'v2') {
      throw new Error('v1 config struct is not supported on a V2 earclip — use knobs');
    }
    if (!this.chConfigWrite) throw new Error('not connected to earclip');
    await this.chConfigWrite.writeValueWithResponse(toBufferSource(serializeConfig(cfg)));
  }

  async writeMode(profile: number, format: number): Promise<void> {
    if (!this.chMode) throw new Error('not connected');
    const buf = new Uint8Array([profile & 0xff, format & 0xff]);
    await this.chMode.writeValueWithResponse(toBufferSource(buf));
  }

  private async openSession(): Promise<void> {
    if (!this.device?.gatt) throw new Error('no GATT server');
    this.emitPhase('connecting-gatt');
    this.server = await this.device.gatt.connect();

    /* Generation probe. The V2.1 board publishes the Narbis Sensor Service;
     * the v1 board publishes the older custom service. Probing costs one
     * getPrimaryService round-trip and removes any "which board is this?"
     * question from the operator. */
    this.emitPhase('detecting-protocol');
    if (await detectV2(this.server)) {
      this._protocol = 'v2';
      await this.openV2Session();
      return;
    }
    this._protocol = 'v1';

    this.emitPhase('discovering-services');
    let narbisSvc: BluetoothRemoteGATTService;
    try {
      narbisSvc = await this.server.getPrimaryService(NARBIS_SVC_UUID);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotFoundError') {
        // Stale GATT cache: the device handle exists but the cached
        // service descriptor doesn't include our service. Try once more
        // after a brief delay; some browsers re-fetch on retry. If the
        // second attempt also fails, surface a clear remediation
        // message — the user needs to click Forget (which now actually
        // releases the Web Bluetooth permission) and try again.
        this.emitPhase('discovering-services-retry');
        await sleep(500);
        try {
          narbisSvc = await this.server.getPrimaryService(NARBIS_SVC_UUID);
        } catch (err2) {
          if (err2 instanceof DOMException && err2.name === 'NotFoundError') {
            throw new Error(
              'Narbis service not found on this device. ' +
              'Click Forget, then Connect Earclip again — the browser is holding a stale BLE cache.',
            );
          }
          throw err2;
        }
      } else {
        throw err;
      }
    }

    this.emitPhase('discovering-characteristics');
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

    this.emitPhase('subscribing');
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

  /* ------------------------------------------------------------------ */
  /* V2 (AFE4404) session                                                */
  /* ------------------------------------------------------------------ */

  /** Bring up a V2 earclip and translate its streams into the dashboard's
   * existing event vocabulary, so nothing downstream needs to know which
   * board generation produced the data. */
  private async openV2Session(): Promise<void> {
    if (!this.server) throw new Error('no GATT server');
    this.v2ClockAnchor = null;

    const session = new V2Session(this.server, {
      onPpg: this.onV2Ppg,
      onIbi: this.onV2Ibi,
      onStatus: this.onV2Status,
      onError: (err, phase) => this.emitError(err, phase),
      onPhase: (p) => this.emitPhase(p),
    });
    await session.open();
    this.v2Session = session;

    /* Acquisition on this firmware is subscription-gated AND has explicit
     * start/stop opcodes; subscribing alone is not enough to guarantee the
     * engine runs, so ask for it. Without this the LEDs stay dark and the
     * charts stay empty — the exact "dashboard looks dead" trap. */
    this.emitPhase('v2-starting-streams');
    try {
      await session.controlOk(buildStreamStart(STREAM_PPG | STREAM_IBI | STREAM_EVENT));
    } catch (err) {
      this.emitError(err, 'v2-stream-start');
    }
  }

  /** Map a device-clock microsecond stamp onto the host timeline. The first
   * sample anchors the two clocks; later samples are placed by device delta
   * so per-notification BLE jitter never shifts sample spacing. */
  private v2HostTime(devUs: number): number {
    if (!this.v2ClockAnchor) {
      this.v2ClockAnchor = { devUs, hostMs: Date.now() };
      return this.v2ClockAnchor.hostMs;
    }
    return this.v2ClockAnchor.hostMs + (devUs - this.v2ClockAnchor.devUs) / 1000;
  }

  private onV2Ppg = (b: V2PpgBatch): void => {
    const sps = RATE_SPS[b.rateCode] ?? 100;
    /* Re-shape into the v1 raw-PPG event so SignalChart/recording are
     * generation-agnostic. V2 counts are signed 22-bit (ambient already
     * subtracted on-device when amb_subtract is on). */
    const samples = b.ir.map((ir, i) => ({ ir, red: b.red[i] ?? 0 }));
    const detail: NarbisRawSampleEvent = {
      sample_rate_hz: sps,
      n_samples: samples.length,
      samples,
      timestamp: this.v2HostTime(b.t0Us),
    };
    this.dispatch('rawSampleReceived', detail);
  };

  private onV2Ibi = (records: V2IbiRecord[]): void => {
    for (const r of records) {
      if (r.ibiMs <= 0) continue;
      const detail: NarbisBeatEvent = {
        bpm: Math.round(60000 / r.ibiMs),
        ibi_ms: r.ibiMs,
        /* Both generations report confidence on a 0..100 scale — v1's field
         * is NAMED confidence_x100 but is parsed from a single byte, and the
         * engine's confThreshold (default 50) is on that same 0..100 scale.
         * Pass V2's through unscaled so one threshold means one thing. */
        confidence: r.confidence,
        flags: r.flags,
        sqi: this.lastSqi,
        timestamp: this.v2HostTime(r.tBeatUs),
      };
      this.dispatch('beatReceived', detail);
    }
  };

  private onV2Status = (s: V2Status): void => {
    this._v2Status = s;
    this.dispatch('v2StatusReceived', { ...s, timestamp: Date.now() } as NarbisV2StatusEvent);
    this.dispatch('batteryReceived', {
      soc_pct: s.battPct,
      mv: s.battMv,
      source: 'narbis',
      timestamp: Date.now(),
    } as NarbisBatteryEvent);
  };

  /* ---- V2 control surface (used by the tuning sidebar) ---- */

  private requireV2(): V2Session {
    if (!this.v2Session) throw new Error('not connected to a V2 earclip');
    return this.v2Session;
  }

  async v2SetRate(sps: number): Promise<void> {
    const code = SPS_RATE_CODE[sps];
    if (code === undefined) throw new Error(`unsupported rate ${sps} sps`);
    await this.requireV2().controlOk(buildSetRate(code));
  }

  /** Freeze/unfreeze the on-device AGC. Must be frozen before any manual LED
   * or TIA write, otherwise the loop immediately overrides it. */
  async v2SetAgcFrozen(frozen: boolean): Promise<void> {
    await this.requireV2().controlOk(buildAgcFreeze(frozen));
  }

  /** Manual LED currents / TIA gain. Pass null to leave a field untouched. */
  async v2SetManual(opts: { irMa?: number; redMa?: number; rfCode?: number }): Promise<void> {
    let mask = 0;
    if (opts.irMa !== undefined) mask |= AGC_APPLY_IR;
    if (opts.redMa !== undefined) mask |= AGC_APPLY_RED;
    if (opts.rfCode !== undefined) mask |= AGC_APPLY_GAIN;
    if (mask === 0) return;
    await this.requireV2().controlOk(
      buildAgcManual(opts.irMa ?? 0, opts.redMa ?? 0, opts.rfCode ?? 0, mask),
    );
  }

  async v2KnobSet(id: number, value: number): Promise<void> {
    await this.requireV2().controlOk(buildKnobSet(id, value));
  }

  async v2KnobGet(id: number): Promise<number> {
    const payload = await this.requireV2().controlOk(buildKnobGet(id));
    return parseKnobValue(payload).value;
  }

  /** Persist current knob values to device NVS (they are RAM-only until this). */
  async v2KnobSave(): Promise<void> {
    await this.requireV2().controlOk(buildKnobSave());
  }

  async v2Marker(id: number): Promise<void> {
    await this.requireV2().controlOk(buildMarker(id));
  }

  async v2SetStreams(mask: number, on: boolean): Promise<void> {
    await this.requireV2().controlOk(on ? buildStreamStart(mask) : buildStreamStop(mask));
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
      this.emitPhase('reconnecting', attempt + 1);
      try {
        await this.openSession();
        this.setStatus('connected');
        this.emitPhase('ready');
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
    /* Tear the V2 session down before dropping the server: it holds
     * characteristic listeners and may have CONTROL promises in flight,
     * which close() rejects rather than leaving pending forever. */
    if (this.v2Session) {
      this.v2Session.close();
      this.v2Session = null;
    }
    this._protocol = null;
    this._v2Status = null;
    this.v2ClockAnchor = null;
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

  private emitPhase(phase: string, attempt?: number): void {
    this.dispatch('phase', { phase, attempt } as NarbisPhaseDetail);
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
