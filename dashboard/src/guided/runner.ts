/*
 * runner.ts — walks a guided protocol on an injected clock.
 *
 * Pure: no timers, no DOM, no BLE. The caller ticks it (the session does,
 * every ~50 ms) and gets back the events that fell due since the last
 * tick, each stamped with the time it was SCHEDULED for, not the time the
 * tick noticed it — so a late tick (a throttled tab, a busy main thread)
 * never smears a label. A long stall is caught up in order.
 *
 * Pause ends the current block early and resume RESTARTS it (attempt + 1):
 * a labelled block must be one contiguous stretch of the activity, and
 * "60 s of foot tapping with a 2-minute hole in it" is two half-blocks
 * that neither the trainer nor the reader can tell apart.
 */
import {
  cueTimes, markerId, protocolSeconds,
  type BlockKind, type GuidedBlock, type GuidedProtocol,
} from './protocol';

export type GuidedPhase = 'idle' | 'running' | 'paused' | 'done' | 'aborted';
export type GuidedEventKind =
  | 'session_start' | 'block_start' | 'cue' | 'block_end'
  | 'pause' | 'resume' | 'session_end';
export type EndReason = 'completed' | 'skipped' | 'paused' | 'aborted';

export interface GuidedEvent {
  kind: GuidedEventKind;
  /** Runner-clock ms the event was scheduled for. */
  tMs: number;
  /** -1 for session-level events. */
  blockIndex: number;
  label?: string;
  blockKind?: BlockKind;
  /** 1 on a block's first run; +1 each time a pause restarts it. */
  attempt?: number;
  cueIndex?: number;
  prompt?: string;
  tone?: string;
  say?: string;
  reason?: EndReason;
  markerId?: number;
}

export interface GuidedStatus {
  phase: GuidedPhase;
  blockIndex: number;
  block: GuidedBlock | null;
  nextBlock: GuidedBlock | null;
  attempt: number;
  blockElapsedMs: number;
  blockRemainingMs: number;
  /** ms until the next cue in this block, null when none is left. */
  nextCueInMs: number | null;
  /** Planned time covered so far (blocks done + this one), for progress. */
  progressMs: number;
  plannedMs: number;
}

/** A sound the audio layer may schedule ahead of time; `key` lets the
 * session recognise the same instant when tick() later reports it. */
export interface UpcomingSound {
  key: string;
  atMs: number;
  tone?: string;
}

export class GuidedRunner {
  private phase: GuidedPhase = 'idle';
  private idx = -1;
  private attempt = 0;
  private blockStart = 0;
  private cues: number[] = [];
  private nextCue = 0;

  constructor(
    readonly protocol: GuidedProtocol,
    private readonly now: () => number,
  ) {}

  get currentPhase(): GuidedPhase {
    return this.phase;
  }

  start(): GuidedEvent[] {
    if (this.phase !== 'idle' || this.protocol.blocks.length === 0) return [];
    const t = this.now();
    this.phase = 'running';
    return [{ kind: 'session_start', tMs: t, blockIndex: -1 }, this.enter(0, t, 1)];
  }

  /** Events that fell due since the last call, in order. */
  tick(): GuidedEvent[] {
    if (this.phase !== 'running') return [];
    const now = this.now();
    const out: GuidedEvent[] = [];
    for (;;) {
      const b = this.protocol.blocks[this.idx];
      while (this.nextCue < this.cues.length) {
        const at = this.blockStart + this.cues[this.nextCue] * 1000;
        if (at > now) break;
        out.push(this.cueEvent(b, this.nextCue, at));
        this.nextCue++;
      }
      const endAt = this.blockStart + b.seconds * 1000;
      if (endAt > now) break;
      out.push(this.leave(endAt, 'completed'));
      if (this.idx + 1 >= this.protocol.blocks.length) {
        this.phase = 'done';
        out.push({ kind: 'session_end', tMs: endAt, blockIndex: -1, reason: 'completed' });
        break;
      }
      out.push(this.enter(this.idx + 1, endAt, 1));
    }
    return out;
  }

  pause(): GuidedEvent[] {
    const out = this.tick();
    if (this.phase !== 'running') return out;
    const t = this.now();
    out.push(this.leave(t, 'paused'));
    out.push({ kind: 'pause', tMs: t, blockIndex: this.idx });
    this.phase = 'paused';
    return out;
  }

  /** Restarts the paused block from its beginning. */
  resume(): GuidedEvent[] {
    if (this.phase !== 'paused') return [];
    const t = this.now();
    this.phase = 'running';
    return [{ kind: 'resume', tMs: t, blockIndex: this.idx }, this.enter(this.idx, t, this.attempt + 1)];
  }

  skip(): GuidedEvent[] {
    const out = this.tick();
    if (this.phase !== 'running') return out;
    const t = this.now();
    out.push(this.leave(t, 'skipped'));
    if (this.idx + 1 >= this.protocol.blocks.length) {
      this.phase = 'done';
      out.push({ kind: 'session_end', tMs: t, blockIndex: -1, reason: 'completed' });
    } else {
      out.push(this.enter(this.idx + 1, t, 1));
    }
    return out;
  }

  abort(): GuidedEvent[] {
    const wasPaused = this.phase === 'paused';
    const out = wasPaused ? [] : this.tick();
    if (this.phase !== 'running' && this.phase !== 'paused') return out;
    const t = this.now();
    if (!wasPaused) out.push(this.leave(t, 'aborted'));   /* paused: already ended */
    out.push({ kind: 'session_end', tMs: t, blockIndex: -1, reason: 'aborted' });
    this.phase = 'aborted';
    return out;
  }

  status(): GuidedStatus {
    const now = this.now();
    const blocks = this.protocol.blocks;
    const b = this.idx >= 0 ? blocks[this.idx] : null;
    const running = this.phase === 'running';
    const blockElapsedMs = b && running ? Math.max(0, now - this.blockStart) : 0;
    let before = 0;
    for (let i = 0; i < this.idx && i < blocks.length; i++) before += blocks[i].seconds * 1000;
    const plannedMs = protocolSeconds(this.protocol) * 1000;
    return {
      phase: this.phase,
      blockIndex: this.idx,
      block: b,
      nextBlock: this.idx + 1 < blocks.length ? blocks[this.idx + 1] : null,
      attempt: this.attempt,
      blockElapsedMs,
      blockRemainingMs: b ? Math.max(0, b.seconds * 1000 - blockElapsedMs) : 0,
      nextCueInMs: b && running && this.nextCue < this.cues.length
        ? Math.max(0, this.blockStart + this.cues[this.nextCue] * 1000 - now)
        : null,
      progressMs: this.phase === 'done' ? plannedMs : Math.min(plannedMs, before + blockElapsedMs),
      plannedMs,
    };
  }

  /** Tones due within `withinMs`: this block's remaining cues and the next
   * block's start tone. Lets the audio layer schedule them sample-exact. */
  upcoming(withinMs: number): UpcomingSound[] {
    if (this.phase !== 'running') return [];
    const now = this.now();
    const horizon = now + withinMs;
    const b = this.protocol.blocks[this.idx];
    const out: UpcomingSound[] = [];
    for (let k = this.nextCue; k < this.cues.length; k++) {
      const at = this.blockStart + this.cues[k] * 1000;
      if (at > horizon) break;
      const tones = b.cue?.tones ?? [];
      if (tones.length) {
        out.push({ key: this.cueKey(this.idx, this.attempt, k), atMs: at, tone: tones[k % tones.length] });
      }
    }
    const endAt = this.blockStart + b.seconds * 1000;
    const nb = this.protocol.blocks[this.idx + 1];
    if (nb?.tone && endAt <= horizon) {
      out.push({ key: this.startKey(this.idx + 1, 1), atMs: endAt, tone: nb.tone });
    }
    return out;
  }

  /** The same key upcoming() used, for an event tick() reports. */
  soundKey(ev: GuidedEvent): string | null {
    if (ev.kind === 'cue' && ev.cueIndex !== undefined) {
      return this.cueKey(ev.blockIndex, ev.attempt ?? 1, ev.cueIndex);
    }
    if (ev.kind === 'block_start') return this.startKey(ev.blockIndex, ev.attempt ?? 1);
    return null;
  }

  private cueKey(i: number, attempt: number, k: number): string {
    return `${i}:${attempt}:cue:${k}`;
  }

  private startKey(i: number, attempt: number): string {
    return `${i}:${attempt}:start`;
  }

  private enter(i: number, t: number, attempt: number): GuidedEvent {
    this.idx = i;
    this.attempt = attempt;
    this.blockStart = t;
    const b = this.protocol.blocks[i];
    this.cues = cueTimes(b);
    this.nextCue = 0;
    return {
      kind: 'block_start', tMs: t, blockIndex: i, label: b.label, blockKind: b.kind,
      attempt, tone: b.tone, prompt: b.prompt, say: b.say, markerId: markerId(i, 'start'),
    };
  }

  private leave(t: number, reason: EndReason): GuidedEvent {
    const b = this.protocol.blocks[this.idx];
    return {
      kind: 'block_end', tMs: t, blockIndex: this.idx, label: b.label, blockKind: b.kind,
      attempt: this.attempt, reason, markerId: markerId(this.idx, 'end'),
    };
  }

  private cueEvent(b: GuidedBlock, k: number, at: number): GuidedEvent {
    const c = b.cue!;
    const tones = c.tones ?? [];
    return {
      kind: 'cue', tMs: at, blockIndex: this.idx, label: b.label, blockKind: b.kind,
      attempt: this.attempt, cueIndex: k, prompt: c.prompts[k % c.prompts.length],
      tone: tones.length ? tones[k % tones.length] : undefined,
      markerId: markerId(this.idx, 'cue', k),
    };
  }
}
