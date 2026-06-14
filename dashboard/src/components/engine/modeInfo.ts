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
  },
  {
    id: 'modeB',
    title: 'Mode B',
    sub: 'Resonance',
    desc: 'Finds your personal resonance breathing rate.',
    details:
      'Resonance-frequency training (the Lehrer / Vaschillo protocol, automated). It paces you across a range of slow breathing rates (about 4–7.5 br/min), measures how big your HRV swings are at each, and climbs toward the rate that produces the largest swings — your personal resonance frequency, where heart and breath line up. Each held rate is verified against your ACTUAL breathing, measured from the Polar H10’s accelerometer, so it cannot be fooled by the ~0.1 Hz Mayer wave. Needs a Polar H10. Once found, it locks the rate and gently maintains it. Sit still while it searches.',
  },
];

/* Plain-language, real-time description of what the Mode B controller is doing right now —
 * surfaced under the Engine box so the user follows the search as it happens. */
export function modeBStatusText(status: EngineStatus): string {
  if (status.searchAborted) {
    return 'Search stopped — your breathing could not be verified. Check the H10 strap and sit still, then re-select Mode B.';
  }
  if (status.modeBState === 'maintaining' && status.lockedRF != null) {
    return `Locked at ${status.lockedRF.toFixed(1)} br/min — maintaining your resonance${
      status.boundaryLimited ? ' (at the search-band edge)' : ''
    }.`;
  }
  const testing =
    status.modeBCommandedBpm != null ? ` testing ${status.modeBCommandedBpm.toFixed(1)} br/min` : '';
  const hold =
    status.unverifiedDwells > 0 ? ` · hold still (${status.unverifiedDwells} unverified)` : '';
  return `Searching for your resonance —${testing}${hold}`;
}
