/*
 * tpsStore — state for the Thought Technology TPS sensor feature: the BLE link diagnostics, the
 * signal source (live link or simulator), the running "Relax" protocol engine, and the glasses
 * output it drives. Self-contained on purpose: the main dashboard store only lends us the glasses
 * connection state and the ability to stop the coherence engine when TPS takes the lens.
 */
import { create } from 'zustand';
import { StreamBuffer } from '../state/streamBuffer';
import { useDashboardStore, stopCoherenceEngine } from '../state/store';
import { coherenceEngine } from '../engine/coherenceEngine';
import { edgeDevice } from '../ble/edgeDevice';
import {
  tpsDevice, emptyStats, TpsDevice,
  type TpsLinkStatus, type TpsDeviceInfo, type TpsGattService, type TpsLinkStats, type TpsLogDetail, type TpsPacketDetail,
} from '../ble/tpsDevice';
import { DEFAULT_TUNABLES, TpsProtocolEngine, type TpsProtocolFrame, type TpsTunables } from './tpsProtocol';
import { SimulatedTpsSource, type TpsSampleEvent, type TpsScenarioName } from './tpsSource';

export type TpsOutputMode = 'off' | 'biofeedback' | 'breathing';
export type TpsSourceMode = 'live' | 'simulated';

export interface TpsLogEntry {
  id: number;
  timestamp: number;
  level: TpsLogDetail['level'];
  message: string;
}

export interface TpsLatest {
  tempC: number | null;
  scUs: number | null;
  hr: number | null;
  ibiMs: number | null;
  lfPct: number | null;
  lfPower: number | null;
  vlfPct: number | null;
  hfPct: number | null;
  hrvMissingS: number;
  contact: boolean | null;
  moving: boolean | null;
}

const BLANK_LATEST: TpsLatest = {
  tempC: null, scUs: null, hr: null, ibiMs: null, lfPct: null, lfPower: null, vlfPct: null, hfPct: null,
  hrvMissingS: 0, contact: null, moving: null,
};

export interface TpsState {
  link: {
    status: TpsLinkStatus;
    info: TpsDeviceInfo;
    services: TpsGattService[];
    stats: TpsLinkStats;
    error: string | null;
  };
  log: TpsLogEntry[];
  /** Last packets seen on the link (newest last); a copy of the driver's ring for rendering. */
  packets: TpsPacketDetail[];

  sourceMode: TpsSourceMode;
  scenario: TpsScenarioName;
  speed: number;
  sourceRunning: boolean;

  latest: TpsLatest;
  frame: TpsProtocolFrame | null;
  tunables: TpsTunables;

  output: TpsOutputMode;
  breathBpm: number;
  inhalePct: number;
  lastDutySent: number | null;

  connectLink: () => Promise<void>;
  disconnectLink: () => Promise<void>;
  setSourceMode: (m: TpsSourceMode) => void;
  setScenario: (n: TpsScenarioName) => void;
  setSpeed: (s: number) => void;
  startSource: () => void;
  stopSource: () => void;
  resetProtocol: () => void;
  setTunables: (t: Partial<TpsTunables>) => void;
  resetTunables: () => void;
  setOutput: (m: TpsOutputMode) => Promise<void>;
  setBreathBpm: (v: number) => void;
  setInhalePct: (v: number) => void;
}

/* ---- persistence --------------------------------------------------------- */

const TUNABLES_KEY = 'tps.tunables';
const BREATH_KEY = 'tps.breath';
const SCENARIO_KEY = 'tps.scenario';

function loadTunables(): TpsTunables {
  try {
    const raw = localStorage.getItem(TUNABLES_KEY);
    if (raw) {
      const t = JSON.parse(raw) as Partial<TpsTunables>;
      const out: TpsTunables = { ...DEFAULT_TUNABLES };
      for (const k of Object.keys(DEFAULT_TUNABLES) as Array<keyof TpsTunables>) {
        const v = t[k];
        if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
      }
      return out;
    }
  } catch { /* private mode / bad JSON */ }
  return { ...DEFAULT_TUNABLES };
}
function saveTunables(t: TpsTunables): void {
  try { localStorage.setItem(TUNABLES_KEY, JSON.stringify(t)); } catch { /* ignore */ }
}
function loadBreath(): { bpm: number; inhalePct: number } {
  try {
    const raw = localStorage.getItem(BREATH_KEY);
    if (raw) {
      const b = JSON.parse(raw) as { bpm?: number; inhalePct?: number };
      return {
        bpm: typeof b.bpm === 'number' && b.bpm >= 3 && b.bpm <= 12 ? b.bpm : 6,
        inhalePct: typeof b.inhalePct === 'number' && b.inhalePct >= 20 && b.inhalePct <= 70 ? b.inhalePct : 40,
      };
    }
  } catch { /* ignore */ }
  return { bpm: 6, inhalePct: 40 };
}
function saveBreath(bpm: number, inhalePct: number): void {
  try { localStorage.setItem(BREATH_KEY, JSON.stringify({ bpm, inhalePct })); } catch { /* ignore */ }
}
function loadScenario(): TpsScenarioName {
  try {
    const v = localStorage.getItem(SCENARIO_KEY);
    if (v === 'relax' || v === 'stress' || v === 'artifacts') return v;
  } catch { /* ignore */ }
  return 'relax';
}

/* ---- buffers (module-level, like the dashboard's other signal buffers) ----- */

export const tpsBuffers = {
  /** IBI ms per beat (from beat events; the TT SDK gives beats, not intervals). */
  ibi: new StreamBuffer<number>(4000),
  hr: new StreamBuffer<number>(4000),
  temp: new StreamBuffer<number>(4000),
  sc: new StreamBuffer<number>(12000),
  /** One protocol frame per 10 Hz tick — ~20 min. */
  frames: new StreamBuffer<TpsProtocolFrame>(12000),
};

function clearBuffers(): void {
  for (const b of Object.values(tpsBuffers)) b.clear();
}

/* ---- store ---------------------------------------------------------------- */

const _breath = loadBreath();

export const useTpsStore = create<TpsState>((set, get) => ({
  link: { status: 'disconnected', info: TpsDevice.blankInfo(), services: [], stats: emptyStats(), error: null },
  log: [],
  packets: [],
  sourceMode: 'simulated',
  scenario: loadScenario(),
  speed: 1,
  sourceRunning: false,
  latest: { ...BLANK_LATEST },
  frame: null,
  tunables: loadTunables(),
  output: 'off',
  breathBpm: _breath.bpm,
  inhalePct: _breath.inhalePct,
  lastDutySent: null,

  connectLink: async () => {
    set((s) => ({ link: { ...s.link, error: null } }));
    try {
      await tpsDevice.connect();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set((s) => ({ link: { ...s.link, error: message } }));
      throw err;
    }
  },
  disconnectLink: async () => {
    await tpsDevice.disconnect();
  },

  setSourceMode: (m) => {
    if (m === get().sourceMode) return;
    get().stopSource();
    set({ sourceMode: m });
  },
  setScenario: (n) => {
    set({ scenario: n });
    try { localStorage.setItem(SCENARIO_KEY, n); } catch { /* ignore */ }
    simulated?.setScenario(n);
    if (get().sourceRunning) get().resetProtocol();
  },
  setSpeed: (sp) => {
    set({ speed: sp });
    simulated?.setSpeed(sp);
  },
  startSource: () => {
    const s = get();
    if (s.sourceRunning) return;
    if (s.sourceMode === 'live') {
      appendLog('warn', 'live decoding is not available in the browser (encrypted stream) — use Simulated here, or the phone app');
      return;
    }
    resetEngine();
    if (!simulated) simulated = new SimulatedTpsSource(s.scenario, s.speed);
    simulated.setScenario(s.scenario);
    simulated.setSpeed(s.speed);
    simulated.addEventListener('sample', onSampleEvent);
    simulated.start();
    startTicker();
    set({ sourceRunning: true });
    appendLog('info', `simulated source started — ${s.scenario} ×${s.speed}`);
  },
  stopSource: () => {
    if (!get().sourceRunning) return;
    simulated?.stop();
    simulated?.removeEventListener('sample', onSampleEvent);
    stopTicker();
    set({ sourceRunning: false });
    appendLog('info', 'source stopped');
  },
  resetProtocol: () => {
    resetEngine();
    if (get().sourceRunning && simulated) {
      simulated.stop();
      simulated.start();
    }
    appendLog('info', 'protocol reset — new baseline');
  },
  setTunables: (t) => {
    const next = { ...get().tunables, ...t };
    set({ tunables: next });
    saveTunables(next);
    // Tunables are fixed for an engine instance; a change starts a new baseline.
    resetEngine();
  },
  resetTunables: () => {
    set({ tunables: { ...DEFAULT_TUNABLES } });
    saveTunables({ ...DEFAULT_TUNABLES });
    resetEngine();
  },

  setOutput: async (m) => {
    const prev = get().output;
    if (m === prev) return;
    if (m !== 'off') {
      if (coherenceEngine.running) {
        stopCoherenceEngine();
        appendLog('info', 'coherence engine stopped — the TPS protocol owns the lens now');
      }
      edgeDevice.resetLensState();
      breathNextBoundary = 0;
    }
    set({ output: m, lastDutySent: null });
    appendLog('info', `glasses output: ${m}`);
    if (m === 'off' && edgeConnected()) {
      try {
        await edgeDevice.setStandaloneStatic(0);
        edgeDevice.resetLensState();
      } catch (err) {
        appendLog('error', `clear lens failed: ${(err as Error).message}`);
      }
    }
  },
  setBreathBpm: (v) => {
    const bpm = Math.min(12, Math.max(3, v));
    set({ breathBpm: bpm });
    saveBreath(bpm, get().inhalePct);
    breathNextBoundary = 0; // re-sync on the next tick
  },
  setInhalePct: (v) => {
    const p = Math.min(70, Math.max(20, Math.round(v)));
    set({ inhalePct: p });
    saveBreath(get().breathBpm, p);
    breathNextBoundary = 0;
  },
}));

/* ---- runner --------------------------------------------------------------- */

let engine = new TpsProtocolEngine(useTpsStore.getState().tunables);
let simulated: SimulatedTpsSource | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;
let breathNextBoundary = 0;
let logId = 0;
const LOG_MAX = 300;

function appendLog(level: TpsLogEntry['level'], message: string): void {
  logId += 1;
  const entry: TpsLogEntry = { id: logId, timestamp: Date.now(), level, message };
  useTpsStore.setState((s) => ({
    log: s.log.length >= LOG_MAX ? [...s.log.slice(s.log.length - LOG_MAX + 1), entry] : [...s.log, entry],
  }));
}

function resetEngine(): void {
  engine = new TpsProtocolEngine(useTpsStore.getState().tunables);
  clearBuffers();
  breathNextBoundary = 0;
  useTpsStore.setState({ frame: null, latest: { ...BLANK_LATEST }, lastDutySent: null });
}

function startTicker(): void {
  if (ticker) return;
  ticker = setInterval(tick, 100);
}
function stopTicker(): void {
  if (ticker) clearInterval(ticker);
  ticker = null;
}

function tick(): void {
  const tS = Date.now() / 1000;
  const f = engine.tick(tS);
  tpsBuffers.frames.push(f.t * 1000, f);
  useTpsStore.setState({ frame: f });
  driveGlasses(f);
}

function edgeConnected(): boolean {
  return useDashboardStore.getState().connection.edge.state === 'connected';
}

function driveGlasses(f: TpsProtocolFrame): void {
  const s = useTpsStore.getState();
  if (s.output === 'off' || !edgeConnected()) return;
  if (s.output === 'biofeedback') {
    // Continuous darkness via the static-tint path (0xA5). The protocol already dead-bands and
    // slew-limits, so a write per change is cheap and the glasses' own EMA smooths the rest.
    if (f.dutyChanged || s.lastDutySent === null) {
      void edgeDevice.streamLensDuty(f.duty);
      useTpsStore.setState({ lastDutySent: f.duty });
    }
    return;
  }
  // Breathing + TPS: the firmware renders the breath wave; we set the inhale-peak darkness
  // (0xA2 depth) once per breath at the cycle boundary — mid-breath depth writes stutter.
  const now = Date.now();
  const cycleMs = Math.round(60000 / s.breathBpm);
  if (breathNextBoundary === 0 || now >= breathNextBoundary) {
    breathNextBoundary = (breathNextBoundary === 0 ? now : breathNextBoundary) + cycleMs;
    if (now >= breathNextBoundary) breathNextBoundary = now + cycleMs; // fell behind (tab throttled)
    void edgeDevice.driveLens({
      style: 'breathingGuide',
      bpm: Math.round(s.breathBpm),
      depthPct: f.duty,
      inhalePct: s.inhalePct,
    });
    void edgeDevice.syncBreath(cycleMs, s.inhalePct);
    useTpsStore.setState({ lastDutySent: f.duty });
  }
}

function onSampleEvent(ev: Event): void {
  const e = (ev as CustomEvent<TpsSampleEvent>).detail;
  const ms = e.t * 1000;
  const latest = { ...useTpsStore.getState().latest };
  switch (e.kind) {
    case 'temp':
      engine.onTemperature(e.v, e.t);
      tpsBuffers.temp.push(ms, e.v);
      latest.tempC = e.v;
      break;
    case 'sc':
      engine.onSkinConductance(e.v, e.t);
      tpsBuffers.sc.push(ms, e.v);
      latest.scUs = e.v;
      break;
    case 'hr':
      engine.onHeartRate(e.v);
      tpsBuffers.hr.push(ms, e.v);
      latest.hr = e.v;
      break;
    case 'beat':
      tpsBuffers.ibi.push(ms, e.ibiMs);
      latest.ibiMs = e.ibiMs;
      break;
    case 'hrv':
      engine.onHrv(e.lfPct, e.lfPower, e.missingS, e.t);
      latest.lfPct = e.lfPct;
      latest.lfPower = e.lfPower;
      latest.vlfPct = e.vlfPct;
      latest.hfPct = e.hfPct;
      latest.hrvMissingS = e.missingS;
      break;
    case 'contact':
      engine.onContact(e.on, e.t);
      latest.contact = e.on;
      break;
    case 'moving':
      engine.onMovement(e.on, e.t);
      latest.moving = e.on;
      break;
  }
  useTpsStore.setState({ latest });
}

/* ---- BLE link → store ------------------------------------------------------ */

tpsDevice.addEventListener('status', (ev) => {
  const status = (ev as CustomEvent<TpsLinkStatus>).detail;
  useTpsStore.setState((s) => ({ link: { ...s.link, status } }));
});
tpsDevice.addEventListener('info', (ev) => {
  const info = (ev as CustomEvent<TpsDeviceInfo>).detail;
  useTpsStore.setState((s) => ({ link: { ...s.link, info } }));
});
tpsDevice.addEventListener('gatt', (ev) => {
  const services = (ev as CustomEvent<TpsGattService[]>).detail;
  useTpsStore.setState((s) => ({ link: { ...s.link, services: services.map((x) => ({ ...x, characteristics: x.characteristics.map((c) => ({ ...c })) })) } }));
});
let statsThrottle = 0;
tpsDevice.addEventListener('stats', (ev) => {
  const now = Date.now();
  if (now - statsThrottle < 250) return;
  statsThrottle = now;
  const stats = { ...(ev as CustomEvent<TpsLinkStats>).detail, sizes: { ...(ev as CustomEvent<TpsLinkStats>).detail.sizes } };
  useTpsStore.setState((s) => ({
    link: {
      ...s.link,
      stats,
      services: tpsDevice.services.map((x) => ({ ...x, characteristics: x.characteristics.map((c) => ({ ...c })) })),
    },
    packets: [...tpsDevice.rawLog],
  }));
});
tpsDevice.addEventListener('log', (ev) => {
  const d = (ev as CustomEvent<TpsLogDetail>).detail;
  appendLog(d.level, d.message);
});
tpsDevice.addEventListener('connected', () => {
  useTpsStore.setState((s) => ({ link: { ...s.link, error: null } }));
});
tpsDevice.addEventListener('disconnected', () => {
  useTpsStore.setState({ packets: [...tpsDevice.rawLog] });
});

/* Keep the frame → glasses path quiet when the glasses drop: the next connect re-sends because
 * edgeDevice.resetLensState() runs on its own reconnect. Nothing to do here but note it. */
