import { describe, expect, it } from 'vitest';
import { SessionLog, type MetricRow } from '../log';
import { writeAccCSV, writeBeatsCSV, writeMetricsCSV, writeManifestJSON } from '../csv';

const T0 = 1_700_000_000_000;

function emptyRow(t: number, over: Partial<MetricRow> = {}): MetricRow {
  return {
    t,
    beatCount: 0,
    windowSec: 64,
    meanHr: null,
    sdnn: null,
    rmssd: null,
    pnn50: null,
    lf: null,
    hf: null,
    lfHfRatio: null,
    totalPower: null,
    engineCoherence: null,
    engineCr: null,
    engineRespHz: null,
    enginePacerBpm: null,
    breathHeartCoherence: null,
    breathHeartPhaseDeg: null,
    accRespBpm: null,
    accRespConfidence: null,
    hmCoherence: null,
    resonanceCoherence: null,
    resonanceFreqHz: null,
    firmwareCoherence: null,
    firmwareRespHz: null,
    ...over,
  };
}

describe('SessionLog beats', () => {
  it('starts empty and reports no start time', () => {
    const log = new SessionLog();
    expect(log.isEmpty).toBe(true);
    expect(log.startedAt).toBeNull();
    expect(log.durationMs).toBe(0);
  });

  it('windows by time and keeps only the requested source', () => {
    const log = new SessionLog();
    log.addBeat(T0, 900, 66, 'h10', false);
    log.addBeat(T0 + 1000, 910, 66, 'earclip', false);
    log.addBeat(T0 + 2000, 920, 65, 'h10', false);

    const now = T0 + 2500;
    expect(log.beatWindow(10, now, 'h10', false).y).toEqual([900, 920]);
    expect(log.beatWindow(10, now, 'earclip', false).y).toEqual([910]);
    expect(log.beatWindow(10, now, 'both', false).y).toEqual([900, 910, 920]);
    // A 1 second window should only reach the newest beat.
    expect(log.beatWindow(1, now, 'both', false).y).toEqual([920]);
  });

  it('excludes flagged beats from the series but keeps them in the log', () => {
    const log = new SessionLog();
    log.addBeat(T0, 900, 66, 'h10', false);
    log.addBeat(T0 + 1000, 120, 500, 'h10', true); // implausible → flagged
    log.addBeat(T0 + 2000, 910, 66, 'h10', false);

    const now = T0 + 2500;
    expect(log.beatWindow(10, now, 'h10', false).y).toEqual([900, 910]);
    expect(log.beatWindow(10, now, 'h10', true).y).toEqual([900, 120, 910]);
    expect(log.artifactWindow(10, now, 'h10').y).toEqual([120]);
    expect(log.beatCount).toBe(3); // nothing was dropped
  });

  it('does not clip a beat at the window edge when two clocks interleave', () => {
    // The earclip beat is appended after the H10 beat but timestamped 5 ms
    // earlier, so the column is only nearly sorted. A plain binary search
    // starts late here and loses the H10 beat.
    const log = new SessionLog();
    const now = T0 + 10_000;
    const from = now - 5_000;
    log.addBeat(from + 2, 900, 66, 'h10', false);
    log.addBeat(from - 3, 880, 68, 'earclip', false);
    log.addBeat(from + 500, 905, 66, 'h10', false);

    expect(log.beatWindow(5, now, 'h10', false).y).toEqual([900, 905]);
  });

  it('builds an analysis window with aligned, artifact-free arrays', () => {
    const log = new SessionLog();
    log.addBeat(T0, 900, 66, 'h10', false);
    log.addBeat(T0 + 900, 100, 600, 'h10', true);
    log.addBeat(T0 + 1800, 910, 66, 'h10', false);
    log.addBeat(T0 + 2700, 905, 66, 'earclip', false);

    const w = log.analysisWindow(60, T0 + 3000, 'h10');
    expect(Array.from(w.ibis_ms)).toEqual([900, 910]);
    expect(Array.from(w.beat_ms)).toEqual([T0, T0 + 1800]);
    // times_s is absolute epoch seconds, matching metrics/windowing.ts.
    expect(Array.from(w.times_s)).toEqual([T0 / 1000, (T0 + 1800) / 1000]);
    expect(w.times_s.length).toBe(w.ibis_ms.length);
  });
});

describe('SessionLog accelerometer', () => {
  it('spaces a block backwards from the newest sample', () => {
    const log = new SessionLog();
    log.addAccBlock(
      [
        { x: 1, y: 2, z: 3 },
        { x: 4, y: 5, z: 6 },
        { x: 7, y: 8, z: 9 },
      ],
      T0,
      50, // 20 ms spacing
    );
    expect(log.acc.t).toEqual([T0 - 40, T0 - 20, T0]);
    expect(log.acc.x).toEqual([1, 4, 7]);
  });

  it('computes the vector magnitude for the mag axis', () => {
    const log = new SessionLog();
    log.addAccBlock([{ x: 3, y: 4, z: 0 }], T0, 50);
    const w = log.accWindow(10, T0 + 100, 'mag');
    expect(w.y[0]).toBeCloseTo(5, 9);
  });

  it('ignores an empty block', () => {
    const log = new SessionLog();
    log.addAccBlock([], T0, 50);
    expect(log.acc.t).toHaveLength(0);
    expect(log.isEmpty).toBe(true);
  });

  it('strides a very long window for drawing but keeps every sample logged', () => {
    const log = new SessionLog();
    const n = 5000;
    const block = Array.from({ length: n }, (_, i) => ({ x: i, y: 0, z: 0 }));
    log.addAccBlock(block, T0 + n * 20, 50);

    const capped = log.accWindow(3600, T0 + n * 20 + 1000, 'x', 500);
    expect(capped.x.length).toBeLessThanOrEqual(501);
    // The newest sample must still be the last drawn point, or a live trace
    // would stop short of the right edge.
    expect(capped.x[capped.x.length - 1]).toBe(log.acc.t[n - 1]);
    // Nothing was actually discarded.
    expect(log.acc.t).toHaveLength(n);

    const full = log.accWindow(3600, T0 + n * 20 + 1000, 'x', 100_000);
    expect(full.x).toHaveLength(n);
  });
});

describe('SessionLog metrics', () => {
  it('returns metric columns oldest-first and skips nulls', () => {
    const log = new SessionLog();
    log.addMetric(emptyRow(T0, { rmssd: 30 }));
    log.addMetric(emptyRow(T0 + 1000, { rmssd: null }));
    log.addMetric(emptyRow(T0 + 2000, { rmssd: 34 }));

    const w = log.metricWindow(60, T0 + 2500, (r) => r.rmssd);
    expect(w.x).toEqual([T0, T0 + 2000]); // ascending
    expect(w.y).toEqual([30, 34]);
  });

  it('drops non-finite values rather than plotting them', () => {
    const log = new SessionLog();
    log.addMetric(emptyRow(T0, { rmssd: Number.NaN }));
    log.addMetric(emptyRow(T0 + 1000, { rmssd: 22 }));
    expect(log.metricWindow(60, T0 + 1500, (r) => r.rmssd).y).toEqual([22]);
  });
});

describe('clear', () => {
  it('resets every column and the start time', () => {
    const log = new SessionLog();
    log.addBeat(T0, 900, 66, 'h10', false);
    log.addAccBlock([{ x: 1, y: 1, z: 1 }], T0, 50);
    log.addMetric(emptyRow(T0));
    expect(log.isEmpty).toBe(false);
    log.clear();
    expect(log.isEmpty).toBe(true);
    expect(log.startedAt).toBeNull();
    expect(log.beatCount).toBe(0);
    expect(log.acc.t).toHaveLength(0);
    expect(log.metrics).toHaveLength(0);
  });
});

describe('CSV export', () => {
  const build = (): SessionLog => {
    const log = new SessionLog();
    log.addBeat(T0, 900, 66.7, 'h10', false);
    log.addBeat(T0 + 900, 120, 500, 'h10', true);
    log.addBeat(T0 + 1800, 910, 65.9, 'earclip', false);
    log.addAccBlock(
      [
        { x: -38, y: 112, z: 978 },
        { x: -35, y: 115, z: 981 },
      ],
      T0 + 2000,
      50,
    );
    log.addMetric(emptyRow(T0 + 2000, { meanHr: 66.2, rmssd: 28.4, sdnn: 51.2, engineCoherence: 42 }));
    log.addMetric(emptyRow(T0 + 3000));
    return log;
  };

  it('writes one metrics row per record with a matching column count', () => {
    const csv = writeMetricsCSV(build());
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(3); // header + 2 rows
    const cols = lines[0].split(',').length;
    for (const l of lines) expect(l.split(',')).toHaveLength(cols);
  });

  it('writes empty cells for metrics that were not computed, never zeros', () => {
    const csv = writeMetricsCSV(build());
    const lines = csv.trim().split('\n');
    const header = lines[0].split(',');
    const hrIdx = header.indexOf('mean_hr_bpm');
    expect(lines[1].split(',')[hrIdx]).toBe('66.20');
    expect(lines[2].split(',')[hrIdx]).toBe(''); // not "0"
  });

  it('includes rejected beats in the beats CSV, flagged', () => {
    const csv = writeBeatsCSV(build());
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(4); // header + 3 beats, including the rejected one
    const header = lines[0].split(',');
    const artIdx = header.indexOf('artifact');
    const srcIdx = header.indexOf('source');
    expect(lines[2].split(',')[artIdx]).toBe('true');
    expect(lines[3].split(',')[srcIdx]).toBe('earclip');
  });

  it('carries both an absolute and a session-relative timestamp', () => {
    const csv = writeBeatsCSV(build());
    const header = csv.split('\n')[0].split(',');
    expect(header).toContain('timestamp_ms');
    expect(header).toContain('session_s');
    const first = csv.split('\n')[1].split(',');
    expect(first[header.indexOf('timestamp_ms')]).toBe(String(T0));
    expect(first[header.indexOf('session_s')]).toBe('0.000');
  });

  it('writes one accelerometer row per sample with the magnitude', () => {
    const csv = writeAccCSV(build());
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(3);
    const header = lines[0].split(',');
    const row = lines[1].split(',');
    const mag = Math.sqrt(38 * 38 + 112 * 112 + 978 * 978);
    expect(Number(row[header.indexOf('mag_mg')])).toBeCloseTo(mag, 1);
  });

  it('marks a demo session as synthetic in the manifest', () => {
    const log = build();
    const base = {
      polarName: 'Polar H10 (demo)',
      earclipName: null,
      analysisSource: 'h10',
      analysisWindowSec: 64,
      buildId: 'test',
    };
    const demo = JSON.parse(writeManifestJSON(log, { ...base, demo: true }));
    expect(demo.synthetic).toBe(true);
    expect(demo.SYNTHETIC_DATA_WARNING).toContain('NOT a measurement');

    const real = JSON.parse(writeManifestJSON(log, { ...base, demo: false }));
    expect(real.synthetic).toBe(false);
    expect(real.SYNTHETIC_DATA_WARNING).toBeUndefined();
    expect(real.counts.beats).toBe(3);
    expect(real.counts.artifactBeats).toBe(1);
    expect(real.counts.accSamples).toBe(2);
  });
});
