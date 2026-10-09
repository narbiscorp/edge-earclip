import { describe, it, expect } from 'vitest';
import { V2LinkStats } from '../linkStats';
import { PPGF_AGC_SETTLING, PPGF_AMB, PPGF_CLIPPED, PPGF_GATE, PPGF_WEAR_OFF } from '../protocol';

/* 100 sps (rate code 1), 10 samples per batch: t0 advances 100 ms/batch. */
function batch(seq: number, k: number, flags = 0, n = 10) {
  return { seq, t0Us: 5_000_000 + k * 100_000, rateCode: 1, flags, ir: new Array(n).fill(0) };
}

describe('V2LinkStats', () => {
  it('counts a contiguous stream with no loss and the exact device-clock rate', () => {
    const s = new V2LinkStats(1);
    for (let k = 0; k < 6; k++) s.onPpg(batch(k, k));
    const snap = s.snapshot();
    expect(snap.since).toBe(1);
    expect(snap.ppgBatches).toBe(6);
    expect(snap.ppgSamples).toBe(60);
    expect(snap.ppgLostBatches).toBe(0);
    expect(snap.ppgSeqRestarts).toBe(0);
    expect(snap.nominalSps).toBe(100);
    expect(snap.measuredSps).toBeCloseTo(100, 6);
  });

  it('counts every missing batch in a seq gap', () => {
    const s = new V2LinkStats();
    s.onPpg(batch(0, 0));
    s.onPpg(batch(1, 1));
    s.onPpg(batch(4, 4));            /* 2 and 3 never arrived */
    s.onPpg(batch(5, 5));
    expect(s.snapshot().ppgLostBatches).toBe(2);
  });

  it('treats seq going back to 0 as a stream restart, not a loss', () => {
    const s = new V2LinkStats();
    s.onPpg(batch(41, 0));
    s.onPpg(batch(42, 1));
    s.onPpg(batch(0, 30));           /* acquisition restarted: seq contract 0 at start */
    s.onPpg(batch(1, 31));
    const snap = s.snapshot();
    expect(snap.ppgSeqRestarts).toBe(1);
    expect(snap.ppgLostBatches).toBe(0);
  });

  it('handles u32 wraparound and ignores a duplicated frame', () => {
    const s = new V2LinkStats();
    s.onPpg(batch(0xffff_fffe, 0));
    s.onPpg(batch(0xffff_ffff, 1));
    s.onPpg(batch(0, 2));            /* wrap, contiguous */
    s.onPpg(batch(0, 2));            /* duplicate — neither loss nor restart */
    s.onPpg(batch(1, 3));
    const snap = s.snapshot();
    expect(snap.ppgLostBatches).toBe(0);
    expect(snap.ppgSeqRestarts).toBe(0);
  });

  it('restarts the rate estimate after a loss so the gap cannot bias it', () => {
    const s = new V2LinkStats();
    s.onPpg(batch(0, 0));
    s.onPpg(batch(1, 1));
    s.onPpg(batch(3, 3));            /* one lost — run restarts here */
    expect(s.snapshot().measuredSps).toBeCloseTo(100, 6);
    s.onPpg(batch(4, 4));
    s.onPpg(batch(5, 5));
    expect(s.snapshot().measuredSps).toBeCloseTo(100, 6);
  });

  it('counts batches by firmware flag', () => {
    const s = new V2LinkStats();
    s.onPpg(batch(0, 0, PPGF_CLIPPED | PPGF_AMB));
    s.onPpg(batch(1, 1, PPGF_AGC_SETTLING));
    s.onPpg(batch(2, 2, PPGF_WEAR_OFF | PPGF_GATE));
    s.onPpg(batch(3, 3, PPGF_CLIPPED));
    const snap = s.snapshot();
    expect(snap.clippedBatches).toBe(2);
    expect(snap.agcSettlingBatches).toBe(1);
    expect(snap.wearOffBatches).toBe(1);
    expect(snap.gatedBatches).toBe(1);
  });

  it('tracks IBI packets, records and lost packets', () => {
    const s = new V2LinkStats();
    s.onIbi(10, 1);
    s.onIbi(11, 2);
    s.onIbi(14, 1);                  /* 12, 13 lost */
    const snap = s.snapshot();
    expect(snap.ibiPackets).toBe(3);
    expect(snap.ibiRecords).toBe(4);
    expect(snap.ibiLostPackets).toBe(2);
  });

  it('keeps the first and latest device counters from STATUS', () => {
    const s = new V2LinkStats();
    s.onStatus({ notifDropCount: 55, i2cErrCount: 2 });
    s.onStatus({ notifDropCount: 58, i2cErrCount: 2 });
    const snap = s.snapshot();
    expect(snap.statusFrames).toBe(2);
    expect(snap.deviceDropsStart).toBe(55);
    expect(snap.deviceDrops).toBe(58);
    expect(snap.i2cErrorsStart).toBe(2);
    expect(snap.i2cErrors).toBe(2);
  });

  it('records decode failures and resets cleanly', () => {
    const s = new V2LinkStats();
    s.onParseError('v2-ppg-parse', 'PPG len 17 != 23');
    s.onPpg(batch(7, 0));
    expect(s.snapshot().parseErrors).toBe(1);
    expect(s.snapshot().lastParseError).toBe('v2-ppg-parse: PPG len 17 != 23');
    s.reset(99);
    s.onPpg(batch(0, 50));            /* after reset there is no "last seq" */
    const snap = s.snapshot();
    expect(snap.since).toBe(99);
    expect(snap.parseErrors).toBe(0);
    expect(snap.ppgSeqRestarts).toBe(0);
    expect(snap.ppgBatches).toBe(1);
  });

  it('tracks accel batches, losses and FIFO overruns', () => {
    const s = new V2LinkStats();
    s.onAccel({ seq: 3, flags: 0, x: [0, 0] });
    s.onAccel({ seq: 4, flags: 0x04, x: [0, 0] });
    s.onAccel({ seq: 7, flags: 0x01, x: [0] });       /* 5, 6 lost */
    const snap = s.snapshot();
    expect(snap.accelBatches).toBe(3);
    expect(snap.accelSamples).toBe(5);
    expect(snap.accelLostBatches).toBe(2);
    expect(snap.accelFifoOverruns).toBe(1);
  });
});
