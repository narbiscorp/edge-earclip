import { describe, it, expect } from 'vitest';
import { FILE_NAMES, OXIMETER_README, writeOximeterCSV, writeOximeterPlethCSV } from '../format';

describe('reference oximeter in a recording', () => {
  it('writes one row a second, blanks for no reading, the packet kept as hex', () => {
    const csv = writeOximeterCSV([
      { timestamp: 1000, spo2: 97, pulseBpm: 72, respPerMin: 9, piPct: 8, hex: '3e6100480009000000000050' },
      { timestamp: 2000, spo2: null, pulseBpm: null, respPerMin: null, piPct: null, hex: '3e00' },
    ]);
    expect(csv.trim().split('\n')).toEqual([
      'timestamp_ms,spo2_pct,pulse_bpm,resp_per_min,pi_pct,packet_hex',
      '1000,97,72,9,8.0,3e6100480009000000000050',
      '2000,,,,,3e00',
    ]);
  });

  it('writes the pleth one sample a row', () => {
    const csv = writeOximeterPlethCSV([{ timestamp: 1000, values: [12] }, { timestamp: 1042, values: [13, 14] }]);
    expect(csv.trim().split('\n')).toEqual(['timestamp_ms,pleth', '1000,12', '1042,13', '1042,14']);
  });

  it('files them under reference_oximeter/, with a README', () => {
    expect(FILE_NAMES.oximeter).toBe('reference_oximeter/oximeter_1hz.csv');
    expect(FILE_NAMES.oximeterPleth).toBe('reference_oximeter/pleth_24hz.csv');
    expect(OXIMETER_README).toContain('packet_hex');
  });
});
