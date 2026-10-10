import { describe, it, expect } from 'vitest';
import {
  FILE_NAMES, V2_README,
  writeV2AccelRawCSV, writeV2EventsCSV, writeV2IbiCSV, writeV2LinkStatsJSON, writeV2PpgRawCSV,
  writeV2StatusCSV,
  writeBleLogTxt,
} from '../format';
import type {
  V2EventRecordTimed, V2IbiRecordTimed, V2PpgBatchRecord, V2StatusRecord,
} from '../types';
import { PPGF_AMB, PPGF_CLIPPED } from '../../ble/v2/protocol';

function rows(csv: string): string[][] {
  return csv.trim().split('\n').map((l) => l.split(','));
}

function ppgBatch(over: Partial<V2PpgBatchRecord> = {}): V2PpgBatchRecord {
  return {
    hostFirstMs: 1000, periodMs: 10,
    seq: 4, t0Us: 5_000_000, rateCode: 1, flags: PPGF_AMB | PPGF_CLIPPED,
    ir: [100, 101, 102], red: [-5, -6, -7], amb: [7, 8, 9],
    ledIrMa: 12, ledRedMa: 8, tiaGainCode: 2,
    ...over,
  };
}

function status(over: Partial<V2StatusRecord> = {}): V2StatusRecord {
  return {
    timestamp: 2000, sysState: 3, flags: 0x04, battMv: 4100, battPct: 92, ppgRateCode: 1,
    ledIrMa: 12, ledRedMa: 8, tiaGainCode: 6, tiaCfCode: 1, gateDutyX100: 1250,
    notifDropCount: 3, i2cErrCount: 0, uptimeS: 120, ibiLastMs: 850, hrBpm: 71, btnPressed: 0,
    agcState: 2, agcReacqCount: 1,
    ...over,
  };
}

describe('v2/ppg_raw.csv', () => {
  it('expands each batch to one row per sample with exact device and host times', () => {
    const r = rows(writeV2PpgRawCSV([ppgBatch()]));
    expect(r[0]).toEqual([
      'host_ms', 'dev_us', 'seq', 'i', 'n', 'rate_sps', 'flags', 'flag_names',
      'ir', 'red', 'amb', 'led_ir_ma', 'led_red_ma', 'tia_rf_kohm',
    ]);
    expect(r).toHaveLength(4);
    expect(r[1]).toEqual(['1000.000', '5000000', '4', '0', '3', '100', '0x50', 'AMB|CLIPPED',
      '100', '-5', '7', '12', '8', '100']);
    expect(r[3].slice(0, 4)).toEqual(['1020.000', '5020000', '4', '2']);
    expect(r[3].slice(8, 11)).toEqual(['102', '-7', '9']);
  });

  it('leaves amb and drive state blank when unknown', () => {
    const r = rows(writeV2PpgRawCSV([ppgBatch({
      flags: 0, amb: null, ledIrMa: null, ledRedMa: null, tiaGainCode: null,
    })]));
    expect(r[1].slice(6)).toEqual(['0x00', '', '100', '-5', '', '', '', '']);
  });
});

describe('v2/accel_raw.csv', () => {
  it('writes one row per sample with counts, g, rate and overrun', () => {
    const r = rows(writeV2AccelRawCSV([{
      hostFirstMs: 500, periodMs: 20, seq: 9, t0Us: 3_000_000, odrCode: 2, flags: 0x05,
      x: [500, -250], y: [0, 0], z: [1000, 500],
    }]));
    expect(r[0]).toEqual(['host_ms', 'dev_us', 'seq', 'i', 'n', 'odr_hz', 'fs_g', 'fifo_overrun',
      'x', 'y', 'z', 'x_g', 'y_g', 'z_g']);
    expect(r[1]).toEqual(['500.000', '3000000', '9', '0', '2', '50', '4', 'true',
      '500', '0', '1000', '1.0000', '0.0000', '2.0000']);
    expect(r[2].slice(0, 2)).toEqual(['520.000', '3020000']);
    expect(r[2][11]).toBe('-0.5000');
  });
});

describe('v2 status / ibi / events CSVs', () => {
  it('writes STATUS with decoded rate, RF and gate duty', () => {
    const r = rows(writeV2StatusCSV([status()]));
    expect(r[0][0]).toBe('host_ms');
    const col = (name: string) => r[1][r[0].indexOf(name)];
    expect(col('rate_sps')).toBe('100');
    expect(col('tia_rf_kohm')).toBe('1000');      /* code 6 = 1 MΩ */
    expect(col('gate_duty_pct')).toBe('12.50');
    expect(col('notif_drops')).toBe('3');
    expect(col('flags')).toBe('0x04');
    expect(col('agc_state')).toBe('LOCKED');
    expect(col('agc_reacq_count')).toBe('1');
  });

  it('writes beats with device time, bpm and flag names', () => {
    const ibi: V2IbiRecordTimed = {
      timestamp: 3000.25, seq: 9, tBeatUs: 7_777_000, ibiMs: 800, confidence: 88, flags: 0x04,
    };
    const r = rows(writeV2IbiCSV([ibi]));
    expect(r[1]).toEqual(['3000.250', '7777000', '9', '800', '75.0', '88', '0x04', 'INTERPOLATED']);
  });

  it('names the proto 1.3 ARTIFACT flag in ibi.csv', () => {
    const ibi: V2IbiRecordTimed = {
      timestamp: 3000, seq: 10, tBeatUs: 8_000_000, ibiMs: 1500, confidence: 20, flags: 0x14,
    };
    const r = rows(writeV2IbiCSV([ibi]));
    expect(r[1].slice(6)).toEqual(['0x14', 'INTERPOLATED|ARTIFACT']);
  });

  it('writes events with k=v fields', () => {
    const e: V2EventRecordTimed = {
      timestamp: 4000, arrivalMs: 4050, seq: 2, type: 1, typeName: 'AGC_STEP', tUs: 9_000_000,
      fields: { led: 0, oldMa: 5, newMa: 9 }, rawHex: 'abcd',
    };
    const r = rows(writeV2EventsCSV([e]));
    expect(r[1]).toEqual(['4000.000', '4050', '2', '1', 'AGC_STEP', '9000000', 'led=0;oldMa=5;newMa=9', 'abcd']);
  });
});

describe('v2/link_stats.json', () => {
  it('is recomputed from the recorded data: gaps, flags, rate, counter deltas', () => {
    const batches = [0, 1, 2, 5, 6].map((seq) => ppgBatch({
      seq, t0Us: 5_000_000 + seq * 30_000, hostFirstMs: 1000 + seq * 30,
      flags: seq === 2 ? PPGF_CLIPPED : 0,
    }));
    const ibis: V2IbiRecordTimed[] = [
      { timestamp: 1, seq: 1, tBeatUs: 1, ibiMs: 800, confidence: 90, flags: 0 },
      { timestamp: 2, seq: 1, tBeatUs: 2, ibiMs: 810, confidence: 90, flags: 0 },
      { timestamp: 3, seq: 3, tBeatUs: 3, ibiMs: 820, confidence: 90, flags: 0 },
    ];
    const json = JSON.parse(writeV2LinkStatsJSON({
      fwVersion: 'v0.3.0-22-g70d8ad4-dirty',
      batches, ibis,
      statuses: [status({ notifDropCount: 10 }), status({ notifDropCount: 13 })],
      events: [],
    }));
    expect(json.firmware).toBe('v0.3.0-22-g70d8ad4-dirty');
    expect(json.ppg_batches).toBe(5);
    expect(json.ppg_samples).toBe(15);
    expect(json.ppg_lost_batches).toBe(2);
    expect(json.clipped_batches).toBe(1);
    expect(json.measured_sps_device_clock).toBeCloseTo(100, 3);
    expect(json.ibi_packets).toBe(2);
    expect(json.ibi_records).toBe(3);
    expect(json.ibi_lost_packets).toBe(1);
    expect(json.device_notif_drops_delta).toBe(3);
    expect(json.duration_s).toBeCloseTo((6 * 30 + 20) / 1000, 6);
  });

  it('copes with an empty capture', () => {
    const json = JSON.parse(writeV2LinkStatsJSON({
      fwVersion: null, batches: [], ibis: [], statuses: [], events: [],
    }));
    expect(json.ppg_batches).toBe(0);
    expect(json.duration_s).toBe(0);
    expect(json.measured_sps_device_clock).toBeNull();
  });
});

describe('capture bundle docs', () => {
  it('documents every V2 file the export writes', () => {
    for (const f of [FILE_NAMES.v2PpgRaw, FILE_NAMES.v2AccelRaw, FILE_NAMES.v2Status, FILE_NAMES.v2Ibi,
      FILE_NAMES.v2Events, FILE_NAMES.v2LinkStats]) {
      expect(V2_README).toContain(f.replace('v2/', ''));
    }
    expect(V2_README).toContain('ble_log.txt');
  });

  it('documents every ibi.csv flag, including ARTIFACT', () => {
    for (const f of ['GATED', 'AGC_SETTLING', 'INTERPOLATED', 'FIRST_AFTER_GAP', 'ARTIFACT']) {
      expect(V2_README).toContain(f);
    }
  });

  it('writes the BLE log one line per entry', () => {
    const txt = writeBleLogTxt([
      { timestamp: Date.UTC(2026, 9, 9, 7, 0, 0), source: 'earclip', level: 'warn', message: 'PPG: 1 batch(es) lost' },
    ]);
    expect(txt).toBe('2026-10-09T07:00:00.000Z [earclip] WARN PPG: 1 batch(es) lost\n');
  });
});
