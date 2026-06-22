import { useEffect, useRef, useState } from 'react';
import { useDashboardStore } from './store';

/* Approximates the firmware's `effective_duty` (0..1) at ~30 fps. The
 * firmware doesn't stream lens duty back to the dashboard, so this is a
 * visual mirror computed from the active program + the most recent
 * coherence frame + the most recent beat timestamp:
 *
 *   Program 1 (HEARTBEAT)   — cosine pulse on each beat (150 ms, 80% peak)
 *   Program 2 (BREATHE)     — 40/60 sine waveform at pacerBpm × coh scale
 *   Program 3 (LENS)        — opacity = (100 − coh) / 100
 *   Program 4 (BREATHE+STR) — Program 2's waveform × ~3 Hz square
 *   Standalone modes        — solid / breathe / strobe / pulse variants
 *
 * Shared between GlassesVisual (renders the lens shape) and LensTintBar
 * (the horizontal coherence bar in the live view). Returns 0 when the
 * glasses aren't connected. */
export function useLensOpacity(): number {
  const program = useDashboardStore((s) => s.activeProgram);
  const standalone = useDashboardStore((s) => s.standaloneMode);
  const lastEdgeCoh = useDashboardStore((s) => s.lastEdgeCoherence);
  const lastBeatAt = useDashboardStore((s) => s.lastBeatAt);
  const edgeConnected = useDashboardStore((s) => s.connection.edge.state === 'connected');
  const settling = useDashboardStore((s) => !!s.engineStatus?.settling);

  const [opacity, setOpacity] = useState(0);
  const refs = useRef({ program, standalone, lastEdgeCoh, lastBeatAt, settling });
  refs.current = { program, standalone, lastEdgeCoh, lastBeatAt, settling };

  useEffect(() => {
    if (!edgeConnected) {
      setOpacity(0);
      return;
    }
    let raf = 0;
    const tick = () => {
      const { program, standalone, lastEdgeCoh, lastBeatAt, settling } = refs.current;
      const now = Date.now();
      let target = 0;
      if (settling) {
        // Mode B/C quiet settling: lens held fully clear (mirrors the engine's depth-0 setpoint).
        target = 0;
      } else if (standalone === 'static') {
        target = 0.5;
      } else if (standalone === 'breathe') {
        const cycleMs = 60000 / 6;
        const phase = (now % cycleMs) / cycleMs;
        let frac: number;
        if (phase < 0.4) frac = (1 - Math.cos(Math.PI * (phase / 0.4))) / 2;
        else frac = (1 + Math.cos(Math.PI * ((phase - 0.4) / 0.6))) / 2;
        target = frac;
      } else if (standalone === 'strobe') {
        target = Math.floor(now / 167) % 2 ? 0.7 : 0.05;
      } else if (standalone === 'pulse' || program === 1) {
        if (lastBeatAt != null) {
          const elapsed = now - lastBeatAt;
          if (elapsed >= 0 && elapsed < 150) {
            const p = elapsed / 150;
            const env = (1 + Math.cos(Math.PI * p)) / 2;
            target = env * 0.8;
          }
        }
      } else if (program === 2 || program === 4) {
        const bpm = lastEdgeCoh?.pacerBpm && lastEdgeCoh.pacerBpm > 0 ? lastEdgeCoh.pacerBpm : 6;
        const cycleMs = 60000 / bpm;
        const phase = (now % cycleMs) / cycleMs;
        let frac: number;
        if (phase < 0.4) {
          const p = phase / 0.4;
          frac = (1 - Math.cos(Math.PI * p)) / 2;
        } else {
          const p = (phase - 0.4) / 0.6;
          frac = (1 + Math.cos(Math.PI * p)) / 2;
        }
        const coh = lastEdgeCoh?.coh ?? 0;
        const cohScale = 1 - (coh / 100) * 0.8;
        target = frac * cohScale;
        if (program === 4) {
          const strobePhase = Math.floor(now / 167) % 2;
          target = strobePhase ? target : target * 0.15;
        }
      } else if (program === 3) {
        const coh = lastEdgeCoh?.coh ?? 0;
        target = (100 - coh) / 100;
      }

      const isStrobing = standalone === 'strobe' || program === 4;
      const alpha = isStrobing ? 0.6 : 0.25;
      setOpacity((prev) => prev + (target - prev) * alpha);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [edgeConnected]);

  return opacity;
}
