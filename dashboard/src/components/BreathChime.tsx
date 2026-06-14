import { useEffect, useRef } from 'react';
import { useDashboardStore } from '../state/store';
import { useBreathPhase } from '../state/useBreathPhase';
import { playChime } from '../audio/chime';

/*
 * BreathChime — plays the inhale/exhale cue on each paced-breath phase change.
 *
 * Renders nothing; mount once at the app root. Only fires when the chime is enabled AND the
 * app-side engine (Mode A/B) is running — NOT in Standard/firmware mode, where the glasses drive
 * the breath cycle on a phase the dashboard can't observe (the chime would drift). This also
 * avoids chiming against a phantom 6-br/min cycle when nothing is guiding the breath.
 */
export default function BreathChime() {
  const enabled = useDashboardStore((s) => s.chimeEnabled);
  const inhaleVoice = useDashboardStore((s) => s.chimeInhale);
  const exhaleVoice = useDashboardStore((s) => s.chimeExhale);
  const engineRunning = useDashboardStore((s) => !!s.engineStatus?.running);
  const engineMode = useDashboardStore((s) => s.engineMode);
  const activeProgram = useDashboardStore((s) => s.activeProgram);
  const standalone = useDashboardStore((s) => s.standaloneMode);
  const breath = useBreathPhase();
  const lastPhase = useRef<'inhale' | 'exhale' | null>(null);
  const lastChimeAt = useRef(0);

  const pacerActive =
    engineRunning || activeProgram === 2 || activeProgram === 4 || standalone === 'breathe';
  // Suppress in Standard/firmware mode — the glasses drive the breath cycle there on a phase we
  // can't observe, so a chime would drift. The chime plays only when the engine owns the clock (A/B).
  const active = enabled && pacerActive && engineMode !== 'firmware';

  useEffect(() => {
    if (!active) {
      lastPhase.current = breath.phase;
      return;
    }
    if (lastPhase.current !== null && lastPhase.current !== breath.phase) {
      // Defense-in-depth on top of the continuous-phase fix: ignore a flip that arrives
      // implausibly soon after the last cue (real inhale/exhale phases are ≥ ~2 s at ≤ 12 br/min).
      const now = Date.now();
      if (now - lastChimeAt.current >= 1200) {
        lastChimeAt.current = now;
        if (breath.phase === 'inhale') playChime(inhaleVoice, 'inhale');
        else playChime(exhaleVoice, 'exhale');
      }
    }
    lastPhase.current = breath.phase;
  }, [breath.phase, active, inhaleVoice, exhaleVoice]);

  return null;
}
