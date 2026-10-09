import { describe, it, expect } from 'vitest';
import {
  GUIDED_FILE, GUIDED_PROTOCOLS, cueTimes, decodeMarkerId, findProtocol, markerId,
  protocolSeconds, validateProtocolFile, type GuidedProtocol,
} from '../protocol';
import { GuidedRunner, type GuidedEvent } from '../runner';

/* ---------------------------------------------------------------- */
/* The shared protocol file                                          */
/* ---------------------------------------------------------------- */

describe('shared protocol file', () => {
  it('validates clean', () => {
    expect(validateProtocolFile(GUIDED_FILE)).toEqual([]);
  });

  it('ships core, full and the short check, with the durations the UI promises', () => {
    const core = findProtocol('ppg_artifact_core')!;
    const full = findProtocol('ppg_artifact_full')!;
    const short = findProtocol('ppg_artifact_short')!;
    expect(protocolSeconds(core)).toBe(400);            /* ~7 min */
    expect(protocolSeconds(full)).toBe(1030);           /* ~17 min */
    expect(protocolSeconds(short)).toBeLessThan(90);
    expect(short.check_only).toBe(true);
  });

  it('covers the conditions asked for: still, foot tap, chewing, talking', () => {
    for (const id of ['ppg_artifact_core', 'ppg_artifact_full']) {
      const labels = new Set(findProtocol(id)!.blocks.map((b) => b.label));
      for (const want of ['rest', 'foot_tap', 'chew', 'talk']) expect(labels).toContain(want);
    }
  });

  it('puts an instruction before every labelled block, and labels nothing else', () => {
    for (const p of GUIDED_PROTOCOLS) {
      p.blocks.forEach((b, i) => {
        if (b.kind === 'state' || b.kind === 'cued') {
          expect(p.blocks[i - 1].kind).toBe('transition');
          expect(b.tone).toBe('go');
        }
        if (b.kind === 'transition') expect(b.say).toBeTruthy();
      });
      expect(p.blocks[0].kind).toBe('settle');
      expect(p.blocks[p.blocks.length - 1].tone).toBe('done');
    }
  });

  it('catches a malformed edit', () => {
    const bad = structuredClone(GUIDED_FILE);
    bad.protocols[0].blocks[2].seconds = 0;
    bad.protocols[0].blocks[2].tone = 'kazoo';
    bad.protocols[1].blocks.push({ ...bad.protocols[1].blocks[1], cue: bad.protocols[1].blocks[10].cue });
    bad.protocols[2].id = bad.protocols[0].id;
    const errs = validateProtocolFile(bad);
    expect(errs.some((e) => /seconds must be > 0/.test(e))).toBe(true);
    expect(errs.some((e) => /unknown tone "kazoo"/.test(e))).toBe(true);
    expect(errs.some((e) => /transition blocks must not carry cues/.test(e))).toBe(true);
    expect(errs.some((e) => /duplicate id/.test(e))).toBe(true);
  });
});

describe('cue timing and markers', () => {
  const full = findProtocol('ppg_artifact_full')!;
  const block = (label: string) => full.blocks.find((b) => b.label === label)!;

  it('first cue one interval in; a cue fires only if its action ends in the block', () => {
    expect(cueTimes(block('head_turn'))).toEqual([6, 12, 18, 24, 30, 36, 42, 48, 54]);
    expect(cueTimes(block('stand_sit'))).toEqual([15, 30, 45]);   /* 60 + 5 tail > 60 */
    expect(cueTimes(block('paced_breath'))).toHaveLength(11);
    expect(cueTimes(block('rest'))).toEqual([]);
  });

  it('numbers markers per block and round-trips them', () => {
    expect(markerId(0, 'start')).toBe(1000);
    expect(markerId(0, 'end')).toBe(1999);
    expect(markerId(9, 'cue', 0)).toBe(10001);
    expect(markerId(59, 'end')).toBe(60999);                   /* still a u16 */
    for (const id of [1000, 1999, 10001, 23456, 60999]) {
      const d = decodeMarkerId(id)!;
      expect(markerId(d.blockIndex, d.kind, d.cueIndex)).toBe(id);
    }
    expect(decodeMarkerId(999)).toBeNull();
    expect(decodeMarkerId(1000)!.kind).toBe('start');
  });
});

/* ---------------------------------------------------------------- */
/* The runner on a fake clock                                        */
/* ---------------------------------------------------------------- */

const TINY: GuidedProtocol = {
  id: 'tiny', version: 1, title: 't', summary: '', reference: '', drop_lead_s: 0,
  blocks: [
    { label: 'settle', kind: 'settle', seconds: 2, prompt: 'p', tone: 'announce' },
    { label: 'transition', kind: 'transition', seconds: 1, prompt: 'p', say: 's', tone: 'announce' },
    { label: 'nod', kind: 'cued', seconds: 5, prompt: 'p', tone: 'go',
      cue: { every_s: 2, prompts: ['a', 'b'], tones: ['cue_high'], lead_s: 0, tail_s: 1, marks_event: true } },
    { label: 'transition', kind: 'transition', seconds: 1, prompt: 'done', say: 's', tone: 'done' },
  ],
};

function clock() {
  let t = 10_000;
  return { now: () => t, set: (v: number) => { t = v; }, add: (d: number) => { t += d; } };
}

const kinds = (evs: GuidedEvent[]) => evs.map((e) =>
  `${e.kind}${e.blockIndex >= 0 ? `@${e.blockIndex}` : ''}${e.cueIndex !== undefined ? `#${e.cueIndex}` : ''}`);

describe('GuidedRunner', () => {
  it('walks every block at its scheduled times, catching up a stalled tick in order', () => {
    const c = clock();
    const r = new GuidedRunner(TINY, c.now);
    expect(kinds(r.start())).toEqual(['session_start', 'block_start@0']);
    c.add(1999);
    expect(r.tick()).toEqual([]);
    c.add(100_000);                                   /* one huge stall: everything due */
    const evs = r.tick();
    expect(kinds(evs)).toEqual([
      'block_end@0', 'block_start@1', 'block_end@1', 'block_start@2',
      'cue@2#0', 'cue@2#1', 'block_end@2', 'block_start@3', 'block_end@3', 'session_end',
    ]);
    /* stamped with the schedule, not with the late tick */
    expect(evs.map((e) => e.tMs)).toEqual([
      12_000, 12_000, 13_000, 13_000, 15_000, 17_000, 18_000, 18_000, 19_000, 19_000,
    ]);
    expect(evs[4]).toMatchObject({ prompt: 'a', tone: 'cue_high', markerId: 3001 });
    expect(evs[5]).toMatchObject({ prompt: 'b', markerId: 3002 });
    expect(evs[6]).toMatchObject({ reason: 'completed', markerId: 3999 });
    expect(evs[9]).toMatchObject({ reason: 'completed' });
    expect(r.currentPhase).toBe('done');
    expect(r.status().progressMs).toBe(r.status().plannedMs);
  });

  it('a pause ends the block early and resume restarts it as a new attempt', () => {
    const c = clock();
    const r = new GuidedRunner(TINY, c.now);
    r.start();
    c.set(13_500);                                    /* 0.5 s into the cued block */
    expect(kinds(r.tick())).toEqual(['block_end@0', 'block_start@1', 'block_end@1', 'block_start@2']);
    c.set(14_000);
    const p = r.pause();
    expect(kinds(p)).toEqual(['block_end@2', 'pause@2']);
    expect(p[0]).toMatchObject({ reason: 'paused', tMs: 14_000, attempt: 1 });
    c.set(60_000);
    expect(r.tick()).toEqual([]);                     /* nothing moves while paused */
    const res = r.resume();
    expect(kinds(res)).toEqual(['resume@2', 'block_start@2']);
    expect(res[1]).toMatchObject({ attempt: 2, tMs: 60_000 });
    c.set(62_000);
    expect(kinds(r.tick())).toEqual(['cue@2#0']);     /* cues restart with the block */
  });

  it('skip and abort end the right block with the right reason', () => {
    const c = clock();
    const r = new GuidedRunner(TINY, c.now);
    r.start();
    c.set(10_500);
    const s = r.skip();
    expect(kinds(s)).toEqual(['block_end@0', 'block_start@1']);
    expect(s[0]).toMatchObject({ reason: 'skipped', tMs: 10_500 });
    c.set(10_700);
    const a = r.abort();
    expect(kinds(a)).toEqual(['block_end@1', 'session_end']);
    expect(a[0].reason).toBe('aborted');
    expect(a[1].reason).toBe('aborted');
    expect(r.currentPhase).toBe('aborted');
    expect(r.tick()).toEqual([]);
  });

  it('abort while paused does not end the block twice', () => {
    const c = clock();
    const r = new GuidedRunner(TINY, c.now);
    r.start();
    c.set(10_500);
    r.pause();
    expect(kinds(r.abort())).toEqual(['session_end']);
  });

  it('offers sounds ahead of time under the same key tick() later reports', () => {
    const c = clock();
    const r = new GuidedRunner(TINY, c.now);
    r.start();
    c.set(14_800);
    r.tick();                                         /* now in the cued block (start 13 s) */
    const up = r.upcoming(300);
    expect(up).toEqual([{ key: '2:1:cue:0', atMs: 15_000, tone: 'cue_high' }]);
    c.set(15_000);
    const [cue] = r.tick();
    expect(r.soundKey(cue)).toBe('2:1:cue:0');
    c.set(17_900);
    r.tick();
    expect(r.upcoming(200).map((u) => u.key)).toEqual(['3:1:start']);   /* next block's tone */
  });

  it('reports progress and the next cue for the UI', () => {
    const c = clock();
    const r = new GuidedRunner(TINY, c.now);
    r.start();
    c.set(13_500);
    r.tick();
    const st = r.status();
    expect(st.block!.label).toBe('nod');
    expect(st.nextBlock!.label).toBe('transition');
    expect(st.blockElapsedMs).toBe(500);
    expect(st.blockRemainingMs).toBe(4500);
    expect(st.nextCueInMs).toBe(1500);
    expect(st.progressMs).toBe(3500);
    expect(st.plannedMs).toBe(9000);
  });
});
