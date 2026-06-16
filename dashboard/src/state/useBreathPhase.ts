import { useEffect, useRef, useState } from 'react';
import { useDashboardStore } from './store';
import { coherenceEngine } from '../engine/coherenceEngine';

/** Returns the current paced-breath phase for the Live header cue, the breathing-cue graph,
 * and the inhale/exhale chime. The 40/60 inhale:exhale split mirrors the firmware's breathing
 * programs and the app-side engine.
 *
 * Pacer rate comes from `lastEdgeCoherence.pacerBpm` (the engine synthesizes this when Mode A/B
 * is running; otherwise it's the firmware 0xF2 value), defaulting to 6 BPM.
 *
 * IMPORTANT: the phase is accumulated CONTINUOUSLY (advanced by dt/cycleMs each tick), NOT
 * derived from `Date.now() % cycleMs`. The modulo form jumps whenever the rate changes — which
 * happens ~1×/sec as the pacer slews — and that jump can hop across the inhale/exhale boundary,
 * firing a spurious, out-of-sync chime. Accumulating means a rate change only changes how fast
 * the phase advances, never its current position. */
export interface BreathState {
  /** 'inhale' for the first 40 % of the cycle, 'exhale' for the last 60 %. */
  phase: 'inhale' | 'exhale';
  /** 0..1 within the current phase. Resets to 0 at each phase boundary. */
  progress: number;
  /** Resolved pacer in BPM. */
  bpm: number;
}

function phaseToState(p: number, bpm: number): BreathState {
  if (p < 0.4) return { phase: 'inhale', progress: p / 0.4, bpm };
  return { phase: 'exhale', progress: (p - 0.4) / 0.6, bpm };
}

export function useBreathPhase(): BreathState {
  const pacerBpm = useDashboardStore((s) =>
    s.lastEdgeCoherence && s.lastEdgeCoherence.pacerBpm > 0 ? s.lastEdgeCoherence.pacerBpm : 6,
  );
  const bpmRef = useRef(pacerBpm);
  bpmRef.current = pacerBpm;

  const phaseRef = useRef(0); // 0..1 continuous cycle position
  const lastTsRef = useRef(Date.now());
  const [state, setState] = useState<BreathState>(() => phaseToState(0, pacerBpm));

  useEffect(() => {
    /* 100 ms keeps the boundary crisp (the chime fires within 100 ms of the true edge) while
     * staying cheap. Advance by ACTUAL elapsed time so there's no drift. */
    const id = window.setInterval(() => {
      const now = Date.now();
      // When the engine is running it is the single breath-clock authority (it also commands the
      // firmware rate), so lock the cue + chime to its cycle position. Otherwise self-animate from
      // the firmware/standalone pacer rate.
      const enginePos = coherenceEngine.breathCyclePos();
      if (enginePos != null) {
        phaseRef.current = enginePos;
        lastTsRef.current = now;
        setState(phaseToState(enginePos, coherenceEngine.breathBpm));
        return;
      }
      const cycleMs = (60 / bpmRef.current) * 1000;
      const dt = now - lastTsRef.current;
      lastTsRef.current = now;
      let p = phaseRef.current + dt / cycleMs;
      p -= Math.floor(p); // wrap to [0,1)
      phaseRef.current = p;
      setState(phaseToState(p, bpmRef.current));
    }, 100);
    return () => window.clearInterval(id);
  }, []);

  return state;
}
