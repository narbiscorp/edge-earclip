import { describe, it, expect } from 'vitest';
import {
  parseV2Ppg, parseV2Ibi, parseV2Status, parseV2CtrlResponse,
  buildAgcManual, buildKnobSet, buildSetRate, parseKnobValue,
  PPG_HDR_SIZE, IBI_HDR_SIZE, IBI_REC_SIZE, STATUS_SIZE, PPGF_AMB,
  LED_IR_MAX_MA, LED_RED_MAX_MA, OP_AGC_MANUAL, OP_KNOB_SET,
  parseV2EventBatch, ppgNewestUs, ppgSampleUs, ppgPeriodUs, ppgFlagNames, ibiFlagNames,
  EV_AGC_STEP, EV_AGC_STATE, EV_MARKER, EVENT_HDR_SIZE, PPGF_AGC_SETTLING, PPGF_CLIPPED,
  IBIF_GATED, IBIF_INTERPOLATED, IBIF_FIRST_AFTER_GAP, IBIF_ARTIFACT, PROTO_VER_ARTIFACT,
  IBIF_MOTION, PPGF_MOTION, PROTO_VER_MOTION,
  AGC_ST_LOCKED, AGC_REASON_NAME, STF_AGC_FROZEN,
  parseV2Accel, accelPeriodUs, accelCountsPerG, ACCF_FS_MASK, ACCF_FIFO_OVERRUN,
} from '../protocol';
import { MainsNotch, PpgFilter, mainsAliasesHz } from '../ppgFilter';

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

  it('keeps the proto 1.3 ARTIFACT bit with the beat (flagged, never dropped)', () => {
    const b = new Uint8Array(IBI_HDR_SIZE + IBI_REC_SIZE);
    const d = new DataView(b.buffer);
    d.setUint8(4, 1);
    d.setUint16(IBI_HDR_SIZE + 8, 1510, true);       /* a missed-beat span */
    d.setUint8(IBI_HDR_SIZE + 10, 20);               /* confidence capped on ARTIFACT */
    d.setUint8(IBI_HDR_SIZE + 11, IBIF_INTERPOLATED | IBIF_ARTIFACT);
    const [r] = parseV2Ibi(new DataView(b.buffer)).records;
    expect(r.ibiMs).toBe(1510);
    expect(r.flags).toBe(0x14);
    expect(ibiFlagNames(r.flags)).toBe('INTERPOLATED|ARTIFACT');
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

  it('decodes the AGC fields the gain panel reads: frozen flag, state, re-acquire count', () => {
    const b = new Uint8Array(STATUS_SIZE);
    const d = new DataView(b.buffer);
    d.setUint8(1, STF_AGC_FROZEN | 0x08);   /* frozen + worn */
    d.setUint8(28, AGC_ST_LOCKED);
    d.setUint8(29, 3);
    const s = parseV2Status(new DataView(b.buffer));
    expect(s.flags & STF_AGC_FROZEN).toBe(STF_AGC_FROZEN);
    expect(s.agcState).toBe(AGC_ST_LOCKED);
    expect(s.agcReacqCount).toBe(3);
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

/* Mains hum on the raw counts (lights: "tons of 60 Hz", 2026-10-12). At ~100 sps nothing above
 * 50 Hz exists, so the hum arrives folded — and that is where the notch has to be. */
describe('mains notch', () => {
  it('sits where mains folds to: 60 Hz at 100 sps -> 20 and 40 Hz, 50 Hz -> just under Nyquist', () => {
    expect(mainsAliasesHz(60, 100)).toEqual([20, 40]);
    expect(mainsAliasesHz(50, 100)).toEqual([49.5]);
    expect(mainsAliasesHz(60, 200)).toEqual([20, 40, 60, 80]);
    expect(mainsAliasesHz(0, 100)).toEqual([]);
  });

  /** Amplitude of [f] in [xs] (single-bin DFT; whole cycles over the span). */
  const amp = (xs: number[], f: number, fs: number) => {
    let re = 0, im = 0;
    xs.forEach((v, i) => {
      re += v * Math.cos((2 * Math.PI * f * i) / fs);
      im += v * Math.sin((2 * Math.PI * f * i) / fs);
    });
    return (2 * Math.hypot(re, im)) / xs.length;
  };

  it('takes the hum off the raw counts and leaves the pedestal and the pulse', () => {
    const fs = 100;
    const n = fs * 20;
    const notch = new MainsNotch(60, fs);
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = i / fs;
      out.push(notch.step(
        1_100_000 + 1_000 * Math.sin(2 * Math.PI * 1.2 * t)
          + 20_000 * Math.sin(2 * Math.PI * 20 * t) + 8_000 * Math.sin(2 * Math.PI * 40 * t),
      ));
    }
    const settled = out.slice(n / 2);
    expect(amp(settled, 20, fs)).toBeLessThan(20_000 * 0.01); // > 40 dB down
    expect(amp(settled, 40, fs)).toBeLessThan(8_000 * 0.01);
    expect(amp(settled, 1.2, fs)).toBeGreaterThan(1_000 * 0.97); // the pulse untouched
    const mean = settled.reduce((a, b) => a + b, 0) / settled.length;
    expect(Math.abs(mean - 1_100_000)).toBeLessThan(50); // the pedestal passes
  });

  it('primes on the first sample, so a pedestal does not ring at the left edge', () => {
    const notch = new MainsNotch(60, 100);
    for (let i = 0; i < 50; i++) expect(notch.step(1_100_000)).toBeCloseTo(1_100_000, 6);
  });

  it('off passes samples through untouched', () => {
    const notch = new MainsNotch(0, 100);
    expect(notch.notchesHz).toEqual([]);
    expect(notch.step(123_456)).toBe(123_456);
  });

  it('runs in the filtered chain too, and the default is 60 Hz', () => {
    const f = new PpgFilter({ sampleRate: 100, bpHi: 15 });
    expect(f.config.mainsHz).toBe(60);
    const off = new PpgFilter({ sampleRate: 100, bpHi: 15, mainsHz: 0 });
    const hum = (pf: PpgFilter) => {
      const ys: number[] = [];
      for (let i = 0; i < 2000; i++) ys.push(pf.push(1_000_000 + 5_000 * Math.sin((2 * Math.PI * 20 * i) / 100)));
      return amp(ys.slice(1000), 20, 100);
    };
    expect(hum(f)).toBeLessThan(hum(off) * 0.05);
  });
});

describe('V2 PPG sample timing', () => {
  /* firmware nc_ppg_batch_add stamps t0 on the FIRST sample of a batch */
  const b = { t0Us: 1_000_000, rateCode: 1, ir: new Array(10).fill(0) };

  it('places each sample one period after the previous, from t0', () => {
    expect(ppgPeriodUs(1)).toBe(10_000);
    expect(ppgPeriodUs(4)).toBe(2_000);
    expect(ppgSampleUs(b, 0)).toBe(1_000_000);
    expect(ppgSampleUs(b, 3)).toBe(1_030_000);
  });

  it('reports the NEWEST sample time, which downstream treats as the batch stamp', () => {
    expect(ppgNewestUs(b)).toBe(1_090_000);
    expect(ppgNewestUs({ ...b, ir: [0] })).toBe(1_000_000);
  });

  it('names flag bits', () => {
    expect(ppgFlagNames(PPGF_AGC_SETTLING | PPGF_AMB | PPGF_CLIPPED)).toBe('AGC_SETTLING|AMB|CLIPPED');
    expect(ppgFlagNames(0)).toBe('');
    expect(ibiFlagNames(IBIF_INTERPOLATED | IBIF_FIRST_AFTER_GAP)).toBe('INTERPOLATED|FIRST_AFTER_GAP');
    expect(ibiFlagNames(IBIF_GATED | IBIF_ARTIFACT)).toBe('GATED|ARTIFACT');
  });

  it('pins the proto 1.3 ARTIFACT bit to the firmware value (NC_IBIF_ARTIFACT = 1 << 4)', () => {
    expect(IBIF_ARTIFACT).toBe(0x10);
    expect(PROTO_VER_ARTIFACT).toBe(0x0103);
    expect(ibiFlagNames(0x10)).toBe('ARTIFACT');
  });

  it('pins the proto 1.4 MOTION bits to the firmware values (NC_IBIF_MOTION = 1 << 5, NC_PPGF_MOTION = 1 << 7)', () => {
    expect(IBIF_MOTION).toBe(0x20);
    expect(PPGF_MOTION).toBe(0x80);
    expect(PROTO_VER_MOTION).toBe(0x0104);
    expect(ibiFlagNames(IBIF_INTERPOLATED | IBIF_MOTION)).toBe('INTERPOLATED|MOTION');
    expect(ppgFlagNames(PPGF_MOTION)).toBe('MOTION');
  });
});

/* EVENT batch per proto.h: [u32 seq][u8 n] + n × {u8 type, u8 len, payload};
 * every payload starts with a u64 device time. */
function eventFrame(seq: number, recs: Array<{ type: number; payload: number[] }>) {
  const len = EVENT_HDR_SIZE + recs.reduce((a, r) => a + 2 + r.payload.length, 0);
  const b = new Uint8Array(len);
  const d = new DataView(b.buffer);
  d.setUint32(0, seq, true);
  d.setUint8(4, recs.length);
  let off = EVENT_HDR_SIZE;
  for (const r of recs) {
    b[off] = r.type; b[off + 1] = r.payload.length;
    b.set(r.payload, off + 2);
    off += 2 + r.payload.length;
  }
  return new DataView(b.buffer);
}

function u64le(v: number): number[] {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setUint32(0, v >>> 0, true);
  new DataView(out.buffer).setUint32(4, Math.floor(v / 4294967296), true);
  return [...out];
}

describe('V2 EVENT parsing', () => {
  it('decodes an AGC step and a marker, keeping device time and raw bytes', () => {
    const agc = [...u64le(12_345_678), 0, 5, 9, 2, 3];            /* 13 bytes */
    const marker = [...u64le(20_000_000), 1, 0x34, 0x12];          /* 11 bytes */
    const { seq, events } = parseV2EventBatch(eventFrame(77, [
      { type: EV_AGC_STEP, payload: agc },
      { type: EV_MARKER, payload: marker },
    ]));
    expect(seq).toBe(77);
    expect(events).toHaveLength(2);
    expect(events[0].typeName).toBe('AGC_STEP');
    expect(events[0].tUs).toBe(12_345_678);
    expect(events[0].fields).toEqual({ led: 0, oldMa: 5, newMa: 9, oldRf: 2, newRf: 3 });
    expect(events[1].typeName).toBe('MARKER');
    expect(events[1].fields).toEqual({ source: 1, markerId: 0x1234 });
    expect(events[1].rawHex.startsWith('002d3101')).toBe(true);   /* 20e6 LE */
  });

  it('decodes an AGC_STATE transition (proto 1.2): state, reason, re-acquire count', () => {
    const { events } = parseV2EventBatch(eventFrame(5, [
      { type: EV_AGC_STATE, payload: [...u64le(30_000_000), AGC_ST_LOCKED, 1, 2] },   /* 11 bytes */
    ]));
    expect(events[0].typeName).toBe('AGC_STATE');
    expect(events[0].fields).toEqual({ state: AGC_ST_LOCKED, reason: 1, reacqCount: 2 });
    expect(AGC_REASON_NAME[events[0].fields.reason]).toBe('clean beats');
    expect(AGC_REASON_NAME[6]).toBe('manual');            /* firmware NC_AGC_RSN_MANUAL */
  });

  it('keeps an unknown or mis-sized record as raw bytes instead of guessing', () => {
    const { events } = parseV2EventBatch(eventFrame(1, [
      { type: 99, payload: [1, 2, 3] },
      { type: EV_AGC_STEP, payload: [...u64le(1), 0] },            /* wrong length */
    ]));
    expect(events[0].typeName).toBe('TYPE_99');
    expect(events[0].tUs).toBeNull();
    expect(events[0].rawHex).toBe('010203');
    expect(events[1].fields).toEqual({});
    expect(events[1].tUs).toBe(1);
  });

  it('rejects truncated and over-long batches', () => {
    const good = eventFrame(1, [{ type: EV_MARKER, payload: [...u64le(5), 0, 1, 0] }]);
    expect(() => parseV2EventBatch(new DataView(good.buffer.slice(0, good.byteLength - 2))))
      .toThrow(/truncated/);
    const long = new Uint8Array(good.byteLength + 1);
    long.set(new Uint8Array(good.buffer));
    expect(() => parseV2EventBatch(new DataView(long.buffer))).toThrow(/trailing/);
  });
});

describe('V2 ACCEL parsing', () => {
  /* [u32 seq][u64 t0_us][u8 odr][u8 n][u8 flags] + n × {i16 x, y, z} */
  function accelFrame(samples: Array<[number, number, number]>, flags: number) {
    const b = new Uint8Array(15 + samples.length * 6);
    const d = new DataView(b.buffer);
    d.setUint32(0, 12, true);
    d.setUint32(4, 3_000_000, true);
    d.setUint8(12, 2);                       /* 50 Hz */
    d.setUint8(13, samples.length);
    d.setUint8(14, flags);
    samples.forEach(([x, y, z], i) => {
      d.setInt16(15 + i * 6, x, true);
      d.setInt16(15 + i * 6 + 2, y, true);
      d.setInt16(15 + i * 6 + 4, z, true);
    });
    return new DataView(b.buffer);
  }

  it('decodes axes, rate and the fs / overrun flags', () => {
    const a = parseV2Accel(accelFrame([[500, -500, 1000], [1, 2, 3]], 0x05));
    expect(a.seq).toBe(12);
    expect(a.t0Us).toBe(3_000_000);
    expect(a.x).toEqual([500, 1]);
    expect(a.y).toEqual([-500, 2]);
    expect(a.z).toEqual([1000, 3]);
    expect(a.flags & ACCF_FS_MASK).toBe(1);
    expect(a.flags & ACCF_FIFO_OVERRUN).toBe(ACCF_FIFO_OVERRUN);
    expect(accelPeriodUs(a.odrCode)).toBe(20_000);
    expect(accelCountsPerG(1)).toBe(500);    /* ±4 g, 2 mg/digit */
  });

  it('rejects a length that does not match n', () => {
    const good = accelFrame([[1, 2, 3]], 0);
    expect(() => parseV2Accel(new DataView(good.buffer.slice(0, good.byteLength - 1))))
      .toThrow(/ACCEL len/);
  });
});
