import { describe, it, expect } from 'vitest';
import {
  parseV2Ppg, parseV2Ibi, parseV2Status, parseV2CtrlResponse,
  buildAgcManual, buildKnobSet, buildSetRate, parseKnobValue,
  PPG_HDR_SIZE, IBI_HDR_SIZE, IBI_REC_SIZE, STATUS_SIZE, PPGF_AMB,
  LED_IR_MAX_MA, LED_RED_MAX_MA, OP_AGC_MANUAL, OP_KNOB_SET,
} from '../protocol';
import { PpgFilter } from '../ppgFilter';

/* Frames are built here byte-for-byte from the firmware's documented
 * layouts, so a drift between dashboard and firmware fails loudly. */

function ppgFrame(samples: Array<[number, number]>, opts: { rateCode?: number; flags?: number } = {}) {
  const b = new Uint8Array(PPG_HDR_SIZE + samples.length * 8);
  const d = new DataView(b.buffer);
  d.setUint32(0, 7, true);              // seq
  d.setUint32(4, 1_000_000, true);      // t0 lo
  d.setUint32(8, 0, true);              // t0 hi
  d.setUint8(12, opts.rateCode ?? 1);
  d.setUint8(13, samples.length);
  d.setUint8(14, opts.flags ?? 0);
  samples.forEach(([ir, red], i) => {
    d.setInt32(PPG_HDR_SIZE + i * 8, ir, true);
    d.setInt32(PPG_HDR_SIZE + i * 8 + 4, red, true);
  });
  return new DataView(b.buffer);
}

describe('V2 PPG parsing', () => {
  it('decodes a batch without ambient', () => {
    const p = parseV2Ppg(ppgFrame([[1000, -2000], [1001, -2001]]));
    expect(p.seq).toBe(7);
    expect(p.t0Us).toBe(1_000_000);
    expect(p.rateCode).toBe(1);
    expect(p.ir).toEqual([1000, 1001]);
    expect(p.red).toEqual([-2000, -2001]);
    expect(p.amb).toBeNull();
  });

  it('uses the 12-byte stride when the ambient flag is set', () => {
    const n = 2;
    const b = new Uint8Array(PPG_HDR_SIZE + n * 12);
    const d = new DataView(b.buffer);
    d.setUint8(13, n);
    d.setUint8(14, PPGF_AMB);
    for (let i = 0; i < n; i++) {
      d.setInt32(PPG_HDR_SIZE + i * 12, i + 1, true);
      d.setInt32(PPG_HDR_SIZE + i * 12 + 4, 10 * (i + 1), true);
      d.setInt32(PPG_HDR_SIZE + i * 12 + 8, 100 * (i + 1), true);
    }
    const p = parseV2Ppg(new DataView(b.buffer));
    expect(p.ir).toEqual([1, 2]);
    expect(p.amb).toEqual([100, 200]);
  });

  it('rejects a truncated batch rather than returning junk', () => {
    const good = ppgFrame([[1, 2], [3, 4]]);
    const short = new DataView(good.buffer.slice(0, good.byteLength - 4));
    expect(() => parseV2Ppg(short)).toThrow(/PPG len/);
  });
});

describe('V2 IBI parsing', () => {
  it('decodes beat records', () => {
    const n = 2;
    const b = new Uint8Array(IBI_HDR_SIZE + n * IBI_REC_SIZE);
    const d = new DataView(b.buffer);
    d.setUint32(0, 3, true);
    d.setUint8(4, n);
    for (let i = 0; i < n; i++) {
      const off = IBI_HDR_SIZE + i * IBI_REC_SIZE;
      d.setUint32(off, 2_000_000 + i, true);
      d.setUint32(off + 4, 0, true);
      d.setUint16(off + 8, 850 + i, true);
      d.setUint8(off + 10, 90);
      d.setUint8(off + 11, 0);
    }
    const { seq, records } = parseV2Ibi(new DataView(b.buffer));
    expect(seq).toBe(3);
    expect(records).toHaveLength(2);
    expect(records[0].ibiMs).toBe(850);
    expect(records[0].confidence).toBe(90);
    expect(records[1].tBeatUs).toBe(2_000_001);
  });
});

describe('V2 STATUS parsing', () => {
  it('decodes the fields the tuning UI displays', () => {
    const b = new Uint8Array(STATUS_SIZE);
    const d = new DataView(b.buffer);
    d.setUint16(2, 3900, true);   // battMv
    d.setUint8(4, 72);            // battPct
    d.setUint8(5, 1);             // rate code -> 100 sps
    d.setUint8(6, 25);            // IR mA
    d.setUint8(7, 20);            // RED mA
    d.setUint8(8, 2);             // TIA code
    d.setUint32(12, 4, true);     // notify drops
    d.setUint8(26, 61);           // HR
    const s = parseV2Status(new DataView(b.buffer));
    expect(s.battMv).toBe(3900);
    expect(s.battPct).toBe(72);
    expect(s.ledIrMa).toBe(25);
    expect(s.ledRedMa).toBe(20);
    expect(s.tiaGainCode).toBe(2);
    expect(s.notifDropCount).toBe(4);
    expect(s.hrBpm).toBe(61);
  });
});

describe('V2 CONTROL codec', () => {
  it('parses a response envelope and strips the response flag', () => {
    const r = parseV2CtrlResponse(new DataView(new Uint8Array([0x81, 9, 0, 1, 2]).buffer));
    expect(r.op).toBe(0x01);
    expect(r.tid).toBe(9);
    expect(r.status).toBe(0);
    expect(Array.from(r.payload)).toEqual([1, 2]);
  });

  it('clamps LED currents to the hardware ceilings', () => {
    const f = buildAgcManual(999, 999, 2, 3);
    expect(f[0]).toBe(OP_AGC_MANUAL);
    expect(f[2]).toBe(LED_IR_MAX_MA);
    expect(f[3]).toBe(LED_RED_MAX_MA);
  });

  it('round-trips a knob id/value', () => {
    const f = buildKnobSet(0x0605, 280);
    expect(f[0]).toBe(OP_KNOB_SET);
    // KNOB_GET response payload shares the [u16 id][i32 value] layout
    expect(parseKnobValue(f.slice(2))).toEqual({ id: 0x0605, value: 280 });
  });

  it('encodes a rate change', () => {
    expect(Array.from(buildSetRate(4))).toEqual([0x03, 0, 4]);
  });
});

describe('PpgFilter', () => {
  const fs = 100;

  it('removes a large DC pedestal', () => {
    const f = new PpgFilter({ sampleRate: fs });
    let last = 0;
    for (let i = 0; i < fs * 10; i++) last = f.push(1_000_000);
    // A pure DC input must decay to ~0 through the high-pass sections.
    expect(Math.abs(last)).toBeLessThan(1);
  });

  it('passes a 1 Hz pulse (60 bpm) while rejecting 0.05 Hz wander', () => {
    const amp = (freq: number) => {
      const f = new PpgFilter({ sampleRate: fs });
      let peak = 0;
      const n = fs * 40;
      for (let i = 0; i < n; i++) {
        const y = f.push(1_000_000 + 1000 * Math.sin((2 * Math.PI * freq * i) / fs));
        if (i > n / 2) peak = Math.max(peak, Math.abs(y)); // settled half only
      }
      return peak;
    };
    const inBand = amp(1.0);
    const wander = amp(0.05);
    expect(inBand).toBeGreaterThan(500);        // survives the band-pass
    expect(wander).toBeLessThan(inBand * 0.1);  // baseline drift suppressed
  });

  it('inverts so systolic dips become upward peaks', () => {
    const mk = (invert: boolean) => {
      const f = new PpgFilter({ sampleRate: fs, invert });
      let v = 0;
      for (let i = 0; i < fs * 20; i++) {
        v = f.push(1_000_000 - 1000 * Math.sin((2 * Math.PI * 1.0 * i) / fs));
      }
      return v;
    };
    expect(Math.sign(mk(true))).toBe(-Math.sign(mk(false)));
  });

  it('survives a rate change without NaN', () => {
    const f = new PpgFilter({ sampleRate: fs });
    for (let i = 0; i < 100; i++) f.push(1_000_000);
    f.update({ sampleRate: 500 });
    let v = 0;
    for (let i = 0; i < 500; i++) v = f.push(1_000_000);
    expect(Number.isFinite(v)).toBe(true);
  });
});
