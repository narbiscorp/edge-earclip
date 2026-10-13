import { describe, it, expect } from 'vitest';
import { OXIMETER_NAME_PREFIXES, OXIMETER_SERVICES, parseOximeterPackets } from '../innovoOximeter';

/** A 13-byte summary as the oximeter sends it: 0x3E, SpO2 @1, pulse @3, breathing @5, PI×10 @11. */
function summary(spo2: number, pulse: number, resp: number, piX10: number): number[] {
  const b = new Array<number>(13).fill(0);
  b[0] = 0x3e;
  b[1] = spo2;
  b[3] = pulse;
  b[5] = resp;
  b[11] = piX10;
  return b;
}

describe('Innovo iP900BP-B packets', () => {
  it('reads a once-a-second summary', () => {
    const p = parseOximeterPackets(new Uint8Array(summary(97, 72, 9, 80)));
    expect(p.readings).toEqual([{ spo2: 97, pulseBpm: 72, respPerMin: 9, piPct: 8 }]);
    expect(p.pleth).toEqual([]);
    expect(p.unknownBytes).toBe(0);
  });

  it('reads an all-zero summary as no reading (no finger)', () => {
    const p = parseOximeterPackets(new Uint8Array(summary(0, 0, 0, 0)));
    expect(p.readings).toEqual([{ spo2: null, pulseBpm: null, respPerMin: null, piPct: null }]);
  });

  it('treats values outside the physiological range as no reading', () => {
    const p = parseOximeterPackets(new Uint8Array(summary(127, 255, 99, 5)));
    expect(p.readings[0].spo2).toBeNull();
    expect(p.readings[0].respPerMin).toBeNull();
    expect(p.readings[0].pulseBpm).toBe(null);
    expect(p.readings[0].piPct).toBeCloseTo(0.5, 6);
  });

  it('reads pleth samples, alone or back to back with a summary', () => {
    expect(parseOximeterPackets(new Uint8Array([0x01, 0x80])).pleth).toEqual([128]);
    const mixed = parseOximeterPackets(new Uint8Array([0x01, 12, 0x01, 200, ...summary(98, 60, 12, 31), 0x01, 0]));
    expect(mixed.pleth).toEqual([12, 200, 0]);
    expect(mixed.readings).toEqual([{ spo2: 98, pulseBpm: 60, respPerMin: 12, piPct: 3.1 }]);
  });

  it('counts what it does not recognise instead of guessing', () => {
    const p = parseOximeterPackets(new Uint8Array([0x3e, 97, 0, 72, 0x55]));   // a short summary
    expect(p.readings).toEqual([]);
    expect(p.unknownBytes).toBe(5);
    expect(parseOximeterPackets(new Uint8Array([0x01])).unknownBytes).toBe(1);
  });

  it('offers the browser the device name and a service list to try', () => {
    expect(OXIMETER_NAME_PREFIXES).toContain('iP900');
    expect(OXIMETER_SERVICES.length).toBeGreaterThan(3);
    expect(OXIMETER_SERVICES).toContain(0x1822);
  });
});
