import { getDb, STORE_RECORDING_CHUNKS } from '../state/idb';
import type { ComparisonRow } from './format';
import type {
  BeatRecord,
  PolarBeatRecordTimed,
  RecordingChunk,
  ReplayEvent,
} from './types';

/**
 * Read all chunks for a session in chunkSeq order.
 * Uses the index 'by_session' to scope, then sorts client-side because IDB
 * compound-key cursors require constructing a key range.
 */
export async function loadChunks(sessionId: string): Promise<RecordingChunk[]> {
  const db = await getDb();
  const tx = db.transaction(STORE_RECORDING_CHUNKS, 'readonly');
  const idx = tx.store.index('by_session');
  const rows = (await idx.getAll(sessionId)) as RecordingChunk[];
  rows.sort((a, b) => a.chunkSeq - b.chunkSeq);
  return rows;
}

export async function deleteChunks(sessionId: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(STORE_RECORDING_CHUNKS, 'readwrite');
  const idx = tx.store.index('by_session');
  let cursor = await idx.openKeyCursor(IDBKeyRange.only(sessionId));
  while (cursor) {
    await tx.store.delete(cursor.primaryKey);
    cursor = await cursor.continue();
  }
  await tx.done;
}

/**
 * Build a single time-ordered ReplayEvent array by concatenating per-stream
 * arrays from each chunk and sorting. Within a chunk each per-stream array is
 * already monotonic, but raw and beats may share timestamps so a stable sort
 * is fine — no k-way merge needed for correctness.
 */
export function buildReplayEvents(chunks: RecordingChunk[]): ReplayEvent[] {
  const events: ReplayEvent[] = [];
  for (const c of chunks) {
    if (c.raw) {
      for (const r of c.raw) events.push({ t: r.timestamp, kind: 'raw', payload: r });
    }
    if (c.beats) {
      for (const b of c.beats) events.push({ t: b.timestamp, kind: 'beat', payload: b });
    }
    if (c.sqi) {
      for (const s of c.sqi) events.push({ t: s.timestamp, kind: 'sqi', payload: s });
    }
    if (c.battery) {
      for (const b of c.battery) events.push({ t: b.timestamp, kind: 'battery', payload: b });
    }
    if (c.filtered) {
      for (const f of c.filtered) events.push({ t: f.timestamp, kind: 'filtered', payload: f });
    }
    if (c.polarBeats) {
      for (const p of c.polarBeats) events.push({ t: p.timestamp, kind: 'polarBeat', payload: p });
    }
    if (c.metrics) {
      for (const m of c.metrics) events.push({ t: m.timestamp, kind: 'metric', payload: m });
    }
    if (c.annotations) {
      for (const a of c.annotations) {
        events.push({ t: a.timestamp, kind: 'annotation', payload: a });
      }
    }
    if (c.configEvents) {
      for (const e of c.configEvents) {
        events.push({ t: e.timestamp, kind: 'config', payload: e });
      }
    }
  }
  events.sort((a, b) => a.t - b.t);
  return events;
}

/** Concatenate one stream across all chunks. */
export function concatStream<K extends keyof RecordingChunk>(
  chunks: RecordingChunk[],
  key: K,
): NonNullable<RecordingChunk[K]> extends Array<infer T> ? T[] : never {
  const out: unknown[] = [];
  for (const c of chunks) {
    const arr = c[key];
    if (Array.isArray(arr)) out.push(...arr);
  }
  return out as NonNullable<RecordingChunk[K]> extends Array<infer T> ? T[] : never;
}

const H10_MATCH_TOLERANCE_MS = 300;

/**
 * For each earclip beat, find the closest H10 IBI within ±tolerance ms and emit a row.
 * Emits the earclip row with empty H10 columns when no match.
 *
 * The H10 source is `PolarBeatRecordTimed.rr` (an array of intervals attached to the
 * notify timestamp). We "explode" them into individual beats by walking backwards
 * from the notify timestamp summing the rr values (matching how BeatChart does it).
 */
export function alignH10ToEarclip(
  earclipBeats: BeatRecord[],
  h10Beats: PolarBeatRecordTimed[],
): ComparisonRow[] {
  const h10Pairs: Array<{ timestamp: number; ibi: number }> = [];
  for (const p of h10Beats) {
    if (!p.rr || p.rr.length === 0) continue;
    let totalRemaining = 0;
    for (let i = p.rr.length - 1; i >= 0; i--) totalRemaining += p.rr[i];
    let acc = 0;
    for (let i = 0; i < p.rr.length; i++) {
      const t = p.timestamp - (totalRemaining - acc);
      h10Pairs.push({ timestamp: t, ibi: p.rr[i] });
      acc += p.rr[i];
    }
  }
  h10Pairs.sort((a, b) => a.timestamp - b.timestamp);

  const rows: ComparisonRow[] = [];
  for (const ec of earclipBeats) {
    if (ec.is_artifact || ec.ibi_ms <= 0) continue;
    const j = lowerBound(h10Pairs, ec.timestamp);
    let bestIdx = -1;
    let bestDt = Infinity;
    for (const k of [j - 1, j]) {
      if (k < 0 || k >= h10Pairs.length) continue;
      const dt = Math.abs(h10Pairs[k].timestamp - ec.timestamp);
      if (dt < bestDt) {
        bestDt = dt;
        bestIdx = k;
      }
    }
    if (bestIdx >= 0 && bestDt <= H10_MATCH_TOLERANCE_MS) {
      rows.push({
        timestamp: ec.timestamp,
        earclip_ibi_ms: ec.ibi_ms,
        h10_ibi_ms: h10Pairs[bestIdx].ibi,
        dt_ms: h10Pairs[bestIdx].timestamp - ec.timestamp,
      });
    } else {
      rows.push({
        timestamp: ec.timestamp,
        earclip_ibi_ms: ec.ibi_ms,
        h10_ibi_ms: null,
        dt_ms: null,
      });
    }
  }
  return rows;
}

function lowerBound(arr: Array<{ timestamp: number }>, t: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].timestamp < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
