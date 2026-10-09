/*
 * protocolFormat.ts — the protocol/ folder of a guided recording.
 *
 * Turns the session's event stream into the three things a labelling
 * pipeline needs: what was run (protocol.json), when each block really
 * started and ended (blocks.csv) and when each cue fired (cues.csv) — on
 * the host clock AND, via the earclip's echoed markers, on the device
 * clock that every raw PPG sample in v2/ppg_raw.csv carries.
 */
import { csvField } from './format';
import { MARKER_SRC_HOST } from '../ble/v2/protocol';
import type { GuidedBlock, GuidedProtocol } from '../guided/protocol';
import type { ProtocolEventRecord, V2EventRecordTimed } from './types';

function csvRow(fields: Array<string | number | boolean | null | undefined>): string {
  return fields.map(csvField).join(',');
}

function ms(n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(n) ? '' : n.toFixed(3);
}

/** A host marker echoed by the device is matched to the protocol event
 * that sent it: same id, nearest in host time, within this window. A
 * restarted block reuses its ids, so the time match is what disambiguates. */
const MARKER_MATCH_MS = 3000;

/** Device time (µs) of the marker each protocol event sent, when the
 * earclip echoed it back. */
export function markerDeviceTimes(
  events: ProtocolEventRecord[],
  v2Events: V2EventRecordTimed[],
): Map<ProtocolEventRecord, number> {
  const byId = new Map<number, V2EventRecordTimed[]>();
  for (const e of v2Events) {
    if (e.typeName !== 'MARKER' || e.tUs === null || e.fields.source !== MARKER_SRC_HOST) continue;
    const id = e.fields.markerId;
    const list = byId.get(id) ?? [];
    list.push(e);
    byId.set(id, list);
  }
  const used = new Set<V2EventRecordTimed>();
  const out = new Map<ProtocolEventRecord, number>();
  for (const ev of events) {
    if (ev.markerId === undefined || ev.markerSentMs === null) continue;
    let best: V2EventRecordTimed | null = null;
    let bestDt = Infinity;
    for (const c of byId.get(ev.markerId) ?? []) {
      if (used.has(c)) continue;
      const dt = Math.abs(c.timestamp - ev.markerSentMs);
      if (dt < bestDt) { best = c; bestDt = dt; }
    }
    if (best && bestDt <= MARKER_MATCH_MS && best.tUs !== null) {
      used.add(best);
      out.set(ev, best.tUs);
    }
  }
  return out;
}

/** The protocol definition the session ran (from its session_start). */
export function protocolOf(events: ProtocolEventRecord[]): GuidedProtocol | undefined {
  const start = events.find((e) => e.kind === 'session_start');
  const payload = start?.payload as { protocol?: GuidedProtocol } | undefined;
  return payload?.protocol;
}

export interface ProtocolBlockRow {
  blockIndex: number;
  attempt: number;
  label: string;
  kind: string;
  plannedS: number | null;
  startHostMs: number;
  endHostMs: number | null;
  endReason: string;
  startMarkerId: number | null;
  endMarkerId: number | null;
  startDevUs: number | null;
  endDevUs: number | null;
  useForTraining: boolean;
}

export function buildBlockRows(
  events: ProtocolEventRecord[],
  devTimes: Map<ProtocolEventRecord, number>,
  protocol?: GuidedProtocol,
): ProtocolBlockRow[] {
  const rows: ProtocolBlockRow[] = [];
  const open = new Map<string, ProtocolBlockRow>();
  for (const ev of events) {
    const key = `${ev.blockIndex}:${ev.attempt ?? 1}`;
    if (ev.kind === 'block_start') {
      const row: ProtocolBlockRow = {
        blockIndex: ev.blockIndex,
        attempt: ev.attempt ?? 1,
        label: ev.label ?? '',
        kind: ev.blockKind ?? '',
        plannedS: protocol?.blocks[ev.blockIndex]?.seconds ?? null,
        startHostMs: ev.hostMs,
        endHostMs: null,
        endReason: 'unfinished',
        startMarkerId: ev.markerId ?? null,
        endMarkerId: null,
        startDevUs: devTimes.get(ev) ?? null,
        endDevUs: null,
        useForTraining: false,
      };
      rows.push(row);
      open.set(key, row);
    } else if (ev.kind === 'block_end') {
      const row = open.get(key);
      if (!row) continue;
      open.delete(key);
      row.endHostMs = ev.hostMs;
      row.endReason = ev.reason ?? 'completed';
      row.endMarkerId = ev.markerId ?? null;
      row.endDevUs = devTimes.get(ev) ?? null;
    }
  }
  for (const row of rows) {
    row.useForTraining = (row.kind === 'state' || row.kind === 'cued') &&
      row.endReason === 'completed' && !protocol?.check_only;
  }
  return rows;
}

const BLOCK_HEADER = [
  'block_index', 'attempt', 'label', 'kind', 'planned_s', 'start_host_ms', 'end_host_ms',
  'duration_s', 'end_reason', 'use_for_training', 'start_marker_id', 'end_marker_id',
  'start_dev_us', 'end_dev_us',
];

export function writeProtocolBlocksCSV(rows: ProtocolBlockRow[]): string {
  const lines = [BLOCK_HEADER.join(',')];
  for (const r of rows) {
    lines.push(csvRow([
      r.blockIndex, r.attempt, r.label, r.kind, r.plannedS, ms(r.startHostMs), ms(r.endHostMs),
      r.endHostMs !== null ? ((r.endHostMs - r.startHostMs) / 1000).toFixed(3) : null,
      r.endReason, r.useForTraining, r.startMarkerId, r.endMarkerId, r.startDevUs, r.endDevUs,
    ]));
  }
  return lines.join('\n') + '\n';
}

const CUE_HEADER = [
  'block_index', 'attempt', 'cue_index', 'label', 'prompt', 'marks_event', 'host_ms',
  'window_start_host_ms', 'window_end_host_ms', 'marker_id', 'dev_us',
  'window_start_dev_us', 'window_end_dev_us',
];

export function writeProtocolCuesCSV(
  events: ProtocolEventRecord[],
  devTimes: Map<ProtocolEventRecord, number>,
  protocol?: GuidedProtocol,
): string {
  const lines = [CUE_HEADER.join(',')];
  for (const ev of events) {
    if (ev.kind !== 'cue') continue;
    const block: GuidedBlock | undefined = protocol?.blocks[ev.blockIndex];
    const lead = block?.cue?.lead_s ?? 0;
    const tail = block?.cue?.tail_s ?? 0;
    const dev = devTimes.get(ev);
    lines.push(csvRow([
      ev.blockIndex, ev.attempt ?? 1, ev.cueIndex, ev.label, ev.prompt,
      block?.cue?.marks_event ?? null,
      ms(ev.hostMs), ms(ev.hostMs + lead * 1000), ms(ev.hostMs + tail * 1000),
      ev.markerId ?? null, dev ?? null,
      dev !== undefined ? Math.round(dev + lead * 1e6) : null,
      dev !== undefined ? Math.round(dev + tail * 1e6) : null,
    ]));
  }
  return lines.join('\n') + '\n';
}

export function writeProtocolJSON(
  events: ProtocolEventRecord[],
  rows: ProtocolBlockRow[],
  devTimes: Map<ProtocolEventRecord, number>,
): string {
  const start = events.find((e) => e.kind === 'session_start');
  const end = [...events].reverse().find((e) => e.kind === 'session_end');
  const withMarker = events.filter((e) => e.markerId !== undefined && e.markerSentMs !== null);
  return JSON.stringify({
    ...(start?.payload as object | undefined),
    outcome: end?.reason ?? 'unfinished',
    started_host_ms: start?.hostMs ?? null,
    ended_host_ms: end?.hostMs ?? null,
    blocks_run: rows.length,
    blocks_for_training: rows.filter((r) => r.useForTraining).length,
    blocks_restarted: rows.filter((r) => r.attempt > 1).length,
    cues: events.filter((e) => e.kind === 'cue').length,
    markers_sent: withMarker.length,
    markers_echoed_by_device: withMarker.filter((e) => devTimes.has(e)).length,
  }, null, 2);
}

export const PROTOCOL_README = `Guided protocol recording
=========================
The wearer followed a scripted protocol; every block boundary and cue was
logged here and (when a V2 earclip was connected) also sent to the earclip
as a marker, which the earclip echoed into its own event stream on the
device clock. v2/ppg_raw.csv carries the same device clock (dev_us), so
dev_us is the column to align labels with raw samples. host_ms is the
dashboard's wall clock (the same clock as host_ms elsewhere in the zip).

protocol.json — the exact protocol that was run (every block, prompt and
  cue), the audio mode (off / tones / speech: following by ear and by eye
  have different reaction times), the earclip firmware, whether a Polar H10
  reference was connected, and the outcome (completed / aborted).

blocks.csv — one row per block actually run.
  kind              settle / transition: never training data
                    state: the label applies to the whole block
                    cued:  the label applies around each cue (cues.csv)
  attempt           1, or 2+ when a pause restarted the block (the paused
                    attempt ends with end_reason = paused)
  end_reason        completed / skipped / paused / aborted / unfinished
  use_for_training  state or cued, completed, and not the short check
  *_marker_id       (block_index + 1) * 1000 (+ 999 for the end)
  *_dev_us          device clock time of that marker (blank: not echoed)

cues.csv — one row per cue (cued blocks, and the breathing pacer).
  marks_event       true: a labelled action (head turn, clench, swallow...)
                    false: pacing guidance only (breathing tones)
  window_*          where the action is expected: cue + lead_s .. cue +
                    tail_s from the protocol definition
  marker_id         (block_index + 1) * 1000 + 1 + cue_index

Suggested use: drop settle/transition blocks, drop the first drop_lead_s
seconds (protocol.json) of each labelled block, take cued labels from the
cue windows, and skip any window that overlaps lost data (seq gaps in
v2/ppg_raw.csv, see v2/link_stats.json) rather than stitching across it.
`;
