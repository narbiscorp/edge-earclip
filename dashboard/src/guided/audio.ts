/*
 * audio.ts — the guided protocol's tones and spoken instructions.
 *
 * Tones are synthesised on the Web Audio clock and SCHEDULED ahead of
 * time (the session hands over each cue a few hundred ms early), so a
 * beep lands within a millisecond or two of the timestamp that goes into
 * the recording rather than wherever the next 50 ms timer tick falls. A
 * cue that was never scheduled is played late, not skipped; a key that
 * was already scheduled is never played twice.
 *
 * Every tone is ramped at both ends: a hard-switched sine is a click.
 * The mode in use (off / tones / speech) is written into the recording,
 * because a block followed by ear and one followed by eye have different
 * compliance latencies.
 */

export type AudioMode = 'off' | 'tones' | 'speech';

interface Note {
  f0: number;
  /** Glide to this frequency over the note (breathing tones). */
  f1?: number;
  dur: number;
  /** Silence before this note. */
  gap?: number;
}

const TONES: Record<string, { notes: Note[]; gain: number }> = {
  announce: { notes: [{ f0: 660, dur: 0.12 }, { f0: 880, dur: 0.16, gap: 0.04 }], gain: 0.12 },
  go: { notes: [{ f0: 1046, dur: 0.18 }], gain: 0.14 },
  cue_high: { notes: [{ f0: 1320, dur: 0.12 }], gain: 0.14 },
  cue_low: { notes: [{ f0: 520, dur: 0.16 }], gain: 0.18 },
  inhale: { notes: [{ f0: 330, f1: 660, dur: 1.2 }], gain: 0.07 },
  exhale: { notes: [{ f0: 660, f1: 330, dur: 1.2 }], gain: 0.07 },
  done: {
    notes: [{ f0: 523, dur: 0.14 }, { f0: 659, dur: 0.14, gap: 0.03 }, { f0: 784, dur: 0.26, gap: 0.03 }],
    gain: 0.12,
  },
};

export const TONE_NAMES = Object.keys(TONES);

export class GuidedAudio {
  mode: AudioMode = 'tones';
  private ctx: AudioContext | null = null;
  private scheduled = new Set<string>();

  /** Call from a click handler: browsers only let audio start on a gesture. */
  async unlock(): Promise<void> {
    if (this.mode === 'off' || typeof AudioContext === 'undefined') return;
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  /** Play `tone` at `atPerfMs` (performance.now() time; omitted or past =
   * now). With a `key`, a second call for the same instant is a no-op. */
  play(tone: string, atPerfMs?: number, key?: string): void {
    if (this.mode === 'off' || !this.ctx) return;
    if (key) {
      if (this.scheduled.has(key)) return;
      this.scheduled.add(key);
    }
    const spec = TONES[tone];
    if (!spec) return;
    const ctx = this.ctx;
    const lead = atPerfMs === undefined ? 0 : (atPerfMs - performance.now()) / 1000;
    let t = ctx.currentTime + Math.max(0.005, lead);
    for (const n of spec.notes) {
      t += n.gap ?? 0;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(n.f0, t);
      if (n.f1) osc.frequency.linearRampToValueAtTime(n.f1, t + n.dur);
      const ramp = Math.min(0.03, n.dur / 4);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(spec.gain, t + ramp);
      g.gain.setValueAtTime(spec.gain, t + n.dur - ramp);
      g.gain.linearRampToValueAtTime(0, t + n.dur);
      osc.connect(g).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + n.dur + 0.02);
      t += n.dur;
    }
  }

  say(text: string): void {
    if (this.mode !== 'speech' || !text || typeof speechSynthesis === 'undefined') return;
    speechSynthesis.cancel();
    speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }

  /** Every tone once, spaced out, plus a spoken line — the pre-flight check. */
  async test(): Promise<void> {
    await this.unlock();
    const t0 = performance.now() + 100;
    TONE_NAMES.forEach((name, i) => this.play(name, t0 + i * 900));
    this.say('This is how instructions will sound.');
  }

  stop(): void {
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    this.scheduled.clear();
  }

  async close(): Promise<void> {
    this.stop();
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx) await ctx.close().catch(() => undefined);
  }
}
