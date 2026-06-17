import { describe, it, expect } from 'vitest';
import { groupByClient, clientDelta, buildClientDeltas, averageDeltas } from '../aggregate';
import type { SessionListRow } from '../../sessions/useSessions';

/** Build a SessionListRow with sensible defaults; override only what a test cares about. */
function row(partial: Partial<SessionListRow>): SessionListRow {
  return {
    id: Math.random().toString(36).slice(2),
    schema_version: 2,
    client_id: null,
    started_at: '2026-01-01T00:00:00.000Z',
    ended_at: '2026-01-01T00:10:00.000Z',
    session_local_date: '2026-01-01',
    duration_seconds: 600,
    beat_count: 600,
    avg_hr_bpm: 60,
    avg_ibi_ms: 1000,
    ibi_min_ms: 800,
    ibi_max_ms: 1200,
    ibi_sd_ms: 50,
    ibi_cv_pct: 5,
    ibi_change_pct: 0,
    rmssd_ms: null,
    avg_coherence: null,
    peak_coherence: null,
    high_coh_time_pct: null,
    med_coh_time_pct: null,
    low_coh_time_pct: null,
    coh_change_pct: null,
    notes: null,
    device_info: null,
    saved_via: 'auto',
    ...partial,
  };
}

describe('groupByClient', () => {
  it('buckets by client_id and drops Unassigned (null) rows', () => {
    const rows = [
      row({ client_id: 'a' }),
      row({ client_id: 'b' }),
      row({ client_id: 'a' }),
      row({ client_id: null }),   // personal — dropped
    ];
    const g = groupByClient(rows);
    expect(g.size).toBe(2);
    expect(g.get('a')!.length).toBe(2);
    expect(g.get('b')!.length).toBe(1);
  });
});

describe('clientDelta', () => {
  it('returns null deltas for a single session', () => {
    const d = clientDelta('a', [row({ client_id: 'a', rmssd_ms: 40, avg_coherence: 50 })]);
    expect(d.sessionCount).toBe(1);
    expect(d.rmssdDelta).toBeNull();
    expect(d.cohDelta).toBeNull();
  });

  it('computes last − first on an improving series (order-independent input)', () => {
    // Two sessions, fed newest-first like useSessionList returns them.
    const d = clientDelta('a', [
      row({ client_id: 'a', started_at: '2026-02-01T00:00:00Z', rmssd_ms: 60 }),
      row({ client_id: 'a', started_at: '2026-01-01T00:00:00Z', rmssd_ms: 40 }),
    ]);
    expect(d.rmssdFirst).toBe(40);
    expect(d.rmssdLast).toBe(60);
    expect(d.rmssdDelta).toBe(20);
    expect(d.lastSessionAt).toBe('2026-02-01T00:00:00Z');
  });

  it('ignores sessions missing the metric when forming a delta', () => {
    const d = clientDelta('a', [
      row({ client_id: 'a', started_at: '2026-01-01T00:00:00Z', rmssd_ms: 30 }),
      row({ client_id: 'a', started_at: '2026-01-02T00:00:00Z', rmssd_ms: null }),
      row({ client_id: 'a', started_at: '2026-01-03T00:00:00Z', rmssd_ms: 50 }),
    ]);
    // Only two rows carry rmssd → delta = 50 − 30.
    expect(d.rmssdDelta).toBe(20);
    expect(d.sessionCount).toBe(3);
  });

  it('averages the first-N / last-N windows on longer series', () => {
    // 9 sessions → N = min(3, floor(9/3)) = 3. first3 mean=10, last3 mean=40 → delta 30.
    const vals = [10, 10, 10, 20, 20, 20, 40, 40, 40];
    const rows = vals.map((v, i) =>
      row({ client_id: 'a', started_at: `2026-01-${(i + 1).toString().padStart(2, '0')}T00:00:00Z`, rmssd_ms: v }),
    );
    const d = clientDelta('a', rows);
    expect(d.rmssdFirst).toBe(10);
    expect(d.rmssdLast).toBe(40);
    expect(d.rmssdDelta).toBe(30);
  });
});

describe('averageDeltas', () => {
  it('averages per-client deltas and counts improvers', () => {
    const rows = [
      // client a: improves +20
      row({ client_id: 'a', started_at: '2026-01-01T00:00:00Z', rmssd_ms: 40 }),
      row({ client_id: 'a', started_at: '2026-02-01T00:00:00Z', rmssd_ms: 60 }),
      // client b: declines −10
      row({ client_id: 'b', started_at: '2026-01-01T00:00:00Z', rmssd_ms: 50 }),
      row({ client_id: 'b', started_at: '2026-02-01T00:00:00Z', rmssd_ms: 40 }),
      // client c: single session, no delta
      row({ client_id: 'c', started_at: '2026-01-01T00:00:00Z', rmssd_ms: 55 }),
    ];
    const per = buildClientDeltas(rows);
    const avg = averageDeltas(per);
    expect(avg.clientCount).toBe(3);
    expect(avg.totalSessions).toBe(5);
    expect(avg.clientsWithDelta).toBe(2);     // a and b
    expect(avg.clientsImproved).toBe(1);      // only a
    expect(avg.avgRmssdDelta).toBe(5);        // (+20 + −10) / 2
  });

  it('returns null average when no client has a delta', () => {
    const per = buildClientDeltas([row({ client_id: 'a', rmssd_ms: 40 })]);
    const avg = averageDeltas(per);
    expect(avg.avgRmssdDelta).toBeNull();
    expect(avg.clientsImproved).toBe(0);
  });
});
