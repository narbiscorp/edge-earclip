import { useEffect, useState } from 'react';
import { useDashboardStore } from './store';

/** Returns the current paced-breath phase for the Live header cue. The
 * 40/60 inhale:exhale split mirrors the firmware's breathing programs
 * (Program 2 BREATHE, Program 4 BREATHE+STROBE) so the on-screen
 * "Inhale" / "Exhale" cue stays in lockstep with what the lens is
 * physically doing.
 *
 * Pacer rate comes from `lastEdgeCoherence.pacerBpm` when the glasses
 * is streaming coherence; otherwise we default to 6 BPM — the resonance
 * frequency every coherence-training literature converges on, and the
 * firmware's BREATHE_BPM_DEFAULT.
 *
 * Phase boundaries land at 0.4× and 1.0× of the cycle (4 s and 10 s at
 * 6 BPM), so a 200 ms poll interval is plenty — no need for rAF here.
 *
 * Also returns the fractional position within the current phase
 * (0..1, monotonic) for callers that want to crossfade or animate
 * subtly mid-phase. The header cue only needs the string. */
export interface BreathState {
  /** 'inhale' for the first 40 % of the cycle, 'exhale' for the last 60 %. */
  phase: 'inhale' | 'exhale';
  /** 0..1 within the current phase. Resets to 0 at each phase boundary. */
  progress: number;
  /** Resolved pacer in BPM. */
  bpm: number;
}

export function useBreathPhase(): BreathState {
  const lastEdgeCoh = useDashboardStore((s) => s.lastEdgeCoherence);
  const pacerBpm =
    lastEdgeCoh && lastEdgeCoh.pacerBpm > 0 ? lastEdgeCoh.pacerBpm : 6;

  const compute = (): BreathState => {
    const cycleMs = (60 / pacerBpm) * 1000;
    const inhaleMs = cycleMs * 0.4;
    const t = Date.now() % cycleMs;
    if (t < inhaleMs) {
      return { phase: 'inhale', progress: t / inhaleMs, bpm: pacerBpm };
    }
    return {
      phase: 'exhale',
      progress: (t - inhaleMs) / (cycleMs - inhaleMs),
      bpm: pacerBpm,
    };
  };

  const [state, setState] = useState<BreathState>(compute);

  useEffect(() => {
    /* 200 ms is well under the shortest phase (≥4 s at 6 BPM) but coarse
     * enough that we're not doing 60 fps work for a label that only flips
     * twice per cycle. */
    const id = window.setInterval(() => setState(compute()), 200);
    /* Recompute once immediately so a pacerBpm change isn't waiting for
     * the next tick. */
    setState(compute());
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pacerBpm]);

  return state;
}
