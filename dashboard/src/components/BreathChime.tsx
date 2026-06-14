import { useEffect, useRef } from 'react';
import { useDashboardStore } from '../state/store';
import { useBreathPhase } from '../state/useBreathPhase';
import { playChime } from '../audio/chime';

/*
 * BreathChime — plays the inhale/exhale cue on each paced-breath phase change.
 *
 * Renders nothing; mount once at the app root. Only fires when the chime is enabled AND a
 * breathing pacer is actually active (the app-side engine is running, or a firmware breathing
 * program / standalone breathe is selected), so it never chimes against a phantom 6-br/min
 * cycle when nothing is guiding the breath.
 */
export default function BreathChime() {
  const enabled = useDashboardStore((s) => s.chimeEnabled);
  const inhaleVoice = useDashboardStore((s) => s.chimeInhale);
  const exhaleVoice = useDashboardStore((s) => s.chimeExhale);
  const engineRunning = useDashboardStore((s) => !!s.engineStatus?.running);
  const activeProgram = useDashboardStore((s) => s.activeProgram);
  const standalone = useDashboardStore((s) => s.standaloneMode);
  const breath = useBreathPhase();
  const lastPhase = useRef<'inhale' | 'exhale' | null>(null);

  const pacerActive =
    engineRunning || activeProgram === 2 || activeProgram === 4 || standalone === 'breathe';
  const active = enabled && pacerActive;

  useEffect(() => {
    if (!active) {
      lastPhase.current = breath.phase;
      return;
    }
    if (lastPhase.current !== null && lastPhase.current !== breath.phase) {
      if (breath.phase === 'inhale') playChime(inhaleVoice, 'inhale');
      else playChime(exhaleVoice, 'exhale');
    }
    lastPhase.current = breath.phase;
  }, [breath.phase, active, inhaleVoice, exhaleVoice]);

  return null;
}
