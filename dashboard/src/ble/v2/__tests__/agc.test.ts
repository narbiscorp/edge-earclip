import { describe, it, expect } from 'vitest';
import {
  AGC_RUNS_EMPTY, AGC_RUNS_MAX, PENDING_CONFIRM_MS,
  agcRunsOnLinkLost, agcRunsOnState, agcRunsOnStatus, describeAgcRun, formatAgcSettings,
  gainKnobView, rfLabel, settlePending, statusGainValue, withoutEdit,
  type AgcRunsState, type PendingEdits,
} from '../agc';
import { AGC_ST_ACQUIRE, AGC_ST_LOCKED, AGC_ST_OFF, STF_AGC_FROZEN } from '../protocol';

/* AGC_STATE reason codes (firmware nc_agc_reason_t). */
const START = 0, BEATS = 1, STABLE = 2, WEAR = 5, MANUAL = 6;
const PROTO_1_2 = 0x0102;

const acquire = (s: AgcRunsState, reason: number, atMs: number) =>
  agcRunsOnState(s, { state: AGC_ST_ACQUIRE, reason, atMs });
const locked = (s: AgcRunsState, reason: number, atMs: number) =>
  agcRunsOnState(s, { state: AGC_ST_LOCKED, reason, atMs });
const off = (s: AgcRunsState, atMs: number) =>
  agcRunsOnState(s, { state: AGC_ST_OFF, reason: MANUAL, atMs });

function status(over: Partial<{
  flags: number; ledIrMa: number; ledRedMa: number; tiaGainCode: number; agcState: number;
  timestamp: number;
}> = {}) {
  return {
    flags: 0, ledIrMa: 12, ledRedMa: 8, tiaGainCode: 2, agcState: AGC_ST_LOCKED, timestamp: 0,
    ...over,
  };
}

describe('gain-protocol runs (ACQUIRE -> LOCKED)', () => {
  it('records a run with what started it and the settings from the STATUS after the lock', () => {
    let s = acquire(AGC_RUNS_EMPTY, START, 1_000);
    expect(s.acquiring).toEqual({ startedMs: 1_000, reason: START });
    /* the ladder is still stepping: STATUS mid-acquire is not the result */
    expect(agcRunsOnStatus(s, status({ agcState: AGC_ST_ACQUIRE }))).toBe(s);
    s = locked(s, BEATS, 23_000);
    expect(s.acquiring).toBeNull();
    expect(s.runs).toEqual([{
      id: 1, startedMs: 1_000, startReason: START, lockedMs: 23_000, lockReason: BEATS, settings: null,
    }]);
    expect(s.awaitingSettings).toBe(true);
    s = agcRunsOnStatus(s, status({ ledIrMa: 25, ledRedMa: 20, tiaGainCode: 3 }));
    expect(s.runs[0].settings).toEqual({ irMa: 25, redMa: 20, rfCode: 3 });
    expect(s.awaitingSettings).toBe(false);
    /* later frames never rewrite a finished run */
    expect(agcRunsOnStatus(s, status({ ledIrMa: 30 }))).toBe(s);
  });

  it('keeps every run of the connection, newest last (a manual re-run after the first)', () => {
    let s = locked(acquire(AGC_RUNS_EMPTY, START, 0), BEATS, 20_000);
    s = agcRunsOnStatus(s, status({ ledIrMa: 8, ledRedMa: 5, tiaGainCode: 2 }));
    /* "Run gain protocol": freeze (OFF, manual), unfreeze (ACQUIRE, manual), lock */
    s = acquire(off(s, 60_000), MANUAL, 60_900);
    s = agcRunsOnStatus(locked(s, STABLE, 75_000), status({ ledIrMa: 25, ledRedMa: 20, tiaGainCode: 3 }));
    expect(s.runs.map((r) => [r.id, r.startReason, r.lockReason])).toEqual([
      [1, START, BEATS], [2, MANUAL, STABLE],
    ]);
    expect(formatAgcSettings(s.runs[0].settings!)).toBe('8/5 mA @100k');
    expect(formatAgcSettings(s.runs[1].settings!)).toBe('25/20 mA @50k');
    expect(s.nextId).toBe(3);
  });

  it('ignores a STATUS that raced ahead of the LOCKED event, and one that no longer says LOCKED', () => {
    let s = acquire(AGC_RUNS_EMPTY, START, 0);
    /* firmware pushes STATUS right after the event; it can land first */
    s = agcRunsOnStatus(s, status({ ledIrMa: 25 }));
    s = locked(s, BEATS, 10_000);
    expect(s.runs[0].settings).toBeNull();
    expect(agcRunsOnStatus(s, status({ agcState: AGC_ST_ACQUIRE }))).toBe(s);
    s = agcRunsOnStatus(s, status({ ledIrMa: 25, ledRedMa: 20, tiaGainCode: 3 }));
    expect(s.runs[0].settings).toEqual({ irMa: 25, redMa: 20, rfCode: 3 });
  });

  it('does not count an acquisition that never locked', () => {
    const s = off(acquire(AGC_RUNS_EMPTY, START, 0), 5_000);
    expect(s.runs).toEqual([]);
    expect(s.acquiring).toBeNull();
    expect(s.last).toEqual({ state: AGC_ST_OFF, reason: MANUAL, atMs: 5_000 });
  });

  it('times and names a run from the latest ACQUIRE when one interrupts another', () => {
    const s = locked(acquire(acquire(AGC_RUNS_EMPTY, START, 1_000), WEAR, 5_000), BEATS, 9_000);
    expect(s.runs[0]).toMatchObject({ startedMs: 5_000, startReason: WEAR });
  });

  it('records a lock whose ACQUIRE it never saw, but not a repeated LOCKED', () => {
    let s = locked(AGC_RUNS_EMPTY, STABLE, 3_000);
    expect(s.runs[0]).toMatchObject({ id: 1, startedMs: null, startReason: null, lockReason: STABLE });
    s = locked(s, STABLE, 4_000);
    expect(s.runs).toHaveLength(1);
    expect(s.last?.atMs).toBe(4_000);
  });

  it('leaves the settings unreported when the AGC leaves LOCKED before a STATUS came', () => {
    let s = off(locked(acquire(AGC_RUNS_EMPTY, START, 0), BEATS, 10_000), 10_200);
    s = agcRunsOnStatus(s, status());
    expect(s.runs[0].settings).toBeNull();
    expect(s.awaitingSettings).toBe(false);
  });

  it('keeps completed runs across a link loss but forgets what the AGC was doing', () => {
    let s = agcRunsOnStatus(locked(acquire(AGC_RUNS_EMPTY, START, 0), BEATS, 10_000), status());
    s = agcRunsOnLinkLost(acquire(s, WEAR, 30_000));
    expect(s.runs).toHaveLength(1);
    expect(s.acquiring).toBeNull();
    expect(s.last).toBeNull();
  });

  it('keeps only the newest AGC_RUNS_MAX runs, numbering on', () => {
    let s = AGC_RUNS_EMPTY;
    for (let i = 0; i < AGC_RUNS_MAX + 10; i++) s = locked(acquire(s, START, i * 10), BEATS, i * 10 + 5);
    expect(s.runs).toHaveLength(AGC_RUNS_MAX);
    expect(s.runs[0].id).toBe(11);
    expect(s.nextId).toBe(AGC_RUNS_MAX + 11);
  });

  it('describes a run in one log line', () => {
    let s = acquire(AGC_RUNS_EMPTY, MANUAL, 1_000);
    s = agcRunsOnStatus(locked(s, BEATS, 15_000), status({ ledIrMa: 25, ledRedMa: 20, tiaGainCode: 3 }));
    expect(describeAgcRun(s.runs[0])).toBe('AGC run #1 locked at 25/20 mA @50k (manual -> clean beats, 14.0 s)');
    expect(describeAgcRun(locked(AGC_RUNS_EMPTY, STABLE, 0).runs[0]))
      .toBe('AGC run #1 locked, settings not reported (start not seen -> stable level)');
  });

  it('labels TIA gain codes, which are not monotonic in code order', () => {
    expect(rfLabel(2)).toBe('100k');
    expect(rfLabel(3)).toBe('50k');
    expect(rfLabel(6)).toBe('1M');
    expect(rfLabel(7)).toBe('2M');
    expect(rfLabel(9)).toBe('code 9');
  });
});

describe('what the Signal knobs show', () => {
  it('shows nothing as current before the device has reported', () => {
    const v = gainKnobView(null, PROTO_1_2, null);
    expect(v).toMatchObject({ control: 'waiting', irMa: null, redMa: null, rfCode: null, tone: 'muted' });
  });

  it('shows the device values as set by the AGC, with the lock reason', () => {
    const last = { state: AGC_ST_LOCKED, reason: STABLE, atMs: 1 };
    const v = gainKnobView(status({ ledIrMa: 25, ledRedMa: 20, tiaGainCode: 3 }), PROTO_1_2, last);
    expect(v).toMatchObject({ control: 'agc', irMa: 25, redMa: 20, rfCode: 3, agcState: AGC_ST_LOCKED, tone: 'ok' });
    expect(v.caption).toBe('set by firmware AGC · locked · stable level');
  });

  it('never pins a reason on a state it was not sent with', () => {
    /* STATUS already says LOCKED; the LOCKED event has not arrived yet */
    const last = { state: AGC_ST_ACQUIRE, reason: WEAR, atMs: 1 };
    const v = gainKnobView(status(), PROTO_1_2, last);
    expect(v.reason).toBeNull();
    expect(v.caption).toBe('set by firmware AGC · locked');
    const acq = gainKnobView(status({ agcState: AGC_ST_ACQUIRE }), PROTO_1_2, last);
    expect(acq).toMatchObject({ tone: 'busy', caption: 'set by firmware AGC · adjusting · put on' });
  });

  it('says manual when the device reports the AGC frozen', () => {
    const v = gainKnobView(status({ flags: STF_AGC_FROZEN, agcState: AGC_ST_OFF, ledIrMa: 30 }), PROTO_1_2, null);
    expect(v).toMatchObject({ control: 'manual', tone: 'warn', irMa: 30 });
  });

  it('does not read an AGC state from firmware older than 1.2 (byte 28 reserved)', () => {
    const v = gainKnobView(status({ agcState: AGC_ST_OFF }), 0x0101, null);
    expect(v.agcState).toBeNull();
    expect(v).toMatchObject({ control: 'agc', tone: 'busy' });
    expect(v.caption).toContain('continuous');
  });

  it('is muted when the AGC is off but not frozen (disabled, or stream stopped)', () => {
    expect(gainKnobView(status({ agcState: AGC_ST_OFF }), PROTO_1_2, null).tone).toBe('muted');
  });
});

describe('pending manual edits', () => {
  it('keeps an edit until a STATUS reports the requested value', () => {
    const p: PendingEdits = { ir: { value: 30, ackMs: null } };
    expect(settlePending(p, status({ ledIrMa: 25, timestamp: 1_000 }))).toBe(p);
    expect(settlePending(p, status({ ledIrMa: 30, timestamp: 2_000 }))).toEqual({});
  });

  it('after the ack, lets the device have the last word once the confirm window is over', () => {
    const p: PendingEdits = { red: { value: 20, ackMs: 10_000 }, rf: { value: 3, ackMs: null } };
    /* a frame sent before the write landed: still waiting */
    expect(settlePending(p, status({ ledRedMa: 8, tiaGainCode: 2, timestamp: 10_400 }))).toBe(p);
    /* the device still says 8 a full period later: it clamped / refused / overrode */
    expect(settlePending(p, status({ ledRedMa: 8, tiaGainCode: 2, timestamp: 10_000 + PENDING_CONFIRM_MS })))
      .toEqual({ rf: { value: 3, ackMs: null } });
  });

  it('reads the freeze from the STATUS flags', () => {
    expect(statusGainValue(status({ flags: STF_AGC_FROZEN | 0x08 }), 'frozen')).toBe(1);
    expect(statusGainValue(status({ flags: 0x08 }), 'frozen')).toBe(0);
    const p: PendingEdits = { frozen: { value: 1, ackMs: 5 } };
    expect(settlePending(p, status({ flags: STF_AGC_FROZEN, timestamp: 6 }))).toEqual({});
  });

  it('only copies when something changes', () => {
    const p: PendingEdits = { ir: { value: 1, ackMs: null } };
    expect(withoutEdit(p, 'red')).toBe(p);
    expect(withoutEdit(p, 'ir')).toEqual({});
    expect(p).toEqual({ ir: { value: 1, ackMs: null } });
  });
});
