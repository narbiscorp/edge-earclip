/*
 * V2TuningPanel.tsx — Expert-sidebar tuning for the V2.1 (AFE4404) earclip.
 *
 * Renders nothing unless a V2 board is connected (auto-detected at connect),
 * so the v1 earclip's existing ConfigPanel keeps the sidebar to itself.
 *
 * Three collapsible groups, ordered the way you actually tune a PPG chain:
 *   1. Signal   — what the sensor does: rate, LED currents, TIA gain, AGC.
 *   2. Filtering— what the app does to make the wave readable (host-side).
 *   3. Beats    — what the firmware does to turn the wave into IBIs.
 *
 * The LED / TIA knobs show what the DEVICE reports in STATUS, so they move by
 * themselves when the firmware AGC moves them. A manual edit shows as a
 * pending "→ target" beside the device's value until the device reports it
 * (ble/v2/agc.ts); it is never shown in the device value's place.
 *
 * Device writes are debounced: dragging a slider must not put one CONTROL
 * write per animation frame on a 100 ms BLE connection interval.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getRawSampleRateHz, useDashboardStore } from '../state/store';
import { narbisDevice } from '../ble/narbisDevice';
import {
  KNOB, TIA_RF_OHMS, LED_IR_MAX_MA, LED_RED_MAX_MA,
  AGC_ST_LOCKED, PROTO_VER_AGC_STATE, PROTO_VER_ARTIFACT,
} from '../ble/v2/protocol';
import {
  agcReasonLabel, formatAgcSettings, gainKnobView, rfLabel, sameAgcSettings, settlePending,
  statusGainValue, withoutEdit,
  type AgcRun, type AgcRunsState, type GainField, type GainTone, type PendingEdits,
} from '../ble/v2/agc';
import { mainsAliasesHz, PPG_FILTER_DEFAULTS, type MainsHz } from '../ble/v2/ppgFilter';

const WRITE_DEBOUNCE_MS = 180;
/** "Run gain protocol" stops waiting for the lock after this long. */
const GAIN_RUN_TIMEOUT_MS = 30_000;
/** STATUS is a 1 Hz heartbeat; older than this the knobs are a last report. */
const STATUS_STALE_MS = 3000;
/** How long a knob the device moved by itself shows "(was N)". */
const MOVED_HOLD_MS = 4000;

/* Tailwind needs whole class names in the source, hence the table. Manual
 * keeps the usual indigo thumb: the knobs are yours then, not the AGC's. */
const TONE: Record<GainTone, { text: string; box: string; accent: string }> = {
  muted: { text: 'text-slate-400', box: 'border-slate-800', accent: 'accent-slate-500' },
  ok: { text: 'text-emerald-300', box: 'border-emerald-800/70', accent: 'accent-emerald-500' },
  busy: { text: 'text-amber-300', box: 'border-amber-800/70', accent: 'accent-amber-500' },
  warn: { text: 'text-amber-300', box: 'border-amber-600/60', accent: 'accent-indigo-500' },
};

function Section({
  title, hint, defaultOpen = false, children,
}: {
  title: string; hint?: string; defaultOpen?: boolean; children: React.ReactNode;
}) {
  return (
    <details open={defaultOpen} className="rounded border border-slate-800 bg-slate-900/40">
      <summary className="cursor-pointer select-none px-2 py-1.5 text-[11px] font-medium text-slate-200 hover:bg-slate-800/60">
        {title}
        {hint ? <span className="ml-2 font-normal text-[10px] text-slate-500">{hint}</span> : null}
      </summary>
      <div className="flex flex-col gap-2 px-2 pb-2 pt-1">{children}</div>
    </details>
  );
}

function Slider({
  label, value, min, max, step = 1, unit, onChange, title,
}: {
  label: string; value: number; min: number; max: number; step?: number;
  unit?: string; onChange: (v: number) => void; title?: string;
}) {
  return (
    <label className="block" title={title}>
      <div className="flex items-baseline justify-between text-[10px] text-slate-400">
        <span>{label}</span>
        <span className="font-mono text-slate-200">
          {value}{unit ? ` ${unit}` : ''}
        </span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-indigo-500"
      />
    </label>
  );
}

function Row({ label, children, title }: { label: string; children: React.ReactNode; title?: string }) {
  return (
    <label className="flex items-center justify-between gap-2 text-[10px] text-slate-400" title={title}>
      <span>{label}</span>
      {children}
    </label>
  );
}

/** One link-health cell: value turns amber (or red for `bad`) when non-zero. */
function Health({
  label, value, warn, bad = false, title,
}: { label: string; value: string | number; warn: boolean; bad?: boolean; title: string }) {
  const tone = !warn ? 'text-slate-200' : bad ? 'text-red-400' : 'text-amber-400';
  return (
    <span title={title}>
      {label} <span className={tone}>{value}</span>
    </span>
  );
}

/** Wall clock, re-read every `periodMs` while `on`: report ages, staleness. */
function useNow(periodMs: number, on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), periodMs);
    return () => clearInterval(t);
  }, [periodMs, on]);
  return now;
}

/** The previous value, for `holdMs` after `value` changed (not to / from null). */
function useMoved(value: number | null, holdMs: number): number | null {
  const prev = useRef(value);
  const [was, setWas] = useState<number | null>(null);
  useEffect(() => {
    const p = prev.current;
    prev.current = value;
    if (p === null || value === null || p === value) {
      setWas(null);
      return;
    }
    setWas(p);
    const t = setTimeout(() => setWas(null), holdMs);
    return () => clearTimeout(t);
  }, [value, holdMs]);
  return was;
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
}

function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s} s ago`;
  return s < 3600 ? `${Math.floor(s / 60)} min ago` : `${Math.floor(s / 3600)} h ago`;
}

/** A drive knob showing what the DEVICE reports. An edit the device has not
 * answered yet rides the thumb and reads "device → target"; a move the
 * device made by itself reads "(was N)" for a few seconds. */
function GainSlider({
  label, unit, max, device, pending, accent, dim, disabled, title, onChange,
}: {
  label: string; unit: string; max: number;
  device: number | null; pending: number | null; accent: string; dim: boolean; disabled: boolean;
  title: string; onChange: (v: number) => void;
}) {
  const was = useMoved(device, MOVED_HOLD_MS);
  return (
    <label className={`block ${dim ? 'opacity-60' : ''}`} title={title}>
      <div className="flex items-baseline justify-between text-[10px] text-slate-400">
        <span>{label}</span>
        <span className="font-mono">
          <span className={device === null ? 'text-slate-500' : 'text-slate-100'}>
            {device === null ? '—' : `${device} ${unit}`}
          </span>
          {pending !== null ? <span className="text-amber-300"> → {pending} {unit}</span>
            : was !== null ? <span className="text-slate-500"> (was {was})</span> : null}
        </span>
      </div>
      <input
        type="range" min={0} max={max} step={1} value={pending ?? device ?? 0}
        disabled={disabled || device === null}
        onChange={(e) => onChange(Number(e.target.value))}
        className={`w-full ${accent} disabled:opacity-30`}
      />
    </label>
  );
}

/** TIA gain, with the same device / pending / moved reading as GainSlider. */
function TiaGainSelect({
  device, pending, dim, disabled, onChange,
}: {
  device: number | null; pending: number | null; dim: boolean; disabled: boolean;
  onChange: (code: number) => void;
}) {
  const was = useMoved(device, MOVED_HOLD_MS);
  return (
    <label
      className={`flex items-center justify-between gap-2 text-[10px] text-slate-400 ${dim ? 'opacity-60' : ''}`}
      title="Transimpedance feedback resistor — converts photocurrent to voltage. Raise for a weak signal; lower if the trace clips."
    >
      <span>TIA gain</span>
      <span className="flex items-center gap-1 font-mono">
        {pending !== null && device !== null ? <span className="text-amber-300">{rfLabel(device)}Ω →</span>
          : was !== null ? <span className="text-slate-500">(was {rfLabel(was)}Ω)</span> : null}
        <select
          value={pending ?? device ?? ''}
          disabled={disabled || device === null}
          onChange={(e) => onChange(Number(e.target.value))}
          className="bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-[10px] text-slate-200 disabled:opacity-40"
        >
          {device === null ? <option value="">—</option> : null}
          {Object.keys(TIA_RF_OHMS).map((code) => (
            <option key={code} value={code}>{rfLabel(Number(code))}Ω</option>
          ))}
        </select>
      </span>
    </label>
  );
}

/** Gain-protocol runs on this connection: the newest prominently, beside
 * the settings it replaced; earlier ones as a compact list. */
function GainRuns({
  runs, acquiring, awaitingSettings, lockedUnseen, reacqCount, now,
}: {
  runs: AgcRun[];
  acquiring: AgcRunsState['acquiring'];
  awaitingSettings: boolean;
  /** STATUS says LOCKED, but this connection never saw a run. */
  lockedUnseen: boolean;
  reacqCount: number | null;
  now: number;
}) {
  const newest = runs.length ? runs[runs.length - 1] : null;
  const prev = runs.length > 1 ? runs[runs.length - 2] : null;
  const earlier = runs.slice(0, -1).reverse();
  const trigger = (r: AgcRun) =>
    `${r.startReason !== null ? agcReasonLabel(r.startReason) : '?'} → ${agcReasonLabel(r.lockReason)}` +
    (r.startedMs !== null ? ` · ${Math.round((r.lockedMs - r.startedMs) / 1000)} s` : '');
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between text-[9px] text-slate-500">
        <span className="uppercase tracking-wide">gain protocol runs</span>
        <span title="Runs seen on this connection; the device's own count is re-acquisitions since its stream started.">
          {newest ? newest.id : 0} this connection{reacqCount ? ` · device re-acquired ${reacqCount}×` : ''}
        </span>
      </div>
      {acquiring ? (
        <div className="text-[10px] text-amber-300">
          ● running since {clock(acquiring.startedMs)} ({agcReasonLabel(acquiring.reason)}) — adjusting LED / gain…
        </div>
      ) : null}
      {newest ? (
        <div className="rounded border border-emerald-700/60 bg-emerald-950/30 px-1.5 py-1 text-[10px]">
          <div className="flex justify-between gap-2">
            <span className="text-emerald-300">
              #{newest.id} · {clock(newest.lockedMs)}
              <span className="text-slate-500"> ({ago(newest.lockedMs, now)})</span>
            </span>
            <span className="text-slate-400" title="What started the run → why it locked · how long it took">
              {trigger(newest)}
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 font-mono">
            {prev?.settings ? (
              <span className="text-slate-500" title={`What run #${prev.id} had locked at`}>
                was {formatAgcSettings(prev.settings)} →
              </span>
            ) : null}
            <span className="text-emerald-300" title="LED currents and TIA gain the device reported once locked">
              now {newest.settings ? formatAgcSettings(newest.settings)
                : awaitingSettings ? 'reading…' : 'not reported'}
            </span>
            {prev?.settings && newest.settings && sameAgcSettings(newest.settings, prev.settings)
              ? <span className="text-slate-500">(unchanged)</span> : null}
          </div>
        </div>
      ) : !acquiring ? (
        <div className="text-[10px] text-slate-500">
          {lockedUnseen
            ? 'Locked before this connection saw a run. Run the gain protocol to see what it picks.'
            : 'No run yet.'}
        </div>
      ) : null}
      {earlier.length ? (
        <ul className="flex flex-col font-mono text-[9px] text-slate-500">
          {earlier.slice(0, 6).map((r) => (
            <li key={r.id} className="flex justify-between gap-2">
              <span>#{r.id} {clock(r.lockedMs)} {r.startReason !== null ? agcReasonLabel(r.startReason) : ''}</span>
              <span>{r.settings ? formatAgcSettings(r.settings) : '—'}</span>
            </li>
          ))}
          {earlier.length > 6 ? <li>… {earlier.length - 6} earlier</li> : null}
        </ul>
      ) : null}
    </div>
  );
}

export default function V2TuningPanel() {
  const isV2 = useDashboardStore((s) => s.earclipProtocol === 'v2');
  const st = useDashboardStore((s) => s.v2Status);
  const link = useDashboardStore((s) => s.v2LinkStats);
  const fw = useDashboardStore((s) => s.earclipFirmware);
  const protoVer = useDashboardStore((s) => s.earclipProtoVer);
  const agcRuns = useDashboardStore((s) => s.v2AgcRuns);
  const linkState = useDashboardStore((s) => s.connection.narbis.state);
  const agcKnown = protoVer !== null && protoVer >= PROTO_VER_AGC_STATE;
  const artifactKnown = protoVer !== null && protoVer >= PROTO_VER_ARTIFACT;
  /* Protocol 1.3 (v0.3.0-31) brought the optimizer (agc_mode 2) with it. */
  const optKnown = artifactKnown;
  /* Gain-lock knobs: firmware defaults (v0.3.0-31+) until read from the device. */
  const [lock, setLock] = useState({
    mode: 2, beats: 6, stableS: 8, bandPct: 38, satS: 3, driftS: 15, minS: 180,
    prefIr: 25, prefRed: 20, driftBandK: 500,
  });
  const lockSeeded = useRef(false);
  /* Beat-detector knobs: firmware defaults until read from the device. */
  const [det, setDet] = useState({
    channel: 0, thrFrac: 50, refractMs: 280, ssfWinMs: 80, gateEn: 1, artEn: 1, artTolPct: 15,
  });
  const [detRead, setDetRead] = useState(false);
  const detSeeded = useRef(false);
  const filter = useDashboardStore((s) => s.ppgFilter);
  const setFilter = useDashboardStore((s) => s.setPpgFilter);
  const mainsNotches = mainsAliasesHz(filter.mainsHz, getRawSampleRateHz());

  /* Manual edits the device has not answered yet. The knobs show STATUS;
   * these only add the "→ target" beside it until a STATUS answers. */
  const [pending, setPending] = useState<PendingEdits>({});
  /* "Run gain protocol" in flight. Done when a run numbered above afterId
   * locks; afterId is set once the unfreeze has landed. */
  const [gainRun, setGainRun] = useState<{ since: number; afterId: number | null } | null>(null);
  const [gainRunNote, setGainRunNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const now = useNow(1000, isV2);

  useEffect(() => {
    if (st) setPending((p) => settlePending(p, st));
  }, [st]);
  useEffect(() => {
    if (isV2) return;
    setPending({}); setGainRun(null); setGainRunNote(null);
  }, [isV2]);

  useEffect(() => {
    if (!gainRun || gainRun.afterId === null) return;
    const newest = agcRuns.runs[agcRuns.runs.length - 1];
    if (newest && newest.id > gainRun.afterId) setGainRun(null);
  }, [agcRuns, gainRun]);
  /* A timed-out run that locks later shows up as a run: the note is done. */
  useEffect(() => { setGainRunNote(null); }, [agcRuns.nextId]);
  useEffect(() => {
    if (!gainRun) return;
    const t = setTimeout(() => {
      setGainRun(null);
      setGainRunNote(`No lock within ${GAIN_RUN_TIMEOUT_MS / 1000} s. The AGC may still be adjusting; ` +
        'the run is listed here once it locks.');
    }, Math.max(0, gainRun.since + GAIN_RUN_TIMEOUT_MS - Date.now()));
    return () => clearTimeout(t);
  }, [gainRun]);

  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true); setErr(null);
    try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }, []);

  /** Coalesce rapid slider motion into one device write per key. */
  const debounced = useCallback((key: string, fn: () => Promise<void>) => {
    clearTimeout(timers.current[key]);
    timers.current[key] = setTimeout(() => void run(fn), WRITE_DEBOUNCE_MS);
  }, [run]);

  /** Send one manual write. The caller has marked it pending; the ack
   * starts its confirm window, a failure (of the write or of the freeze in
   * front of it) withdraws it. */
  const sendEdit = useCallback(async (f: GainField, v: number, send: () => Promise<void>) => {
    try {
      await send();
      setPending((p) => (p[f]?.value === v ? { ...p, [f]: { value: v, ackMs: Date.now() } } : p));
    } catch (e) {
      setPending((p) => (p[f]?.value === v ? withoutEdit(p, f) : p));
      throw e;
    }
  }, []);

  /* Manual LED / TIA values only stick while the AGC is frozen (its next
   * step would override them): freeze on the first manual touch rather than
   * making the user find a toggle and wonder why the slider "did nothing".
   * Frozen or not is the device's answer (STATUS), not ours. */
  const ensureFrozen = useCallback(async () => {
    const cur = useDashboardStore.getState().v2Status;
    if (cur && statusGainValue(cur, 'frozen') === 1) return;
    setGainRun(null);                     /* taking manual control ends a run */
    setPending((p) => ({ ...p, frozen: { value: 1, ackMs: null } }));
    await sendEdit('frozen', 1, () => narbisDevice.v2SetAgcFrozen(true));
  }, [sendEdit]);

  /* Read what the device is actually using, once per connection. */
  useEffect(() => {
    if (!isV2 || !agcKnown || lockSeeded.current) return;
    lockSeeded.current = true;
    void (async () => {
      try {
        const g = (id: number) => narbisDevice.v2KnobGet(id);
        const mode = await g(KNOB.AGC_MODE);
        const beats = await g(KNOB.AGC_LOCK_BEATS);
        const stable = await g(KNOB.AGC_LOCK_STABLE_MS);
        const band = await g(KNOB.AGC_LOCK_BAND_PCT);
        const sat = await g(KNOB.AGC_REACQ_SAT_MS);
        const drift = await g(KNOB.AGC_REACQ_DRIFT_MS);
        const min = await g(KNOB.AGC_REACQ_MIN_S);
        setLock((l) => ({
          ...l, mode, beats, stableS: stable / 1000, bandPct: band,
          satS: sat / 1000, driftS: drift / 1000, minS: min,
        }));
        if (!optKnown) return;
        const prefIr = await g(KNOB.AGC_PREF_MA_IR);
        const prefRed = await g(KNOB.AGC_PREF_MA_RED);
        const driftBand = await g(KNOB.AGC_DRIFT_BAND);
        setLock((l) => ({ ...l, prefIr, prefRed, driftBandK: Math.round(driftBand / 1000) }));
      } catch {
        /* keep the defaults shown */
      }
    })();
  }, [isV2, agcKnown, optKnown]);
  useEffect(() => {
    if (!isV2 || protoVer === null || detSeeded.current) return;
    detSeeded.current = true;
    void (async () => {
      try {
        const g = (id: number) => narbisDevice.v2KnobGet(id);
        const channel = await g(KNOB.IBI_CHANNEL);
        const thrFrac = await g(KNOB.THR_FRAC_X100);
        const refractMs = await g(KNOB.REFRACT_MS);
        const ssfWinMs = await g(KNOB.SSF_WIN_MS);
        const gateEn = await g(KNOB.GATE_EN);
        setDet((d) => ({ ...d, channel, thrFrac, refractMs, ssfWinMs, gateEn }));
        if (artifactKnown) {
          const artEn = await g(KNOB.IBI_ART_EN);
          const artTolPct = await g(KNOB.IBI_ART_TOL_PCT);
          setDet((d) => ({ ...d, artEn, artTolPct }));
        }
        setDetRead(true);
      } catch {
        /* keep the defaults shown, marked as such */
      }
    })();
  }, [isV2, protoVer, artifactKnown]);
  useEffect(() => {
    if (isV2) return;
    lockSeeded.current = false;
    detSeeded.current = false;
    setDetRead(false);
  }, [isV2]);

  if (!isV2) return null;

  const knob = (id: number, v: number) => debounced(`k${id}`, () => narbisDevice.v2KnobSet(id, v));

  const view = gainKnobView(st, protoVer, agcRuns.last);
  /* STATUS is "now" only while it keeps coming; otherwise it is the last report. */
  const stale = st !== null && (linkState !== 'connected' || now - st.timestamp > STATUS_STALE_MS);
  /* Inside a run the short freeze is the protocol's, not manual control. */
  const runFreezing = gainRun !== null && view.control === 'manual';
  const tone = TONE[stale ? 'muted' : runFreezing ? 'busy' : view.tone];
  const caption = runFreezing ? 'gain protocol: holding the AGC a moment, then re-acquiring…' : view.caption;
  /** A pending target worth showing: only while it differs from the device. */
  const target = (f: GainField, device: number | null): number | null => {
    const e = pending[f];
    return e && e.value !== device ? e.value : null;
  };
  const frozenDev = st ? statusGainValue(st, 'frozen') : null;
  const frozenTarget = target('frozen', frozenDev);
  const canWrite = st !== null && linkState === 'connected';

  const runGainProtocol = () => {
    setGainRunNote(null);
    setGainRun({ since: Date.now(), afterId: null });
    void run(async () => {
      try {
        await narbisDevice.v2AgcReacquire();
      } catch (e) {
        setGainRun(null);
        throw e;
      }
      /* Unfrozen: the firmware acquires again (reason "manual"), so any run
       * that locks from here on is this one. */
      const { nextId } = useDashboardStore.getState().v2AgcRuns;
      setGainRun((g) => (g ? { ...g, afterId: nextId - 1 } : g));
      setPending((p) => withoutEdit(p, 'frozen'));
    });
  };

  return (
    <div className="rounded border border-slate-800 bg-slate-900/50 p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <div className="text-[12px] font-medium text-slate-200">
            Earclip V2.1 tuning
            <span className="ml-2 text-[9px] font-mono text-emerald-400 align-middle">AFE4404</span>
          </div>
          {fw ? (
            <div className="truncate text-[9px] font-mono text-slate-500" title={`Firmware revision reported by the earclip (Device Information): ${fw}`}>
              fw {fw}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(() => narbisDevice.v2KnobSave())}
          className="text-[10px] rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-50 px-2 py-0.5 text-slate-300"
          title="Persist the device-side knobs to NVS. Without this they revert on reboot."
        >
          save to device
        </button>
      </div>

      {/* Live readout — what the device is ACTUALLY doing (latest STATUS;
          the Signal knobs below show the same frame). */}
      {st ? (
        <div
          className={`grid grid-cols-3 gap-1 text-[9px] font-mono text-slate-400 ${stale ? 'opacity-60' : ''}`}
          title={stale ? `Last report from the earclip, ${ago(st.timestamp, now)}` : undefined}
        >
          <span title="LED currents actually applied by the device">
            IR <span className="text-slate-200">{st.ledIrMa}</span> ·
            RED <span className="text-slate-200">{st.ledRedMa}</span> mA
          </span>
          <span title="Transimpedance gain currently selected">
            RF <span className="text-slate-200">{(TIA_RF_OHMS[st.tiaGainCode] / 1000) || '?'}</span>k
          </span>
          <span title="Heart rate from the device's own beat detector">
            HR <span className="text-slate-200">{st.hrBpm || '—'}</span>
          </span>
          <span title="Percentage of recent time the artifact gate was active">
            gate <span className="text-slate-200">{(st.gateDutyX100 / 100).toFixed(0)}</span>%
          </span>
          {/* Device uptime, not the since-boot drop counter: that one also
              counts drops from earlier clients (see "dev drops" below for
              this connection). A reset uptime means the earclip rebooted. */}
          <span title="Earclip uptime since boot — if this resets, the earclip rebooted">
            up <span className="text-slate-200">
              {st.uptimeS >= 3600
                ? `${Math.floor(st.uptimeS / 3600)}h${String(Math.floor((st.uptimeS % 3600) / 60)).padStart(2, '0')}`
                : `${Math.floor(st.uptimeS / 60)}m${String(st.uptimeS % 60).padStart(2, '0')}`}
            </span>
          </span>
          <span title="Battery">
            {(st.battMv / 1000).toFixed(2)}V <span className="text-slate-200">{st.battPct}%</span>
          </span>
        </div>
      ) : (
        <div className="text-[10px] text-slate-500">waiting for status…</div>
      )}

      {/* Link health since connect — is the data complete and trustworthy? */}
      {link ? (
        <div className="flex flex-col gap-1 rounded border border-slate-800 px-1.5 py-1">
          <div className="text-[9px] uppercase tracking-wide text-slate-500">link health since connect</div>
          <div className="grid grid-cols-3 gap-1 text-[9px] font-mono text-slate-400">
            <Health
              label="lost" value={link.ppgLostBatches} warn={link.ppgLostBatches > 0}
              title={`PPG batches missing between sequence numbers (BLE or device drops). ${link.ppgBatches} received, ${link.ppgSeqRestarts} stream restart(s).`}
            />
            <Health
              label="clipped" value={link.clippedBatches} warn={link.clippedBatches > 0}
              title="Batches the device flagged CLIPPED — the ADC hit full scale (too much light or gain). Lower LED current or TIA gain."
            />
            <Health
              label="rate"
              value={link.measuredSps !== null ? link.measuredSps.toFixed(1) : '—'}
              warn={link.measuredSps !== null && link.nominalSps !== null &&
                Math.abs(link.measuredSps - link.nominalSps) > link.nominalSps * 0.01}
              title={`Sample rate implied by the device's own clock (nominal ${link.nominalSps ?? '?'} sps).`}
            />
            <Health
              label="dev drops"
              value={link.deviceDrops !== null && link.deviceDropsStart !== null
                ? link.deviceDrops - link.deviceDropsStart : '—'}
              warn={link.deviceDrops !== null && link.deviceDropsStart !== null &&
                link.deviceDrops > link.deviceDropsStart}
              title="Notifications the device dropped from its own send queues since connect (any stream, including ones this app does not subscribe to)."
            />
            <Health
              label="decode err" value={link.parseErrors} warn={link.parseErrors > 0} bad
              title={link.lastParseError
                ? `Frames this app could not decode — a dashboard/firmware layout mismatch. Last: ${link.lastParseError}`
                : 'Frames this app could not decode (layout mismatch). Should stay 0.'}
            />
            <Health
              label="i2c err"
              value={link.i2cErrors !== null && link.i2cErrorsStart !== null
                ? link.i2cErrors - link.i2cErrorsStart : '—'}
              warn={link.i2cErrors !== null && link.i2cErrorsStart !== null &&
                link.i2cErrors > link.i2cErrorsStart}
              title="Device I²C errors since connect (sensor bus)."
            />
          </div>
          <div className="text-[9px] leading-snug text-slate-500">
            Raw capture: press <span className="text-slate-300">● Record</span> — the zip's
            <span className="font-mono text-slate-300"> v2/</span> folder holds every sample
            (ir, red, amb, seq, flags), every beat, status frame and device event, plus a
            README and <span className="font-mono text-slate-300">ble_log.txt</span>.
          </div>
        </div>
      ) : null}

      {err ? (
        <div className="rounded border border-red-700/40 bg-red-900/20 px-2 py-1 text-[10px] text-red-300">
          {err}
        </div>
      ) : null}

      {/* ---------------- 1. Signal ---------------- */}
      <Section title="Signal" hint="LED · gain · AGC" defaultOpen>
        <Row label="Sample rate" title="Also sets LED optical duty: the AFE lights each die only during its sampling window, so higher rates are brighter as well as faster.">
          <select
            value={st ? st.ppgRateCode : ''}
            disabled={!st}
            onChange={(e) => void run(async () => {
              const sps = [50, 100, 200, 250, 500][Number(e.target.value)];
              await narbisDevice.v2SetRate(sps);
            })}
            className="bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-[10px] text-slate-200 disabled:opacity-40"
          >
            {!st ? <option value="">—</option> : null}
            {[50, 100, 200, 250, 500].map((sps, code) => (
              <option key={sps} value={code}>{sps} sps</option>
            ))}
          </select>
        </Row>

        {/* Drive state: the knobs show the device's STATUS, so they move by
            themselves while the AGC works. Touching one freezes the AGC
            (manual) and shows "device → target" until the device reports it. */}
        <div className={`flex flex-col gap-2 rounded border px-2 py-1.5 ${tone.box}`}>
          <div
            className={`text-[10px] leading-snug ${tone.text}`}
            title="Who is setting the LED currents and TIA gain right now, as the earclip reports it (STATUS), and why (its last AGC_STATE event)."
          >
            ● {caption}
            {stale && st ? <span className="text-slate-500"> · last report {ago(st.timestamp, now)}</span> : null}
          </div>
          {/* A div, not a Row: a <label> around buttons clicks the first one. */}
          <div className="flex items-center justify-between gap-2 text-[10px] text-slate-400">
            <span className="flex items-center gap-1.5">
              AGC
              <button
                type="button"
                disabled={busy || !canWrite || gainRun !== null}
                onClick={() => {
                  if (frozenDev === null) return;
                  const v = (frozenTarget ?? frozenDev) === 1 ? 0 : 1;
                  setPending((p) => ({ ...p, frozen: { value: v, ackMs: null } }));
                  void run(() => sendEdit('frozen', v, () => narbisDevice.v2SetAgcFrozen(v === 1)));
                }}
                className={`rounded px-2 py-0.5 text-[10px] border disabled:opacity-50 ${
                  frozenDev === 1
                    ? 'border-amber-600/60 bg-amber-900/30 text-amber-300'
                    : 'border-slate-700 bg-slate-800 text-slate-300'
                }`}
                title="As the earclip reports it. Freeze to set the LEDs / gain by hand; resuming re-runs the gain protocol (the AGC re-acquires on unfreeze)."
              >
                {frozenTarget !== null ? (frozenTarget === 1 ? 'freezing…' : 'resuming…')
                  : frozenDev === null ? '—' : frozenDev === 1 ? 'frozen (manual)' : 'running (auto)'}
              </button>
            </span>
            <button
              type="button"
              disabled={busy || !canWrite || gainRun !== null || !agcKnown || lock.mode === 0}
              onClick={runGainProtocol}
              className="rounded border border-emerald-700/60 bg-emerald-900/30 hover:bg-emerald-900/50 disabled:opacity-50 px-2 py-0.5 text-emerald-200"
              title={!agcKnown
                ? 'Needs firmware with the gain lock (protocol 1.2+).'
                : lock.mode === 0
                  ? 'The AGC is in continuous mode (Gain lock → Mode), which never locks.'
                  : 'Re-run the startup gain optimisation now (e.g. after re-seating the clip): the AGC re-acquires LED current and TIA gain, then locks. The result is listed below.'}
            >
              {gainRun ? `running… ${Math.max(0, Math.floor((now - gainRun.since) / 1000))} s` : 'Run gain protocol'}
            </button>
          </div>
          {gainRunNote ? <div className="text-[9px] leading-snug text-amber-400/90">{gainRunNote}</div> : null}
          <GainSlider
            label="IR LED" unit="mA" max={LED_IR_MAX_MA} device={view.irMa}
            pending={target('ir', view.irMa)} accent={tone.accent} dim={stale} disabled={!canWrite}
            title="IR drive current, as the earclip reports it. This is the default channel for beat detection. Dragging freezes the AGC (manual)."
            onChange={(v) => {
              setPending((p) => ({ ...p, ir: { value: v, ackMs: null } }));
              debounced('ir', () => sendEdit('ir', v, async () => {
                await ensureFrozen();
                await narbisDevice.v2SetManual({ irMa: v });
              }));
            }}
          />
          <GainSlider
            label="Red LED" unit="mA" max={LED_RED_MAX_MA} device={view.redMa}
            pending={target('red', view.redMa)} accent={tone.accent} dim={stale} disabled={!canWrite}
            title="Red drive current, as the earclip reports it. Needed for SpO2-style ratio work; not required for beats. Dragging freezes the AGC (manual)."
            onChange={(v) => {
              setPending((p) => ({ ...p, red: { value: v, ackMs: null } }));
              debounced('red', () => sendEdit('red', v, async () => {
                await ensureFrozen();
                await narbisDevice.v2SetManual({ redMa: v });
              }));
            }}
          />
          <TiaGainSelect
            device={view.rfCode} pending={target('rf', view.rfCode)} dim={stale} disabled={!canWrite}
            onChange={(code) => {
              setPending((p) => ({ ...p, rf: { value: code, ackMs: null } }));
              void run(() => sendEdit('rf', code, async () => {
                await ensureFrozen();
                await narbisDevice.v2SetManual({ rfCode: code });
              }));
            }}
          />
        </div>

        {agcKnown ? (
          <GainRuns
            runs={agcRuns.runs} acquiring={agcRuns.acquiring} awaitingSettings={agcRuns.awaitingSettings}
            lockedUnseen={view.agcState === AGC_ST_LOCKED && agcRuns.runs.length === 0 && !agcRuns.acquiring}
            reacqCount={st ? st.agcReacqCount : null} now={now}
          />
        ) : null}
      </Section>

      {/* ---------------- Gain lock (firmware AGC policy) ---------------- */}
      <Section title="Gain lock (AGC)" hint="adjust at first, then hold still" defaultOpen>
        {!agcKnown ? (
          <div className="text-[9px] leading-snug text-amber-400/90">
            This firmware predates the gain lock (protocol{' '}
            {protoVer !== null ? `${protoVer >> 8}.${protoVer & 0xff}` : '?'}): the AGC may step the
            LEDs every couple of seconds. Update to v0.3.0-26 or later.
          </div>
        ) : null}
        <div className="text-[9px] leading-snug text-slate-500">
          Every gain adjustment is a step in the raw signal, so the earclip adjusts only until it
          finds clean beats (or a steady level), then holds. Optimize (the default) solves for the
          LED currents and TIA gain that put the raw level near mid-scale (~1M counts) as soon as
          the clip is on, even before anything connects; once locked it re-runs only after
          sustained clipping or a level drifted past the band below, and never sooner than the
          limit at the bottom. Its live state, the re-run button and each run's result are under
          Signal.
        </div>
        <Row label="Mode" title="Optimize: solve for LED current and gain straight away, then hold. Lock: step toward the band, then hold. Continuous: the old behaviour, adjusts whenever the level leaves the band.">
          <select
            value={lock.mode}
            disabled={!agcKnown}
            onChange={(e) => {
              const v = Number(e.target.value);
              setLock((l) => ({ ...l, mode: v }));
              knob(KNOB.AGC_MODE, v);
            }}
            className="bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-[10px] text-slate-200 disabled:opacity-40"
          >
            {optKnown || lock.mode === 2 ? <option value={2}>optimize, then lock</option> : null}
            <option value={1}>step, then lock</option>
            <option value={0}>continuous (legacy)</option>
            {/* A mode this dashboard has no name for still shows as the
                device's value, not as whichever option happens to be first. */}
            {lock.mode > 2 ? <option value={lock.mode}>mode {lock.mode}</option> : null}
          </select>
        </Row>
        {optKnown && lock.mode === 2 ? (
          <>
            <Slider
              label="Optimize around IR LED" value={lock.prefIr} min={1} max={LED_IR_MAX_MA} unit="mA"
              title="The optimizer picks the TIA gain that lets the IR LED sit closest to this current while the raw level lands on target. Higher = more light, a stronger pulse, more battery."
              onChange={(v) => { setLock((l) => ({ ...l, prefIr: v })); knob(KNOB.AGC_PREF_MA_IR, v); }}
            />
            <Slider
              label="…and red LED" value={lock.prefRed} min={1} max={LED_RED_MAX_MA} unit="mA"
              title="Preferred red current, as for IR."
              onChange={(v) => { setLock((l) => ({ ...l, prefRed: v })); knob(KNOB.AGC_PREF_MA_RED, v); }}
            />
            <Slider
              label="Re-run if the raw level drifts ±" value={lock.driftBandK} min={50} max={1000} step={10} unit="k counts"
              title="While locked, a raw DC inside target ± this is left alone. Outside it for the drift time below, the optimizer runs again, even while beats keep coming."
              onChange={(v) => { setLock((l) => ({ ...l, driftBandK: v })); knob(KNOB.AGC_DRIFT_BAND, v * 1000); }}
            />
          </>
        ) : null}
        <Slider
          label="Lock after clean beats" value={lock.beats} min={1} max={30} unit="beats"
          title="Consecutive clean beats (not gated, not during a gain change, not the first after a gap) that lock the gain."
          onChange={(v) => { setLock((l) => ({ ...l, beats: v })); knob(KNOB.AGC_LOCK_BEATS, v); }}
        />
        <Slider
          label="…or a steady level for" value={lock.stableS} min={1} max={60} unit="s"
          title="Also lock when the level has sat in the target band needing no change this long — covers a pulse too weak for the beat detector."
          onChange={(v) => { setLock((l) => ({ ...l, stableS: v })); knob(KNOB.AGC_LOCK_STABLE_MS, v * 1000); }}
        />
        <Slider
          label="Hold while within" value={lock.bandPct} min={10} max={50} unit="% FS of target"
          title="While locked, a level inside target ± this is left alone. Wider = fewer re-adjustments."
          onChange={(v) => { setLock((l) => ({ ...l, bandPct: v })); knob(KNOB.AGC_LOCK_BAND_PCT, v); }}
        />
        <Slider
          label="Re-adjust after clipping for" value={lock.satS} min={0.5} max={30} step={0.5} unit="s"
          title="Clipped samples are lost data: re-adjust if the ADC stays clipped this long."
          onChange={(v) => { setLock((l) => ({ ...l, satS: v })); knob(KNOB.AGC_REACQ_SAT_MS, Math.round(v * 1000)); }}
        />
        <Slider
          label={lock.mode === 2 ? 'Re-run after drifting for' : 'Re-adjust after drift with no beats for'}
          value={lock.driftS} min={1} max={60} unit="s"
          title={lock.mode === 2
            ? 'Optimize: if the raw level stays outside the drift band this long, run the optimizer again (beats arriving do not prevent it).'
            : 'If the level leaves the hold band AND no clean beats arrive for this long, re-adjust. While beats keep coming it never does.'}
          onChange={(v) => { setLock((l) => ({ ...l, driftS: v })); knob(KNOB.AGC_REACQ_DRIFT_MS, v * 1000); }}
        />
        <Slider
          label="Never re-adjust sooner than" value={lock.minS} min={5} max={600} step={5} unit="s after a lock"
          title="Hard limit on how often the gain may change once locked."
          onChange={(v) => { setLock((l) => ({ ...l, minS: v })); knob(KNOB.AGC_REACQ_MIN_S, v); }}
        />
      </Section>

      {/* ---------------- 2. Filtering (host-side) ---------------- */}
      <Section title="Filtering" hint="app-side · shapes the wave">
        <div className="text-[9px] leading-snug text-slate-500">
          The device streams raw counts: a large DC pedestal with a ~1 % pulse on
          top. These run in the app and produce the Filtered chart.
        </div>
        <Slider
          label="DC removal (high-pass)" value={filter.hpFc} min={0.1} max={2} step={0.05} unit="Hz"
          title="Removes the baseline. Too low leaves wander; too high starts eating the pulse shape."
          onChange={(v) => setFilter({ hpFc: v })}
        />
        <Slider
          label="Band low" value={filter.bpLo} min={0.2} max={2} step={0.05} unit="Hz"
          title="Lowest heart rate to pass. 0.5 Hz = 30 bpm."
          onChange={(v) => setFilter({ bpLo: v })}
        />
        <Slider
          label="Band high" value={filter.bpHi} min={2} max={15} step={0.5} unit="Hz"
          title="Highest frequency kept. 8 Hz keeps the dicrotic notch and rejects the rest."
          onChange={(v) => setFilter({ bpHi: v })}
        />
        <Row
          label="Mains notch"
          title={
            'Removes mains hum (lights, wiring) from the Raw and the Filtered charts. ' +
            'At this sample rate it lands where it folds to: ' +
            (mainsNotches.length > 0 ? mainsNotches.map((f) => `${f.toFixed(0)} Hz`).join(' and ') : 'nothing to notch') +
            '. Display only: recordings keep the raw counts.'
          }
        >
          <select
            value={filter.mainsHz}
            onChange={(e) => setFilter({ mainsHz: Number(e.target.value) as MainsHz })}
            className="bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-[10px] text-slate-200"
          >
            <option value={60}>60 Hz</option>
            <option value={50}>50 Hz</option>
            <option value={0}>Off</option>
          </select>
        </Row>
        <Row label="Invert (peaks up)" title="Transmissive PPG dips when blood absorbs light, so the trace is inverted to look like a normal plethysmogram.">
          <input
            type="checkbox" checked={filter.invert}
            onChange={(e) => setFilter({ invert: e.target.checked })}
            className="accent-indigo-500"
          />
        </Row>
        <button
          type="button"
          onClick={() => setFilter({ ...PPG_FILTER_DEFAULTS, sampleRate: filter.sampleRate })}
          className="self-start text-[10px] rounded bg-slate-800 hover:bg-slate-700 px-2 py-0.5 text-slate-300"
        >
          reset filter defaults
        </button>
      </Section>

      {/* ---------------- 3. Beat detection (device-side) ---------------- */}
      <Section title="Beat detection" hint="on-device → IBI stream">
        <div className="text-[9px] leading-snug text-slate-500">
          The firmware detects beats and streams intervals; these knobs tune that
          detector. Changes are live — press “save to device” to keep them.
          Beats it flags ({artifactKnown
            ? 'gated, during a gain change, or ARTIFACT: an implausible interval'
            : 'gated, or during a gain change'}) are kept, drawn grey on the IBI tachogram and
          left out of HRV.
        </div>
        {!detRead ? (
          <div className="text-[9px] leading-snug text-amber-400/90">
            Showing firmware defaults: the device's own values have not been read yet.
          </div>
        ) : null}
        <Row label="Channel" title="Which LED the beat detector runs on. IR is the default and usually the stronger transmissive signal.">
          <select
            value={det.channel}
            onChange={(e) => {
              const v = Number(e.target.value);
              setDet((d) => ({ ...d, channel: v }));
              knob(KNOB.IBI_CHANNEL, v);
            }}
            className="bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-[10px] text-slate-200"
          >
            <option value={0}>IR</option>
            <option value={1}>Red</option>
          </select>
        </Row>
        <Slider
          label="Threshold fraction" value={det.thrFrac} min={10} max={90} unit="%"
          title="Peak must exceed this fraction of the running peak amplitude. Lower catches weak beats but risks false ones."
          onChange={(v) => { setDet((d) => ({ ...d, thrFrac: v })); knob(KNOB.THR_FRAC_X100, v); }}
        />
        <Slider
          label="Refractory" value={det.refractMs} min={150} max={500} step={10} unit="ms"
          title="Minimum spacing between accepted beats — blocks double-counting the dicrotic notch. 280 ms ≈ 214 bpm ceiling."
          onChange={(v) => { setDet((d) => ({ ...d, refractMs: v })); knob(KNOB.REFRACT_MS, v); }}
        />
        <Slider
          label="Slope window" value={det.ssfWinMs} min={20} max={200} step={5} unit="ms"
          title="Slope-sum window for the systolic upstroke. Widen for slow/soft pulses."
          onChange={(v) => { setDet((d) => ({ ...d, ssfWinMs: v })); knob(KNOB.SSF_WIN_MS, v); }}
        />
        <Row label="Artifact gate" title="Flags beats during motion, clipping or AGC settling (GATED). Leave on unless debugging.">
          <input
            type="checkbox" checked={det.gateEn !== 0}
            onChange={(e) => {
              const v = e.target.checked ? 1 : 0;
              setDet((d) => ({ ...d, gateEn: v }));
              knob(KNOB.GATE_EN, v);
            }}
            className="accent-indigo-500"
          />
        </Row>
        {artifactKnown ? (
          <>
            <Row label="Flag implausible intervals" title="ARTIFACT: an interval far off BOTH the median of the last few accepted beats and the last one (a missed or doubled beat while chewing or talking). Flagged, never dropped; left out of HRV.">
              <input
                type="checkbox" checked={det.artEn !== 0}
                onChange={(e) => {
                  const v = e.target.checked ? 1 : 0;
                  setDet((d) => ({ ...d, artEn: v }));
                  knob(KNOB.IBI_ART_EN, v);
                }}
                className="accent-indigo-500"
              />
            </Row>
            <Slider
              label="…when off by more than" value={det.artTolPct} min={5} max={50} unit="%"
              title="Tolerance for the ARTIFACT check (default 15 %). Lower flags more junk beats but risks flagging real, fast heart-rate changes; an interval has to be off both references to count."
              onChange={(v) => { setDet((d) => ({ ...d, artTolPct: v })); knob(KNOB.IBI_ART_TOL_PCT, v); }}
            />
          </>
        ) : null}
      </Section>
    </div>
  );
}
