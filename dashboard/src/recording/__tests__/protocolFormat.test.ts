import { describe, it, expect } from 'vitest';
import {
  buildBlockRows, markerDeviceTimes, protocolOf,
  writeProtocolBlocksCSV, writeProtocolCuesCSV, writeProtocolJSON,
} from '../protocolFormat';
import type { ProtocolEventRecord, V2EventRecordTimed } from '../types';
import type { GuidedProtocol } from '../../guided/protocol';
import { GuidedRunner } from '../../guided/runner';

const PROTO: GuidedProtocol = {
  id: 'p', version: 1, title: 'P', summary: '', reference: '', drop_lead_s: 3,
  blocks: [
    { label: 'settle', kind: 'settle', seconds: 2, prompt: 'p' },
    { label: 'nod', kind: 'cued', seconds: 5, prompt: 'p', tone: 'go',
      cue: { every_s: 2, prompts: ['a', 'b'], tones: ['cue_high'], lead_s: 0.5, tail_s: 1.5, marks_event: true } },
    { label: 'rest', kind: 'state', seconds: 3, prompt: 'p', tone: 'go' },
  ],
};

const HOST0 = 1_700_000_000_000;     /* wall clock at runner t = 0 */
const DEV_OFFSET_US = 5_000_000;     /* device clock = host ms * 1000 + offset */

/* Run the protocol on a fake clock, pause + resume once inside the cued
 * block, and publish every event the way the session would. */
function runSession(): ProtocolEventRecord[] {
  let t = 0;
  const r = new GuidedRunner(PROTO, () => t);
  const out: ProtocolEventRecord[] = [];
  const pub = (evs: ReturnType<GuidedRunner['tick']>) => {
    for (const ev of evs) {
      out.push({
        ...ev, protocolId: 'p', hostMs: HOST0 + ev.tMs,
        markerSentMs: ev.markerId !== undefined ? HOST0 + ev.tMs + 5 : null,
        payload: ev.kind === 'session_start' ? { protocol: PROTO, settings: { audioMode: 'tones' } } : undefined,
      });
    }
  };
  pub(r.start());
  t = 3000; pub(r.tick());          /* in the cued block (started at 2000) */
  t = 3200; pub(r.pause());
  t = 9000; pub(r.resume());        /* restart: attempt 2 from 9000 */
  t = 30_000; pub(r.tick());        /* run to the end */
  return out;
}

/* The earclip echoes each host marker 20 ms after it was sent. */
function echoes(events: ProtocolEventRecord[], drop: (e: ProtocolEventRecord) => boolean = () => false): V2EventRecordTimed[] {
  return events.filter((e) => e.markerSentMs !== null && !drop(e)).map((e, i) => {
    const host = e.markerSentMs! + 20;
    return {
      timestamp: host, arrivalMs: host + 30, seq: i, type: 4, typeName: 'MARKER',
      tUs: host * 1000 - HOST0 * 1000 + DEV_OFFSET_US,
      fields: { source: 1, markerId: e.markerId! }, rawHex: '',
    };
  });
}

describe('protocol export', () => {
  it('matches every marker to the event that sent it, restarted block included', () => {
    const events = runSession();
    const dev = markerDeviceTimes(events, echoes(events));
    const sent = events.filter((e) => e.markerSentMs !== null);
    expect(dev.size).toBe(sent.length);
    /* attempt 1 and attempt 2 of the cued block share marker id 2000 but
     * get their own device times */
    const starts = events.filter((e) => e.kind === 'block_start' && e.blockIndex === 1);
    expect(starts.map((e) => e.markerId)).toEqual([2000, 2000]);
    const [d1, d2] = starts.map((e) => dev.get(e)!);
    expect(d2 - d1).toBe((9000 - 2000) * 1000);
  });

  it('builds one row per block run, with reasons and training eligibility', () => {
    const events = runSession();
    const rows = buildBlockRows(events, markerDeviceTimes(events, echoes(events)), protocolOf(events));
    expect(rows.map((r) => `${r.label}#${r.attempt}:${r.endReason}:${r.useForTraining}`)).toEqual([
      'settle#1:completed:false', 'nod#1:paused:false', 'nod#2:completed:true', 'rest#1:completed:true',
    ]);
    const nod2 = rows[2];
    expect(nod2.plannedS).toBe(5);
    expect(nod2.endHostMs! - nod2.startHostMs).toBe(5000);
    expect(nod2.startDevUs).toBe((9000 + 5 + 20) * 1000 + DEV_OFFSET_US);
    const csv = writeProtocolBlocksCSV(rows).trim().split('\n');
    expect(csv[0].split(',')).toContain('use_for_training');
    expect(csv[3].split(',').slice(0, 4)).toEqual(['1', '2', 'nod', 'cued']);
  });

  it('writes cue windows on both clocks', () => {
    const events = runSession();
    const dev = markerDeviceTimes(events, echoes(events));
    const lines = writeProtocolCuesCSV(events, dev, protocolOf(events)).trim().split('\n');
    const header = lines[0].split(',');
    const rows = lines.slice(1).map((l) => Object.fromEntries(l.split(',').map((v, i) => [header[i], v])));
    /* attempt 1 was paused before its first cue; attempt 2 cues at +2 s only
     * (+4 s + tail 1.5 s would run past the 5 s block) */
    expect(rows.map((r) => `${r.attempt}:${r.cue_index}:${r.prompt}`)).toEqual(['2:0:a']);
    const c0 = rows[0];
    expect(Number(c0.host_ms)).toBe(HOST0 + 11_000);
    expect(Number(c0.window_start_host_ms)).toBe(HOST0 + 11_500);   /* + lead 0.5 s */
    expect(Number(c0.window_end_host_ms)).toBe(HOST0 + 12_500);     /* + tail 1.5 s */
    expect(Number(c0.window_start_dev_us) - Number(c0.dev_us)).toBe(500_000);
    expect(c0.marks_event).toBe('true');
    expect(c0.marker_id).toBe('2001');
  });

  it('leaves device times blank for markers the earclip never echoed', () => {
    const events = runSession();
    const dev = markerDeviceTimes(events, echoes(events, (e) => e.kind === 'cue'));
    const lines = writeProtocolCuesCSV(events, dev, protocolOf(events)).trim().split('\n');
    expect(lines[1].split(',')[10]).toBe('');                       /* dev_us */
    const json = JSON.parse(writeProtocolJSON(events, buildBlockRows(events, dev, protocolOf(events)), dev));
    expect(json.outcome).toBe('completed');
    expect(json.settings.audioMode).toBe('tones');
    expect(json.blocks_restarted).toBe(1);
    expect(json.markers_echoed_by_device).toBe(json.markers_sent - 1);   /* the one cue */
  });
});
