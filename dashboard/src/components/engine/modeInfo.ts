/*
 * modeInfo.ts — shared copy + live-status text for the 3 engine modes, used by both the
 * Basic-mode Engine strip and the Expert Coherence Engine panel.
 */
import type { EngineMode, EngineStatus } from '../../engine/coherenceEngine';

export interface EngineModeInfo {
  id: EngineMode;
  title: string;
  sub: string;
  /** Short tooltip / one-liner. */
  desc: string;
  /** Full explanation shown in the info popover. */
  details: string;
  /** Peer-reviewed references the method is based on (shown in the popover). */
  references?: string[];
}

export const ENGINE_MODE_INFO: EngineModeInfo[] = [
  {
    id: 'firmware',
    title: 'Standard',
    sub: 'on-glasses',
    desc: 'The glasses run their built-in coherence programs.',
    details:
      'The glasses do the coherence processing on-device. The dashboard just forwards your heartbeats and shows the readouts. Pick one of the Standard Programs (Heartbeat, Breathing Guide, Coherence Lens, Breath + Strobe) to choose what the lens does. This is the original behavior — nothing is computed in the app.',
  },
  {
    id: 'modeA',
    title: 'Mode A',
    sub: 'Follow',
    desc: 'App-side coherence training that paces your breathing.',
    details:
      'Coherence biofeedback, computed in the app. Every second it measures your heart-rate variability with a Lomb–Scargle spectrum, finds the breathing rate you are naturally drifting toward, and gently paces you there (drifting ±0.2 br/min per breath, never jumping). The lens clears as your HRV becomes more coherent — the score is the field-standard coherence ratio, peak ÷ (total − peak), shown 0–100. Works with the earclip or a Polar H10.',
    references: [
      'McCraty R, Childre D. Coherence: bridging personal, social, and global health. Altern Ther Health Med. 2010;16(4):10–24. (the coherence-ratio method)',
      'Lehrer PM, Gevirtz R. Heart rate variability biofeedback: how and why does it work? Front Psychol. 2014;5:756.',
      'Shaffer F, Ginsberg JP. An overview of heart rate variability metrics and norms. Front Public Health. 2017;5:258.',
    ],
  },
  {
    id: 'modeB',
    title: 'Mode B',
    sub: 'Resonance',
    desc: 'Finds your personal resonance breathing rate.',
    details:
      'Resonance-frequency training (the Lehrer / Vaschillo protocol, automated). It paces you across a range of slow breathing rates (about 4–7.5 br/min), measures how big your HRV swings are at each, and climbs toward the rate that produces the largest swings — your personal resonance frequency, where heart and breath line up. Each held rate is verified against your ACTUAL breathing, measured from the Polar H10’s accelerometer, so it cannot be fooled by the ~0.1 Hz Mayer wave. Needs a Polar H10. Once found, it locks the rate and gently maintains it. Sit still while it searches.',
    references: [
      'Lehrer PM, Vaschillo E, Vaschillo B. Resonant frequency biofeedback training to increase cardiac variability. Appl Psychophysiol Biofeedback. 2000;25(3):177–191.',
      'Vaschillo EG, Vaschillo B, Lehrer PM. Characteristics of resonance in HRV stimulated by biofeedback. Appl Psychophysiol Biofeedback. 2006;31(2):129–142.',
      'Lehrer PM, Gevirtz R. Heart rate variability biofeedback: how and why does it work? Front Psychol. 2014;5:756.',
    ],
  },
];

/* Plain-language, real-time description of what the Mode B controller is doing right now —
 * surfaced under the Engine box so the user follows the search as it happens. */
export function modeBStatusText(status: EngineStatus): string {
  if (status.searchAborted) {
    return status.searchAbortReason === 'unmeasured'
      ? 'Paused — the H10 accelerometer never came online, so your breathing could not be read at all. Check the strap is snug and the H10 is charged, then re-select Mode B.'
      : 'Paused — your breathing could not be confirmed from the H10. Sit still, keep the strap snug, then re-select Mode B.';
  }
  if (status.modeBState === 'maintaining' && status.lockedRF != null) {
    return `Found it — holding your resonance at ${status.lockedRF.toFixed(1)} br/min and tracking small drifts${
      status.boundaryLimited ? ' (this is at the edge of the search range)' : ''
    }.`;
  }
  // Searching.
  const rate = status.modeBCommandedBpm != null ? status.modeBCommandedBpm.toFixed(1) : '—';
  const p = status.modeBProgress;
  const breath = p ? ` (breath ${Math.min(p.breath, p.dwellBreaths)} of ${p.dwellBreaths})` : '';
  const best = p && p.bestRate != null ? ` Strongest response so far: ${p.bestRate.toFixed(1)} br/min.` : '';
  const tested = p && p.testedCount > 0 ? ` ${p.testedCount} rate${p.testedCount > 1 ? 's' : ''} tested.` : '';
  const hold =
    status.unmeasuredDwells > 0
      ? ' Warming up the breathing sensor — sit still while the H10 accelerometer comes online (a few seconds).'
      : status.unverifiedDwells > 0
        ? ` Hold still and follow the cue — the H10 couldn’t confirm your breathing on the last ${status.unverifiedDwells} attempt${status.unverifiedDwells > 1 ? 's' : ''} at this rate, so they’re re-measured.`
        : '';
  let lead: string;
  switch (p?.phase) {
    case 'baseline':
      lead = `Pacing you at ${rate} br/min to read your baseline${breath}.`;
      break;
    case 'climbing':
      lead = `Climbing toward your resonance — holding ${rate} br/min${breath} and comparing how strong your heart-rate swings are.${best}`;
      break;
    case 'refining':
      lead = `Zeroing in — fine-tuning around ${rate} br/min${breath}.${best}`;
      break;
    default:
      lead = `Pacing you at ${rate} br/min and measuring your heart-rate swings${breath}.`;
  }
  return lead + tested + hold;
}
