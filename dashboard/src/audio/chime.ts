/*
 * chime.ts — synthesized breathing-pacer cues (Web Audio, no audio files).
 *
 * Three voices (chime / bell / ding), each rendered at a higher pitch for inhale and a
 * lower pitch for exhale so the two are obviously distinguishable even with the same voice.
 * The browser requires a user gesture to start audio; call unlockAudio() from a click first.
 */
export type ChimeVoice = 'chime' | 'bell' | 'ding';
export const CHIME_VOICES: ChimeVoice[] = ['chime', 'bell', 'ding'];
export const CHIME_VOICE_LABEL: Record<ChimeVoice, string> = {
  chime: 'Chime',
  bell: 'Bell',
  ding: 'Ding',
};

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  return ctx;
}

/** Resume the AudioContext from within a user gesture so later auto-played cues are audible. */
export function unlockAudio(): void {
  const ac = getCtx();
  if (ac && ac.state === 'suspended') void ac.resume();
}

interface OscPartial {
  mul: number; // frequency multiple of the base
  gain: number; // relative level
  type: OscillatorType;
  dur: number; // seconds
}

function partialsFor(voice: ChimeVoice): { partials: OscPartial[]; attack: number } {
  switch (voice) {
    case 'bell':
      return {
        attack: 0.004,
        partials: [
          { mul: 1, gain: 1, type: 'sine', dur: 1.3 },
          { mul: 2.0, gain: 0.45, type: 'sine', dur: 1.0 },
          { mul: 2.76, gain: 0.28, type: 'sine', dur: 0.8 },
        ],
      };
    case 'chime':
      return {
        attack: 0.05,
        partials: [
          { mul: 1, gain: 1, type: 'triangle', dur: 0.85 },
          { mul: 1.5, gain: 0.32, type: 'sine', dur: 0.7 },
        ],
      };
    case 'ding':
    default:
      return { attack: 0.005, partials: [{ mul: 1, gain: 1, type: 'sine', dur: 0.45 }] };
  }
}

/** Play one cue. `direction` sets the pitch (inhale higher, exhale lower). */
export function playChime(voice: ChimeVoice, direction: 'inhale' | 'exhale', volume = 0.18): void {
  const ac = getCtx();
  if (!ac) return;
  if (ac.state === 'suspended') void ac.resume();
  const now = ac.currentTime;
  const baseFreq = direction === 'inhale' ? 660 : 440; // E5 vs A4
  const master = ac.createGain();
  master.gain.value = volume;
  master.connect(ac.destination);

  const { partials, attack } = partialsFor(voice);
  for (const p of partials) {
    const osc = ac.createOscillator();
    osc.type = p.type;
    osc.frequency.value = baseFreq * p.mul;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(p.gain, now + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, now + p.dur);
    osc.connect(g);
    g.connect(master);
    osc.start(now);
    osc.stop(now + p.dur + 0.05);
  }
}
