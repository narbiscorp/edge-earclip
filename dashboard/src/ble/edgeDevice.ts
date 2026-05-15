import {
  NARBIS_CONFIG_WIRE_SIZE,
  NARBIS_COH_PARAMS_WIRE_SIZE,
  serializeCoherenceParams,
  type NarbisCoherenceParams,
} from '../../../protocol/narbis_protocol';

/*
 * edgeDevice.ts - BLE connection to the Narbis Edge glasses.
 *
 * Glasses peripheral exposes a 16-bit-UUID service 0x00FF with four chars:
 *   0xFF01  CTRL    write  - opcode byte then up to 19 B of payload
 *   0xFF02  OTA     write  - DFU data (not used by this dashboard)
 *   0xFF03  STATUS  notify - 1 Hz coherence/status frames (first byte = type)
 *   0xFF04  PPG     notify - optional PPG stream (not used by this dashboard)
 *
 * Control opcodes the dashboard cares about (more in the glasses firmware):
 *   0xC1  CTRL_CMD_NARBIS_FORGET   - wipe stored earclip MAC + restart scan
 *
 * Web Bluetooth needs full 128-bit UUIDs for custom 16-bit values; the
 * canonical mapping is 0000XXXX-0000-1000-8000-00805f9b34fb.
 */

export type EdgeStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface EdgeDisconnectedDetail {
  reason: 'user' | 'gatt' | 'error';
  error?: Error;
}

export interface EdgeErrorDetail {
  error: Error;
  phase: string;
}

/* Status frames on 0xFF03. Frame format mirrors the original Edge
 * dashboard (narbis_edge_hrv_v13_27.html, onStatusData):
 *
 *   0xF0  ADC stats (11 B): min/max/mean of last 25 raw reads + count
 *   0xF1  ASCII log line (up to 48 chars, NUL-terminated)
 *   0xF2  Firmware HRV / coherence packet (18 B)
 *
 * We decode each into a human-readable summary string so the BLE event
 * log shows actual firmware output rather than raw hex. */
export type EdgeStatusKind = 'adc' | 'log' | 'hrv' | 'unknown';
export interface EdgeStatusFrame {
  timestamp: number;
  type: number;
  kind: EdgeStatusKind;
  /** Decoded human-readable summary (the actual firmware log line for 0xF1). */
  summary: string;
  /** Raw bytes (callers can still pull fields out if needed). */
  bytes: Uint8Array;
}

/* Earclip data relayed through the glasses' 0xF1 firmware-log channel.
 * The glasses' main.c on_earclip_ibi / on_earclip_battery callbacks emit
 * lines like "earclip ibi=850 conf=100 flags=0x00" — we parse those here
 * so the dashboard can show beat charts even when it's only BLE-connected
 * to the glasses (not the earclip directly). */
export interface RelayedIbi {
  timestamp: number;
  ibi_ms: number;
  confidence_x100: number;
  flags: number;
}
export interface RelayedBattery {
  timestamp: number;
  soc_pct: number;
  mv: number;
  charging: number;
}

/* Firmware-computed coherence packet (0xF2). Same fields the dashboard
 * decodes into the human-readable BLE log summary, but exposed as a
 * structured payload for charts and the firmware-coherence parity check.
 * Wire layout matches main.c::coh_emit_packet (18 B body after the type
 * byte): coherence u8, resp_peak_mhz u16 LE, vlf/lf/hf/total u16 LE (each
 * scaled into u16 range by firmware), lf_norm u8, hf_norm u8, lf_hf_fp88
 * u16 LE (divide by 256 for ratio), n_ibis_used u8, pacer_bpm u8. The
 * trailing byte was reserved=0 in v4.14.38; firmware ≥ v4.14.40 emits
 * the current adaptive-pacer cycle BPM there. Older firmware reads as 0
 * (the dashboard hides the pacer readout when 0). */
export interface EdgeCoherenceFrame {
  timestamp: number;
  coh: number;
  respMhz: number;
  vlf: number;
  lf: number;
  hf: number;
  total: number;
  lfNorm: number;
  hfNorm: number;
  /** LF/HF ratio as a float (firmware fp8.8 already divided by 256). */
  lfHf: number;
  nIbis: number;
  /** Current breathing-pacer cycle BPM (Programs 2 & 4 with adaptive ON).
   * 0 if firmware is too old to report it OR if no breathing program is
   * running yet. */
  pacerBpm: number;
}

/* Path B Phase 1/2: binary relay frames on 0xFF03.
 * 0xF4 carries a serialized narbis_runtime_config_t (50 B incl. CRC).
 * 0xF5 carries a raw-PPG batch in the same wire format the direct
 * earclip-PPG characteristic uses.
 * 0xF6 carries the glasses-to-earclip relay link state (1 byte: 1=up). */
export interface RelayedConfig {
  timestamp: number;
  /** payload bytes, 0xF4 type prefix already stripped */
  bytes: Uint8Array;
}
export interface RelayedRawPpg {
  timestamp: number;
  /** payload bytes, 0xF5 type prefix already stripped */
  bytes: Uint8Array;
}
export interface CentralRelayState {
  timestamp: number;
  /** true = glasses central is connected to the earclip and subscriptions are in place */
  connected: boolean;
}

/* Path B: relayed diagnostics frame (0xF7). Wire format matches the
 * direct earclip diagnostics char: [seq u16][n u8] then n records of
 * {stream_id u8, len u8, payload}. The dashboard's existing
 * parseDiagnostic() handles it. */
export interface RelayedDiagnostic {
  timestamp: number;
  /** payload bytes, 0xF7 type prefix already stripped */
  bytes: Uint8Array;
}

/* 0xFA: glasses-emitted link-quality snapshot. Glasses fires this at ~1 Hz
 * with RSSI it measured on both its links (central side toward the earclip,
 * peripheral side toward the dashboard) plus current MTU and a running
 * notify-drop counter. Web Bluetooth doesn't expose RSSI to JS, so this
 * frame is the only path to surface link health in the dashboard UI.
 * Wire layout (9 bytes, firmware ≥ v4.15.3-link-quality):
 *   [type=0xFA][earclip_rssi i8][dashboard_rssi i8][mtu u16 LE][drops u16 LE]
 *              [ec_phy u8][dash_phy u8]
 * RSSI bytes are signed; a value of 127 (0x7F) means "unknown / no
 * connection on that side" (e.g. earclip relay down).
 * PHY values: 1=1M, 2=2M. null when byte not present (older firmware). */
export interface LinkQuality {
  timestamp: number;
  /** dBm of the glasses↔earclip link as measured by the glasses central. null if relay down. */
  earclipRssi: number | null;
  /** dBm of the glasses↔dashboard link as measured by the glasses peripheral. null if unknown. */
  dashboardRssi: number | null;
  /** Negotiated ATT MTU on the dashboard link. */
  mtu: number;
  /** Running count of failed nimble_notify() calls since boot. */
  drops: number;
  /** Negotiated PHY on the glasses↔earclip link (1=1M, 2=2M). null on older firmware. */
  ecPhy: number | null;
  /** Negotiated PHY on the glasses↔dashboard link (1=1M, 2=2M). null on older firmware. */
  dashPhy: number | null;
}

/** LED state snapshot from bytes [20–21] of the 0xF3 health frame (firmware v4.15+). */
export interface LedHealth {
  timestamp: number;
  /** Current LED_MODE_* enum value: 0=strobe 1=static 2=breathe 3=breathe+strobe
   *  4=pulse 5=coh·breathe 6=coh·b+strobe 7=coh·lens */
  mode: number;
  /** Effective PWM duty 0–255 (divide by 2.55 for percent). */
  duty: number;
}

const EDGE_SVC_UUID    = '000000ff-0000-1000-8000-00805f9b34fb';
const EDGE_CTRL_UUID   = '0000ff01-0000-1000-8000-00805f9b34fb';
const EDGE_STATUS_UUID = '0000ff03-0000-1000-8000-00805f9b34fb';

const PAIRED_DEVICE_ID_KEY   = 'edgePairedDeviceId';
const PAIRED_DEVICE_NAME_KEY = 'edgePairedDeviceName';

/* CTRL opcodes mirrored from glasses firmware (narbis_edge_hrv_v13_27.html
 * sendCmd_* functions). All take 1 argument byte. Some are setters for
 * persisted firmware state (lens, strobe, breath); others are commands
 * (forget, factory reset, detector reset). */
export const CTRL = {
  LENS_LIMIT_PCT:   0xA2,  // 0..100, lens darkness cap (Programs 1-3)
  STATIC_DUTY:      0xA5,  // 0..100, immediate static lens duty
  STROBE_MODE:      0xA6,  // 0x00 enter strobe mode
  BREATHE_MODE:     0xB0,  // 0x00 enter breathe mode
  BREATH_BPM:       0xB1,  // 4..20 breaths per minute
  BREATH_INHALE:    0xB2,  // 30..70 inhale ratio percent (e.g. 40 = 40/60)
  PULSE_ON_BEAT:    0xB6,  // 0x00 enter pulse-on-beat
  PROGRAM_SELECT:   0xB7,  // 1..4 PPG program (1=heartbeat, 2=coh breathe, 3=coh lens, 4=coh breathe+strobe)
  DIFFICULTY:       0xB8,  // 0..3 (0=easy, 1=med, 2=hard, 3=expert)
  ADAPTIVE_PACER:   0xB9,  // 0/1 track measured respiration rate
  STROBE_FREQ_HZ:   0xAB,  // 1..50 Hz, strobe flash rate
  STROBE_DUTY_PCT:  0xAC,  // 10..90 % dark fraction per cycle
  FACTORY_RESET:    0xBF,  // 0x00 wipe ALL stored prefs
  NARBIS_FORGET:    0xC1,  // 0x00 wipe paired earclip + rescan (Path B)
  INJECT_IBI:       0xCA,  // [ibi_lo, ibi_hi, conf, flags] feed external HR (H10) into coherence
  SET_HR_SOURCE:    0xCB,  // 0=earclip (resume central scan), 1=h10 (pause central scan)
  COH_PARAMS:       0xE0,  // 12-byte narbis_coh_params_t — live algorithm tuning
  DETECTOR_RESET:   0xD0,  // 0x00 reset client/dashboard detector state
} as const;

/** @deprecated use CTRL.NARBIS_FORGET */
export const CTRL_CMD_NARBIS_FORGET = CTRL.NARBIS_FORGET;

export type CoherenceDifficulty = 'easy' | 'medium' | 'hard' | 'expert';
export type PpgProgram = 1 | 2 | 3 | 4;
const DIFFICULTY_VALUE: Record<CoherenceDifficulty, number> = {
  easy: 0, medium: 1, hard: 2, expert: 3,
};

const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

interface ListenerHandle {
  target: BluetoothRemoteGATTCharacteristic;
  type: string;
  listener: (ev: Event) => void;
}

export function getEdgePairedDeviceName(): string | null {
  try { return localStorage.getItem(PAIRED_DEVICE_NAME_KEY); } catch { return null; }
}

export function forgetEdgePairedDevice(): void {
  try {
    localStorage.removeItem(PAIRED_DEVICE_ID_KEY);
    localStorage.removeItem(PAIRED_DEVICE_NAME_KEY);
  } catch { /* ignore */ }
}

export class EdgeDevice extends EventTarget {
  private device: BluetoothDevice | null = null;
  private server: BluetoothRemoteGATTServer | null = null;
  private chCtrl: BluetoothRemoteGATTCharacteristic | null = null;
  private listeners: ListenerHandle[] = [];
  private intentionalDisconnect = false;
  private _status: EdgeStatus = 'disconnected';
  private _deviceName: string | null = null;
  /* Timestamp (ms) of the last 0xF9 binary IBI relay frame received.
   * Used to suppress the 0xF1 ASCII IBI duplicate: new glasses firmware
   * sends both for each beat; 0xF9 is authoritative, 0xF1 is fallback
   * for older firmware that doesn't emit 0xF9. Reset on disconnect so a
   * reconnect to old firmware re-enables the 0xF1 path. */
  private lastF9IbiTs = 0;

  get status(): EdgeStatus { return this._status; }
  get deviceName(): string | null { return this._deviceName; }
  get isConnected(): boolean { return this._status === 'connected'; }

  async connect(): Promise<void> {
    if (this._status === 'connecting' || this._status === 'connected') return;
    if (!navigator.bluetooth) {
      throw new Error('Web Bluetooth is not available in this browser');
    }
    this.intentionalDisconnect = false;
    this.setStatus('connecting');
    try {
      const device = await navigator.bluetooth.requestDevice({
        // Glasses firmware advertises with the literal name "Narbis_Edge"
        // (underscore, not space). The original Edge dashboard uses an
        // exact-name filter; we mirror that and add a service-UUID
        // fallback for builds where Windows strips 16-bit UUIDs from
        // adverts but the name still arrives.
        filters: [
          { name: 'Narbis_Edge' },
          { services: [EDGE_SVC_UUID] },
        ],
        optionalServices: [EDGE_SVC_UUID],
      });
      this.device = device;
      this._deviceName = device.name ?? 'Narbis Edge';
      try {
        localStorage.setItem(PAIRED_DEVICE_ID_KEY, device.id);
        localStorage.setItem(PAIRED_DEVICE_NAME_KEY, this._deviceName);
      } catch { /* quota / private mode */ }
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
      this.dispatch('disconnected', { reason: 'user' } as EdgeDisconnectedDetail);
      this.intentionalDisconnect = false;
    }
  }

  /** Send a CTRL opcode + optional argument bytes. Glasses firmware
   * (main.c::process_command) requires len >= 2 — single-byte writes
   * are silently dropped. We always pad to >= 2 bytes by appending
   * 0x00 if no payload was supplied. The hard cap is the negotiated
   * ATT MTU minus 3 (header). Web Bluetooth typically negotiates
   * MTU 247 → 244 B usable. Path B Phase 1's 0xC3 forward needs 52 B
   * (1 opcode + 1 spacer + 50 B config blob), well within MTU. Throws
   * if not connected. */
  async sendCtrlCommand(opcode: number, payload?: Uint8Array): Promise<void> {
    if (!this.chCtrl) throw new Error('not connected');
    const payloadLen = payload?.length ?? 0;
    const total = Math.max(2, 1 + payloadLen);
    if (total > 244) throw new Error(`ctrl write too long: ${total} > 244 B`);
    const buf = new Uint8Array(total);
    buf[0] = opcode & 0xff;
    if (payload && payloadLen) buf.set(payload, 1);
    // bytes beyond opcode+payload are zero from Uint8Array() initialization,
    // which serves as the firmware's "no arg" default.
    await this.chCtrl.writeValueWithResponse(toBufferSource(buf));
    this.dispatch('ctrlSent', { opcode, length: total });
  }

  /** Convenience wrapper for the forget+rescan opcode. */
  async forgetEarclipPairing(): Promise<void> {
    await this.sendCtrlCommand(CTRL.NARBIS_FORGET);
  }

  /** Path B Phase 1: forward a serialized config blob to the earclip via
   * the glasses' GATTC central. Used by narbisDevice.writeConfig() as a
   * fallback when there is no direct earclip BLE session. */
  async forwardEarclipConfigWrite(blob: Uint8Array): Promise<void> {
    if (blob.length !== NARBIS_CONFIG_WIRE_SIZE) {
      throw new Error(`config blob must be ${NARBIS_CONFIG_WIRE_SIZE} bytes (got ${blob.length})`);
    }
    await this.sendCtrlCommand(0xC3, blob);
  }

  /** Path B Phase 2: toggle whether the glasses subscribe to the
   * earclip's RAW_PPG characteristic and forward each batch as a 0xF5
   * frame. Default off — significant air-time / power cost. */
  async setRawRelayEnabled(on: boolean): Promise<void> {
    await this.sendCtrlCommand(0xC4, new Uint8Array([on ? 1 : 0]));
  }

  /** Path B Phase 1: ask the glasses' central to re-issue the one-shot
   * GATTC read of the earclip's CONFIG characteristic. The central does
   * this once inside enter_ready(), but if Bluedroid's outbound queue
   * was full at that moment the read can be silently dropped — leaving
   * the dashboard with no 0xF4 frame ever and the ConfigPanel stuck on
   * "Connect a Narbis device". 0xC5 is the recovery path: store auto-
   * sends it when relay goes UP but no config has arrived within ~2 s,
   * and the ConfigPanel exposes it as a manual "Reload from earclip"
   * button. Requires glasses firmware with the 0xC5 handler (PR
   * narbiscorp/edge-firmware claude/refresh-config-opcode). */
  async requestEarclipConfigRead(): Promise<void> {
    await this.sendCtrlCommand(0xC5);
  }

  // ---------- High-level setters (mirror v13.27 sendCmd_* helpers) ----------

  /** Switch the glasses into training mode and select PPG program 1-4.
   * Wire-format note: firmware uses 0-indexed enum values (HEARTBEAT=0,
   * COHERENCE_BREATHE=1, COHERENCE_LENS=2, COHERENCE_BREATHE_STROBE=3),
   * so we send (p - 1). The UI exposes the user-facing 1-4 numbering. */
  async setProgram(p: PpgProgram): Promise<void> {
    await this.sendCtrlCommand(CTRL.PROGRAM_SELECT, new Uint8Array([p - 1]));
  }

  /** Standalone modes — these do NOT require a connected sensor. Each
   * is a direct lens-driver mode change and ignores any PPG signal. */
  async setStandaloneStatic(dutyPct: number): Promise<void> {
    const v = clamp(Math.round(dutyPct), 0, 100);
    await this.sendCtrlCommand(CTRL.STATIC_DUTY, new Uint8Array([v]));
  }
  async setStandaloneStrobe(): Promise<void> {
    await this.sendCtrlCommand(CTRL.STROBE_MODE, new Uint8Array([0]));
  }
  async setStandaloneBreathe(): Promise<void> {
    await this.sendCtrlCommand(CTRL.BREATHE_MODE, new Uint8Array([0]));
  }
  async setStandalonePulseOnBeat(): Promise<void> {
    await this.sendCtrlCommand(CTRL.PULSE_ON_BEAT, new Uint8Array([0]));
  }

  async setDifficulty(d: CoherenceDifficulty): Promise<void> {
    await this.sendCtrlCommand(CTRL.DIFFICULTY, new Uint8Array([DIFFICULTY_VALUE[d]]));
  }

  /** 0..100; firmware caps lens darkness for Programs 1-3 to this percentage. */
  async setLensLimitPct(pct: number): Promise<void> {
    const v = clamp(Math.round(pct), 0, 100);
    await this.sendCtrlCommand(CTRL.LENS_LIMIT_PCT, new Uint8Array([v]));
  }

  /** 1.0..50.0 Hz, flash rate for Program 4 / standalone strobe.
   *
   * Sends the 3-byte form (deci-Hz, u16 LE) supported by firmware
   * ≥ v4.14.41 so callers can hit half-Hz brainwave-entrainment targets
   * (13.5 Hz, 17.5 Hz, etc.) without integer rounding. Older firmware
   * ignores byte 2 and reads byte 1 as integer Hz — still works but
   * loses the 0.1 Hz precision. */
  async setStrobeFreqHz(hz: number): Promise<void> {
    const dhz = Math.round(clamp(hz, 1, 50) * 10);
    const payload = new Uint8Array([dhz & 0xff, (dhz >> 8) & 0xff]);
    await this.sendCtrlCommand(CTRL.STROBE_FREQ_HZ, payload);
  }

  /** 10..90 %, dark fraction per strobe cycle. */
  async setStrobeDutyPct(pct: number): Promise<void> {
    const v = clamp(Math.round(pct), 10, 90);
    await this.sendCtrlCommand(CTRL.STROBE_DUTY_PCT, new Uint8Array([v]));
  }

  /** 4..20 breaths per minute (Program 2 default 6, Program 4 paced from this). */
  async setBreathRateBpm(bpm: number): Promise<void> {
    const v = clamp(Math.round(bpm), 4, 20);
    await this.sendCtrlCommand(CTRL.BREATH_BPM, new Uint8Array([v]));
  }

  /** 30..70 % inhale fraction; e.g. 40 = inhale 40 / exhale 60. */
  async setBreathInhalePct(pct: number): Promise<void> {
    const v = clamp(Math.round(pct), 30, 70);
    await this.sendCtrlCommand(CTRL.BREATH_INHALE, new Uint8Array([v]));
  }

  /** Track measured respiration rate (Programs 2 & 4) instead of fixed BPM. */
  async setAdaptivePacer(on: boolean): Promise<void> {
    await this.sendCtrlCommand(CTRL.ADAPTIVE_PACER, new Uint8Array([on ? 1 : 0]));
  }

  /** Wipe ALL stored prefs on the glasses (factory reset). */
  async factoryReset(): Promise<void> {
    await this.sendCtrlCommand(CTRL.FACTORY_RESET, new Uint8Array([0]));
  }

  /** Tell firmware to reset its detector state (drop NCC template, restart blocks). */
  async detectorReset(): Promise<void> {
    await this.sendCtrlCommand(CTRL.DETECTOR_RESET, new Uint8Array([0]));
  }

  /** Push a new `narbis_coh_params_t` to the glasses (opcode 0xE0). The
   * firmware validates ranges, rejects out-of-grid bins / inverted lo/hi,
   * applies atomically, and persists each field to NVS. New params take
   * effect on the next coherence_task tick (≤1 s). */
  async writeCoherenceParams(p: NarbisCoherenceParams): Promise<void> {
    const payload = serializeCoherenceParams(p);
    if (payload.length !== NARBIS_COH_PARAMS_WIRE_SIZE) {
      throw new Error(`coh params size mismatch: ${payload.length} vs ${NARBIS_COH_PARAMS_WIRE_SIZE}`);
    }
    await this.sendCtrlCommand(CTRL.COH_PARAMS, payload);
  }

  /** Tell the glasses which HR source the dashboard is using. When set
   * to 'h10', the glasses' BLE central halts its earclip scan/reconnect
   * loop — saves power and radio time, prevents stale earclip notifies
   * from racing the dashboard-injected RR stream. Resumes the scan when
   * set back to 'earclip'. */
  async setHrSource(source: 'earclip' | 'h10'): Promise<void> {
    const arg = source === 'h10' ? 1 : 0;
    await this.sendCtrlCommand(CTRL.SET_HR_SOURCE, new Uint8Array([arg]));
  }

  /** Inject an external IBI (e.g. from a Polar H10) into the glasses'
   * coherence pipeline. Mirrors the path the earclip's IBI takes through
   * on_earclip_ibi → coh_push_ibi, so all four PPG programs respond
   * identically regardless of source. The dashboard calls this once per
   * R-R interval when HR-source-for-glasses is set to H10. Firmware drops
   * conf<50 or flags with ARTIFACT, matching the earclip path. */
  async injectIbi(ibi_ms: number, conf = 100, flags = 0): Promise<void> {
    const ibi = Math.max(0, Math.min(0xffff, Math.round(ibi_ms)));
    const payload = new Uint8Array([
      ibi & 0xff,
      (ibi >> 8) & 0xff,
      conf & 0xff,
      flags & 0xff,
    ]);
    await this.sendCtrlCommand(CTRL.INJECT_IBI, payload);
  }

  private async openSession(): Promise<void> {
    if (!this.device?.gatt) throw new Error('no GATT server');
    this.server = await this.device.gatt.connect();

    const svc = await this.server.getPrimaryService(EDGE_SVC_UUID);

    const [chCtrl, chStatus] = await Promise.all([
      svc.getCharacteristic(EDGE_CTRL_UUID),
      svc.getCharacteristic(EDGE_STATUS_UUID),
    ]);
    this.chCtrl = chCtrl;

    this.attach(chStatus, this.onStatusNotify);
    await chStatus.startNotifications();
  }

  private attach(ch: BluetoothRemoteGATTCharacteristic, listener: (ev: Event) => void): void {
    ch.addEventListener('characteristicvaluechanged', listener);
    this.listeners.push({ target: ch, type: 'characteristicvaluechanged', listener });
  }

  private onGattDisconnected = (): void => {
    if (this.intentionalDisconnect) {
      this.setStatus('disconnected');
      this.cleanupConnection();
      this.dispatch('disconnected', { reason: 'user' } as EdgeDisconnectedDetail);
      this.intentionalDisconnect = false;
      return;
    }
    this.setStatus('reconnecting');
    this.cleanupConnection({ keepDevice: true });
    this.dispatch('disconnected', { reason: 'gatt' } as EdgeDisconnectedDetail);
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
        this.dispatch('connected', { name: this._deviceName ?? 'Narbis Edge' });
        return;
      } catch (err) {
        this.emitError(err, `reconnect-attempt-${attempt + 1}`);
        attempt += 1;
      }
    }
  }

  private onStatusNotify = (ev: Event): void => {
    try {
      const dv = (ev.target as BluetoothRemoteGATTCharacteristic).value;
      if (!dv) return;
      const bytes = new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength));
      const type = bytes[0] ?? 0;
      const { kind, summary } = decodeStatusFrame(bytes, dv);
      const ts = Date.now();
      const detail: EdgeStatusFrame = { timestamp: ts, type, kind, summary, bytes };
      this.dispatch('statusFrame', detail);

      /* If this is a 0xF1 log line from the glasses' on_earclip_ibi /
       * on_earclip_battery hooks, parse out the structured values and
       * fire dedicated relay events. This lets the dashboard render
       * beat/battery charts when it's only connected to the glasses. */
      if (kind === 'log') {
        /* Only parse IBI from the 0xF1 ASCII line when no 0xF9 binary
         * frame has been seen recently. New glasses firmware sends both
         * per beat; 0xF9 is authoritative. 3 s window covers HR ≥ 20 BPM. */
        if (ts - this.lastF9IbiTs > 3000) {
          const ibi = parseRelayedIbi(summary, ts);
          if (ibi) this.dispatch('relayedIbi', ibi);
        }
        const batt = parseRelayedBattery(summary, ts);
        if (batt) this.dispatch('relayedBattery', batt);
      }

      /* 0xF2 firmware HRV/coherence — surface as a structured event so
       * charts can plot it alongside the dashboard's local
       * firmwareCoherence output (parity check) and so the metrics
       * runner can record it. Fields match coh_emit_packet exactly. */
      if (type === 0xF2 && bytes.length >= 18) {
        const detail: EdgeCoherenceFrame = {
          timestamp: ts,
          coh:      dv.getUint8(1),
          respMhz:  dv.getUint16(2, true),
          vlf:      dv.getUint16(4, true),
          lf:       dv.getUint16(6, true),
          hf:       dv.getUint16(8, true),
          total:    dv.getUint16(10, true),
          lfNorm:   dv.getUint8(12),
          hfNorm:   dv.getUint8(13),
          lfHf:     dv.getUint16(14, true) / 256,
          nIbis:    dv.getUint8(16),
          pacerBpm: dv.getUint8(17),  /* 0 on older firmware */
        };
        this.dispatch('edgeCoherence', detail);
      }

      /* 0xF3 health frame — LED state snapshot at bytes [20–21] (firmware v4.15+). */
      if (type === 0xF3 && bytes.length >= 22) {
        this.dispatch('ledHealth', {
          timestamp: ts,
          mode: bytes[20],
          duty: bytes[21],
        } as LedHealth);
      }

      /* Path B Phase 1/2: binary relay frames. The store deserializes the
       * config and feeds the raw batch into the same processRawBatch the
       * direct path uses. Strip the 1-byte type prefix here so consumers
       * don't have to. */
      if (type === 0xF4 && bytes.length > 1) {
        this.dispatch('relayedConfig', {
          timestamp: ts,
          bytes: bytes.slice(1),
        } as RelayedConfig);
      } else if (type === 0xF5 && bytes.length > 1) {
        this.dispatch('relayedRawPpg', {
          timestamp: ts,
          bytes: bytes.slice(1),
        } as RelayedRawPpg);
      } else if (type === 0xF6 && bytes.length >= 2) {
        this.dispatch('centralRelayState', {
          timestamp: ts,
          connected: bytes[1] !== 0,
        } as CentralRelayState);
      } else if (type === 0xF7 && bytes.length > 1) {
        this.dispatch('relayedDiagnostic', {
          timestamp: ts,
          bytes: bytes.slice(1),
        } as RelayedDiagnostic);
      } else if (type === 0xF8 && bytes.length >= 5) {
        /* 0xF8 = structured earclip battery relay. Payload mirrors
         * narbis_battery_payload_t: mv u16 LE, soc u8, charging u8.
         * The 0xF1 log-line fallback parser remains as belt-and-suspenders
         * for older glasses firmware. */
        const mv = bytes[1] | (bytes[2] << 8);
        const soc_pct = bytes[3];
        const charging = bytes[4];
        this.dispatch('relayedBattery', {
          timestamp: ts,
          soc_pct,
          mv,
          charging,
        } as RelayedBattery);
      } else if (type === 0xF9 && bytes.length >= 5) {
        /* 0xF9 = structured earclip IBI relay. Payload:
         *   ibi_ms u16 LE, confidence_x100 u8, flags u8.
         * Compact (5 B vs ~30 B for the 0xF1 ASCII line) so it survives
         * marginal-link contention better. The 0xF1 regex parser stays
         * as a belt-and-suspenders path for older glasses firmware. */
        const ibi_ms = bytes[1] | (bytes[2] << 8);
        const confidence_x100 = bytes[3];
        const flags = bytes[4];
        if (ibi_ms > 0) {
          this.lastF9IbiTs = ts;  /* mark 0xF9 seen; suppresses 0xF1 duplicate */
          this.dispatch('relayedIbi', {
            timestamp: ts,
            ibi_ms,
            confidence_x100,
            flags,
          } as RelayedIbi);
        }
      } else if (type === 0xFA && bytes.length >= 7) {
        /* 0xFA = link quality snapshot. See LinkQuality interface comment. */
        const ecRaw = dv.getInt8(1);
        const dashRaw = dv.getInt8(2);
        const mtu = bytes[3] | (bytes[4] << 8);
        const drops = bytes[5] | (bytes[6] << 8);
        const ecPhy   = bytes.length >= 9 ? bytes[7] : null;
        const dashPhy = bytes.length >= 9 ? bytes[8] : null;
        this.dispatch('linkQuality', {
          timestamp: ts,
          earclipRssi:   ecRaw   === 0x7F ? null : ecRaw,
          dashboardRssi: dashRaw === 0x7F ? null : dashRaw,
          mtu,
          drops,
          ecPhy,
          dashPhy,
        } as LinkQuality);
      }
    } catch (err) {
      this.emitError(err, 'status-parse');
    }
  };

  private cleanupConnection(opts: { keepDevice?: boolean } = {}): void {
    this.lastF9IbiTs = 0;
    for (const h of this.listeners) {
      h.target.removeEventListener(h.type, h.listener);
    }
    this.listeners = [];
    this.server = null;
    this.chCtrl = null;
    if (!opts.keepDevice) {
      if (this.device) {
        this.device.removeEventListener('gattserverdisconnected', this.onGattDisconnected);
      }
      this.device = null;
      this._deviceName = null;
    }
  }

  private setStatus(s: EdgeStatus): void { this._status = s; }
  private dispatch<T>(type: string, detail: T): void {
    this.dispatchEvent(new CustomEvent<T>(type, { detail }));
  }
  private emitError(err: unknown, phase: string): void {
    const error = err instanceof Error ? err : new Error(String(err));
    this.dispatch('error', { error, phase } as EdgeErrorDetail);
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

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/* Glasses firmware emits these via ble_log() in main.c::on_earclip_ibi:
 *   "earclip ibi=850 conf=100 flags=0x00"
 * Tolerant regex: digits for ibi/conf, hex byte for flags. */
const RELAYED_IBI_RE = /^earclip ibi=(\d+) conf=(\d+) flags=0x([0-9a-f]+)/i;
function parseRelayedIbi(line: string, timestamp: number): RelayedIbi | null {
  const m = RELAYED_IBI_RE.exec(line);
  if (!m) return null;
  const ibi_ms = parseInt(m[1], 10);
  const confidence_x100 = parseInt(m[2], 10);
  const flags = parseInt(m[3], 16);
  if (!Number.isFinite(ibi_ms) || ibi_ms <= 0) return null;
  return { timestamp, ibi_ms, confidence_x100, flags };
}

/* Glasses firmware emits these via ble_log() in main.c::on_earclip_battery:
 *   "earclip batt soc=72%% mv=3850 chg=1" */
const RELAYED_BATT_RE = /^earclip batt soc=(\d+)%? mv=(\d+) chg=(\d+)/i;
function parseRelayedBattery(line: string, timestamp: number): RelayedBattery | null {
  const m = RELAYED_BATT_RE.exec(line);
  if (!m) return null;
  return {
    timestamp,
    soc_pct: parseInt(m[1], 10),
    mv: parseInt(m[2], 10),
    charging: parseInt(m[3], 10),
  };
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');
}

/* Decode an 0xFF03 status frame into a (kind, summary) pair. Mirrors the
 * original narbis_edge_hrv_v13_27.html parser (firmware v4.13+ emits
 * 0xF0/0xF1/0xF2). Anything else falls through to a hex dump. */
function decodeStatusFrame(
  bytes: Uint8Array,
  dv: DataView,
): { kind: EdgeStatusKind; summary: string } {
  if (bytes.length < 1) return { kind: 'unknown', summary: '(empty frame)' };
  const type = bytes[0];

  if (type === 0xF0 && bytes.length >= 8) {
    const min  = dv.getUint16(1, true);
    const max  = dv.getUint16(3, true);
    const mean = dv.getUint16(5, true);
    const n    = dv.getUint8(7);
    const span = max - min;
    return { kind: 'adc', summary: `ADC stats: min=${min} max=${max} mean=${mean} span=${span} n=${n}` };
  }

  if (type === 0xF1) {
    let msg = '';
    for (let i = 1; i < bytes.length; i++) {
      const c = bytes[i];
      if (c === 0) break;
      msg += String.fromCharCode(c);
    }
    return { kind: 'log', summary: msg.length ? msg : '(empty log line)' };
  }

  if (type === 0xF3 && bytes.length >= 20) {
    // Health / runtime telemetry frame (firmware v4.15+), 22 bytes:
    //   [1-4]    uptime_s            u32 LE
    //   [5-8]    heap_free           u32 LE
    //   [9-12]   heap_min            u32 LE
    //   [13-14]  ppg_stack_hwm       u16 LE
    //   [15-16]  ble_send_errors     u16 LE
    //   [17-18]  jitter_max_us       u16 LE
    //   [19]     jitter_ticks_over   u8
    //   [20]     led_mode            u8  (LED_MODE_* enum)
    //   [21]     led_duty            u8  (0–255 = 0–100% PWM)
    const uptimeS   = dv.getUint32(1,  true);
    const heapFree  = dv.getUint32(5,  true);
    const heapMin   = dv.getUint32(9,  true);
    const stackHwm  = dv.getUint16(13, true);
    const bleErrs   = dv.getUint16(15, true);
    const jitterMax = dv.getUint16(17, true);
    const jitterTicks = dv.getUint8(19);
    return {
      kind: 'unknown',
      summary:
        `health t=${uptimeS}s heap=${heapFree} min=${heapMin} stack=${stackHwm} ` +
        `ble_err=${bleErrs} jitter_max=${jitterMax}us ticks_over=${jitterTicks}`,
    };
  }

  if (type === 0xF2 && bytes.length >= 18) {
    const coh        = dv.getUint8(1);
    const respMhz    = dv.getUint16(2, true);
    const lf         = dv.getUint16(6, true);
    const hf         = dv.getUint16(8, true);
    const lfNorm     = dv.getUint8(12);
    const hfNorm     = dv.getUint8(13);
    const lfHfFp     = dv.getUint16(14, true);
    const lfHf       = (lfHfFp / 256).toFixed(2);
    const nIbis      = dv.getUint8(16);
    return {
      kind: 'hrv',
      summary:
        `HRV: coh=${coh} resp=${(respMhz / 1000).toFixed(2)} Hz ` +
        `LF=${lf} HF=${hf} LFn=${lfNorm}% HFn=${hfNorm}% LF/HF=${lfHf} n=${nIbis}`,
    };
  }

  /* Path B relay frames — terse summaries; the store consumes the bytes
   * via dedicated 'relayedConfig' / 'relayedRawPpg' events. */
  if (type === 0xF4 && bytes.length >= 1 + NARBIS_CONFIG_WIRE_SIZE) {
    return {
      kind: 'unknown',
      summary: `relay config (${bytes.length - 1} B): ${bytesToHex(bytes.slice(1, 9))}…`,
    };
  }
  if (type === 0xF5 && bytes.length >= 5) {
    const sr = dv.getUint16(1, true);
    const n  = dv.getUint16(3, true);
    return { kind: 'unknown', summary: `relay raw_ppg ${n} samples @${sr} Hz (${bytes.length - 1} B)` };
  }
  if (type === 0xF6 && bytes.length >= 2) {
    return { kind: 'unknown', summary: `relay link ${bytes[1] ? 'UP — earclip subscribed' : 'DOWN'}` };
  }
  if (type === 0xF7 && bytes.length >= 4) {
    /* [type][seq u16][n u8][records...] */
    const n = bytes[3];
    return { kind: 'unknown', summary: `relay diag seq=${dv.getUint16(1, true)} n=${n} (${bytes.length - 1} B)` };
  }
  if (type === 0xF8 && bytes.length >= 5) {
    const mv = dv.getUint16(1, true);
    const soc = bytes[3];
    const chg = bytes[4];
    return { kind: 'unknown', summary: `relay batt soc=${soc}% mv=${mv} chg=${chg}` };
  }
  if (type === 0xF9 && bytes.length >= 5) {
    const ibi = dv.getUint16(1, true);
    const conf = bytes[3];
    const flags = bytes[4];
    return { kind: 'unknown', summary: `relay ibi=${ibi} conf=${conf} flags=0x${flags.toString(16).padStart(2, '0')}` };
  }
  if (type === 0xFA && bytes.length >= 7) {
    const ec = dv.getInt8(1);
    const dash = dv.getInt8(2);
    const mtu = dv.getUint16(3, true);
    const drops = dv.getUint16(5, true);
    const ecStr   = ec   === 0x7F ? '—' : `${ec}`;
    const dashStr = dash === 0x7F ? '—' : `${dash}`;
    const phyStr  = bytes.length >= 9 ? ` ec_phy=${bytes[7]} dash_phy=${bytes[8]}` : '';
    return { kind: 'unknown', summary: `link rssi ec=${ecStr} dash=${dashStr} dBm mtu=${mtu} drops=${drops}${phyStr}` };
  }

  return { kind: 'unknown', summary: `type=0x${type.toString(16).padStart(2, '0')} (${bytes.length} B): ${bytesToHex(bytes)}` };
}

export const edgeDevice = new EdgeDevice();
