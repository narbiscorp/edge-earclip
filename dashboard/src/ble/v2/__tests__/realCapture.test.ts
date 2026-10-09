/*
 * Real bytes from a V2.1 board running functest firmware v0.3.0-22, captured
 * over BLE exactly the way the dashboard connects (subscribe CONTROL, STATUS,
 * PPG, IBI, EVENT, ACCEL; then STREAM_START PPG|IBI|EVENT). Every frame must
 * decode with the dashboard's own parsers, so a firmware/dashboard wire drift
 * fails here before it reaches a user. Captured with the clip EMPTY: the
 * firmware flags off-ear + clipping and there are no beats in this sample.
 */
import { describe, it, expect } from 'vitest';
import capture from './fixtures/fw-v0.3.0-22-capture.json';
import {
  OP_STREAM_START, OP_STREAM_STOP, PPGF_WEAR_OFF,
  parseV2Accel, parseV2CtrlResponse, parseV2EventBatch, parseV2Ppg, parseV2Status, ppgPeriodUs,
} from '../protocol';
import { V2LinkStats } from '../linkStats';
import { writeV2PpgRawCSV } from '../../../recording/format';
import type { V2PpgBatchRecord } from '../../../recording/types';

function bytes(hex: string): DataView {
  const b = new Uint8Array(hex.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return new DataView(b.buffer);
}

const frames = (ch: string) =>
  capture.frames.filter((f) => f.ch === ch).map((f) => bytes(f.hex));

describe('real capture — functest firmware v0.3.0-22', () => {
  it('came from the firmware this fixture pins', () => {
    expect(capture.info.fw_rev).toBe('v0.3.0-22-g70d8ad4-dirty');
    expect(capture.info.proto_ver_hex).toBe('0101');
    expect(capture.info.mtu).toBe(247);
  });

  it('answers STREAM_START and STREAM_STOP with OK on the request tid', () => {
    const [start, stop] = frames('control').map(parseV2CtrlResponse);
    expect(start).toMatchObject({ op: OP_STREAM_START, tid: 1, status: 0 });
    expect(stop).toMatchObject({ op: OP_STREAM_STOP, tid: 2, status: 0 });
  });

  it('decodes every PPG batch: contiguous seq, monotonic device clock, ~100 sps', () => {
    const batches = frames('ppg').map(parseV2Ppg);
    const stats = new V2LinkStats();
    for (const b of batches) stats.onPpg(b);
    const s = stats.snapshot();
    expect(batches.length).toBeGreaterThan(100);
    expect(s.ppgLostBatches).toBe(0);
    expect(s.ppgSeqRestarts).toBe(0);
    expect(s.nominalSps).toBe(100);
    /* device clock: this board's AFE runs at 99.43 sps (console "Ts 10057 us") */
    expect(s.measuredSps!).toBeGreaterThan(99);
    expect(s.measuredSps!).toBeLessThan(101);
    for (let i = 1; i < batches.length; i++) {
      expect(batches[i].t0Us).toBeGreaterThan(batches[i - 1].t0Us);
    }
    for (const b of batches) {
      for (const v of [...b.ir, ...b.red]) {
        expect(v).toBeLessThanOrEqual(2_097_151);              /* signed 22-bit */
        expect(v).toBeGreaterThanOrEqual(-2_097_152);
      }
    }
  });

  it('carries the firmware flags an empty clip should raise', () => {
    const batches = frames('ppg').map(parseV2Ppg);
    expect(batches.every((b) => (b.flags & PPGF_WEAR_OFF) !== 0)).toBe(true);
    const stats = new V2LinkStats();
    for (const b of batches) stats.onPpg(b);
    expect(stats.snapshot().clippedBatches).toBeGreaterThan(batches.length / 2);
  });

  it('decodes STATUS frames with sane values and a monotonic uptime', () => {
    /* 1 Hz heartbeat PLUS an immediate frame on state changes (LED/AGC moves),
     * so frames can outnumber elapsed seconds — uptime just never goes back. */
    const st = frames('status').map(parseV2Status);
    expect(st.length).toBeGreaterThan(5);
    for (const s of st) {
      expect(s.ppgRateCode).toBe(1);
      expect(s.battMv).toBeGreaterThan(3000);
      expect(s.battMv).toBeLessThan(4500);
      expect(s.battPct).toBeLessThanOrEqual(100);
    }
    for (let i = 1; i < st.length; i++) {
      expect(st[i].uptimeS).toBeGreaterThanOrEqual(st[i - 1].uptimeS);
    }
    expect(st[st.length - 1].uptimeS).toBeGreaterThan(st[0].uptimeS);
  });

  it('decodes accel (50 Hz, contiguous, no overrun) and only known event layouts', () => {
    const stats = new V2LinkStats();
    for (const a of frames('accel').map(parseV2Accel)) {
      expect(a.odrCode).toBe(2);
      expect(a.x.length).toBeGreaterThan(0);
      stats.onAccel(a);
    }
    expect(stats.snapshot().accelLostBatches).toBe(0);
    expect(stats.snapshot().accelFifoOverruns).toBe(0);
    const events = frames('event').flatMap((f) => parseV2EventBatch(f).events);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.typeName).not.toMatch(/^TYPE_/);
      expect(Object.keys(e.fields).length).toBeGreaterThan(0);  /* length matched EVLEN */
      expect(e.tUs).not.toBeNull();
    }
  });

  it('exports to ppg_raw.csv with exactly one row per sample', () => {
    const batches = frames('ppg').map(parseV2Ppg);
    const rec: V2PpgBatchRecord[] = batches.map((b) => ({
      hostFirstMs: b.t0Us / 1000, periodMs: ppgPeriodUs(b.rateCode) / 1000,
      seq: b.seq, t0Us: b.t0Us, rateCode: b.rateCode, flags: b.flags,
      ir: b.ir, red: b.red, amb: b.amb, ledIrMa: 2, ledRedMa: 2, tiaGainCode: 2,
    }));
    const lines = writeV2PpgRawCSV(rec).trim().split('\n');
    expect(lines.length - 1).toBe(batches.reduce((a, b) => a + b.ir.length, 0));
    expect(lines[1].split(',')[7]).toContain('WEAR_OFF');
  });
});
