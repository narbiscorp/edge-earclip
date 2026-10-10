/*
 * agc.ts — what the V2 earclip's automatic gain control is doing, for the
 * tuning panel.
 *
 * Two jobs, both pure (no BLE, no DOM, no React; the store and the panel
 * feed them):
 *   1. Gain-protocol runs. At stream start / put-on the AGC ACQUIREs (steps
 *      LED current and TIA gain toward the target band), then LOCKs and
 *      touches nothing; it re-acquires rarely (clipping, drift, wear,
 *      manual). Each ACQUIRE -> LOCKED is one run, recorded with what started
 *      it and the settings it locked at (from the STATUS after the lock).
 *   2. What the Signal knobs show. Always what the DEVICE reports in STATUS:
 *      the AGC moves the knobs, not the app. A manual edit the device has
 *      not answered yet is a pending target shown beside the device's value,
 *      never in its place.
 */
import {
  AGC_REASON_NAME, AGC_ST_ACQUIRE, AGC_ST_LOCKED, AGC_ST_OFF, PROTO_VER_AGC_STATE,
  STF_AGC_FROZEN, TIA_RF_OHMS,
  type V2Status,
} from './protocol';

/* ------------------------------------------------------------------ */
/* Gain-protocol runs                                                  */
/* ------------------------------------------------------------------ */

/** LED currents and TIA gain as the device reports them in STATUS. */
export interface AgcSettings {
  irMa: number;
  redMa: number;
  /** TIA feedback-resistor code (TIA_RF_OHMS). */
  rfCode: number;
}

/** One completed run: the AGC acquired, then locked. */
export interface AgcRun {
  /** Run number on this connection, from 1. */
  id: number;
  /** Host ms of the ACQUIRE that started it; null when the lock was the
   * first AGC event this connection saw. */
  startedMs: number | null;
  /** Why it started (AGC_REASON_NAME): stream start, put on, clipping,
   * drift, manual, mode change. null with startedMs. */
  startReason: number | null;
  lockedMs: number;
  /** Why it locked: clean beats or a stable level. */
  lockReason: number;
  /** What the first STATUS after the lock reported. Nothing moves while
   * locked, so this is what the run settled on. null until that frame
   * arrives, and for good if the AGC left LOCKED first. */
  settings: AgcSettings | null;
}

export interface AgcRunsState {
  /** Completed runs, oldest first (the newest AGC_RUNS_MAX). */
  runs: AgcRun[];
  /** The acquisition in progress: ACQUIRE seen, no LOCKED yet. */
  acquiring: { startedMs: number; reason: number } | null;
  /** The latest EV_AGC_STATE. A reason code only describes the state it
   * arrived with, so the two travel together. */
  last: { state: number; reason: number; atMs: number } | null;
  /** The newest run still wants its settings from a STATUS. */
  awaitingSettings: boolean;
  nextId: number;
}

export const AGC_RUNS_MAX = 50;

export const AGC_RUNS_EMPTY: AgcRunsState = {
  runs: [], acquiring: null, last: null, awaitingSettings: false, nextId: 1,
};

/** Fold one EV_AGC_STATE into the history. ACQUIRE opens a run, LOCKED
 * closes it; OFF (frozen, AGC disabled, stream stopped) abandons it. Only
 * acquisitions that locked count as runs. */
export function agcRunsOnState(
  s: AgcRunsState, ev: { state: number; reason: number; atMs: number },
): AgcRunsState {
  const last = { state: ev.state, reason: ev.reason, atMs: ev.atMs };
  switch (ev.state) {
    case AGC_ST_ACQUIRE:
      /* An ACQUIRE during an acquisition (e.g. put on) restarts it in the
       * firmware, so the run is timed and named from the latest one. */
      return {
        ...s, last, acquiring: { startedMs: ev.atMs, reason: ev.reason }, awaitingSettings: false,
      };
    case AGC_ST_LOCKED: {
      if (!s.acquiring && s.last?.state === AGC_ST_LOCKED) return { ...s, last };  /* repeat, not a run */
      const run: AgcRun = {
        id: s.nextId,
        startedMs: s.acquiring?.startedMs ?? null,
        startReason: s.acquiring?.reason ?? null,
        lockedMs: ev.atMs,
        lockReason: ev.reason,
        settings: null,
      };
      return {
        runs: [...s.runs, run].slice(-AGC_RUNS_MAX),
        acquiring: null, last, awaitingSettings: true, nextId: s.nextId + 1,
      };
    }
    case AGC_ST_OFF:
      return { ...s, last, acquiring: null, awaitingSettings: false };
    default:
      return { ...s, last };   /* a state this build does not know: leave the run alone */
  }
}

/** Give the newest run its settings: the first STATUS after its LOCKED that
 * still reports LOCKED. The firmware pushes STATUS right after the event,
 * but EVENT and STATUS are separate characteristics and that frame can land
 * first; then the next 1 Hz frame is used (nothing moves while locked).
 * Returns `s` itself when nothing changed. */
export function agcRunsOnStatus(
  s: AgcRunsState, st: Pick<V2Status, 'ledIrMa' | 'ledRedMa' | 'tiaGainCode' | 'agcState'>,
): AgcRunsState {
  const i = s.runs.length - 1;
  if (!s.awaitingSettings || i < 0 || st.agcState !== AGC_ST_LOCKED) return s;
  const runs = s.runs.slice();
  runs[i] = { ...runs[i], settings: { irMa: st.ledIrMa, redMa: st.ledRedMa, rfCode: st.tiaGainCode } };
  return { ...s, runs, awaitingSettings: false };
}

/** The link dropped. Completed runs stay; what the AGC was doing is no
 * longer known (the firmware starts it again with the next stream). */
export function agcRunsOnLinkLost(s: AgcRunsState): AgcRunsState {
  return { ...s, acquiring: null, last: null, awaitingSettings: false };
}

/** "100k", "1M": the TIA feedback resistor for a gain code. */
export function rfLabel(code: number): string {
  const ohms = TIA_RF_OHMS[code];
  if (ohms === undefined) return `code ${code}`;
  return ohms >= 1e6 ? `${ohms / 1e6}M` : `${ohms / 1e3}k`;
}

/** "25/20 mA @50k": IR / red LED current and TIA gain. */
export function formatAgcSettings(s: AgcSettings): string {
  return `${s.irMa}/${s.redMa} mA @${rfLabel(s.rfCode)}`;
}

export function sameAgcSettings(a: AgcSettings, b: AgcSettings): boolean {
  return a.irMa === b.irMa && a.redMa === b.redMa && a.rfCode === b.rfCode;
}

/** An AGC_STATE reason code for display. */
export function agcReasonLabel(reason: number): string {
  return AGC_REASON_NAME[reason] ?? `reason ${reason}`;
}

/** One line per run for the BLE log, so a recording's ble_log.txt says
 * what every run locked at. */
export function describeAgcRun(r: AgcRun): string {
  const start = r.startReason !== null ? agcReasonLabel(r.startReason) : 'start not seen';
  const took = r.startedMs !== null ? `, ${((r.lockedMs - r.startedMs) / 1000).toFixed(1)} s` : '';
  const at = r.settings ? ` at ${formatAgcSettings(r.settings)}` : ', settings not reported';
  return `AGC run #${r.id} locked${at} (${start} -> ${agcReasonLabel(r.lockReason)}${took})`;
}

/* ------------------------------------------------------------------ */
/* What the Signal knobs show                                          */
/* ------------------------------------------------------------------ */

/** Who sets the LEDs / gain right now, per the device. */
export type GainControl = 'waiting' | 'agc' | 'manual';
/** muted: nothing adjusting · ok: AGC locked · busy: AGC adjusting · warn: manual. */
export type GainTone = 'muted' | 'ok' | 'busy' | 'warn';

export interface GainKnobView {
  control: GainControl;
  /** Device-reported drive state; null before the first STATUS. */
  irMa: number | null;
  redMa: number | null;
  rfCode: number | null;
  /** AGC_ST_* from STATUS; null when the firmware predates it (< 1.2). */
  agcState: number | null;
  /** Why the AGC is in agcState, only when the latest AGC_STATE event is for
   * that same state (a reason never outlives its state). */
  reason: number | null;
  /** e.g. "set by firmware AGC · locked · stable level" */
  caption: string;
  tone: GainTone;
}

export function gainKnobView(
  st: Pick<V2Status, 'flags' | 'ledIrMa' | 'ledRedMa' | 'tiaGainCode' | 'agcState'> | null,
  protoVer: number | null,
  last: AgcRunsState['last'],
): GainKnobView {
  if (!st) {
    return {
      control: 'waiting', irMa: null, redMa: null, rfCode: null, agcState: null, reason: null,
      caption: 'waiting for the earclip to report its LED and gain settings…', tone: 'muted',
    };
  }
  /* Below 1.2 STATUS byte 28 is reserved (reads OFF), so it says nothing. */
  const agcState = protoVer !== null && protoVer >= PROTO_VER_AGC_STATE ? st.agcState : null;
  const reason = agcState !== null && last !== null && last.state === agcState ? last.reason : null;
  const v = { irMa: st.ledIrMa, redMa: st.ledRedMa, rfCode: st.tiaGainCode, agcState, reason };
  const why = reason !== null ? ` · ${agcReasonLabel(reason)}` : '';
  if (st.flags & STF_AGC_FROZEN) {
    return {
      ...v, control: 'manual', tone: 'warn',
      caption: 'manual · AGC frozen — the earclip holds what was set by hand',
    };
  }
  if (agcState === null) {
    return {
      ...v, control: 'agc', tone: 'busy',
      caption: 'set by firmware AGC · continuous (this firmware reports no lock)',
    };
  }
  switch (agcState) {
    case AGC_ST_LOCKED:
      return { ...v, control: 'agc', tone: 'ok', caption: `set by firmware AGC · locked${why}` };
    case AGC_ST_ACQUIRE:
      return { ...v, control: 'agc', tone: 'busy', caption: `set by firmware AGC · adjusting${why}` };
    case AGC_ST_OFF:
      return {
        ...v, control: 'agc', tone: 'muted',
        caption: 'AGC off (disabled, or the stream is stopped) — nothing is adjusting',
      };
    default:
      return { ...v, control: 'agc', tone: 'busy', caption: `set by firmware AGC · state ${agcState}` };
  }
}

/** A knob the panel writes. 'frozen' is the AGC freeze (1 = frozen). */
export type GainField = 'ir' | 'red' | 'rf' | 'frozen';

/** A manual write the device has not answered yet. */
export interface PendingEdit {
  value: number;
  /** Host ms the device acknowledged the write; null while in flight. */
  ackMs: number | null;
}
export type PendingEdits = Partial<Record<GainField, PendingEdit>>;

/** After the ack, STATUS gets this long (a full 1 Hz period and change) to
 * show the written value; past that, whatever it reports is the truth:
 * clamped, refused or already overridden. */
export const PENDING_CONFIRM_MS = 1500;

/** The device's own value for a knob. */
export function statusGainValue(
  st: Pick<V2Status, 'flags' | 'ledIrMa' | 'ledRedMa' | 'tiaGainCode'>, f: GainField,
): number {
  switch (f) {
    case 'ir': return st.ledIrMa;
    case 'red': return st.ledRedMa;
    case 'rf': return st.tiaGainCode;
    case 'frozen': return (st.flags & STF_AGC_FROZEN) !== 0 ? 1 : 0;
  }
}

export function withoutEdit(p: PendingEdits, f: GainField): PendingEdits {
  if (p[f] === undefined) return p;
  const out = { ...p };
  delete out[f];
  return out;
}

/** Retire the pending edits a STATUS answers: it reports the requested
 * value, or it arrived PENDING_CONFIRM_MS after the ack and says otherwise.
 * Returns `p` itself when nothing changed. */
export function settlePending(
  p: PendingEdits,
  st: Pick<V2Status, 'flags' | 'ledIrMa' | 'ledRedMa' | 'tiaGainCode'> & { timestamp: number },
): PendingEdits {
  let out = p;
  for (const f of Object.keys(p) as GainField[]) {
    const e = p[f];
    if (!e) continue;
    if (statusGainValue(st, f) === e.value ||
        (e.ackMs !== null && st.timestamp - e.ackMs >= PENDING_CONFIRM_MS)) {
      out = withoutEdit(out, f);
    }
  }
  return out;
}
