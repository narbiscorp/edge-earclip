import { useEffect, useMemo, useRef, useState } from 'react';
import { useDashboardStore } from '../state/store';

/*
 * BreathCue — an animated inhale/exhale pacing cue (replaces the lens-tint bar).
 *
 * Draws one breath cycle as a curve (40 % inhale rise, 60 % exhale fall — the same shape the
 * lens follows) with an orb tracing along it, so you breathe by following the orb up and
 * down. Self-animates at the pacer rate (from the engine / firmware breathing program).
 */

/** Fraction (0 empty → 1 full inhale) at cycle position p∈[0,1): 40 % inhale, 60 % exhale. */
function breathFrac(p: number): number {
  if (p < 0.4) return (1 - Math.cos((Math.PI * p) / 0.4)) / 2;
  return (1 + Math.cos((Math.PI * (p - 0.4)) / 0.6)) / 2;
}

const W = 300;
const H = 76;
const PAD = 10;

export default function BreathCue({ hint }: { hint?: string }) {
  const pacerBpm = useDashboardStore((s) =>
    s.lastEdgeCoherence?.pacerBpm && s.lastEdgeCoherence.pacerBpm > 0 ? s.lastEdgeCoherence.pacerBpm : 6,
  );
  const bpmRef = useRef(pacerBpm);
  bpmRef.current = pacerBpm;

  const orbRef = useRef<SVGCircleElement>(null);
  const headRef = useRef<SVGLineElement>(null);
  const [phase, setPhase] = useState<'inhale' | 'exhale'>('inhale');

  const curve = useMemo(() => {
    const pts: string[] = [];
    const N = 120;
    for (let i = 0; i <= N; i++) {
      const p = i / N;
      const x = PAD + p * (W - 2 * PAD);
      const y = H - PAD - breathFrac(p) * (H - 2 * PAD);
      pts.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`);
    }
    return pts.join(' ');
  }, []);

  useEffect(() => {
    let raf = 0;
    let lastPhase = '';
    const tick = () => {
      const cycleMs = (60 / bpmRef.current) * 1000;
      const p = (Date.now() % cycleMs) / cycleMs;
      const x = PAD + p * (W - 2 * PAD);
      const y = H - PAD - breathFrac(p) * (H - 2 * PAD);
      orbRef.current?.setAttribute('cx', x.toFixed(1));
      orbRef.current?.setAttribute('cy', y.toFixed(1));
      if (headRef.current) {
        headRef.current.setAttribute('x1', x.toFixed(1));
        headRef.current.setAttribute('x2', x.toFixed(1));
      }
      const ph = p < 0.4 ? 'inhale' : 'exhale';
      if (ph !== lastPhase) {
        lastPhase = ph;
        setPhase(ph);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="rounded-xl border border-slate-800/80 bg-slate-900/60 px-4 py-3">
      <div className="flex items-baseline justify-between mb-1.5">
        <div className="text-[10px] tracking-[0.18em] uppercase text-slate-400">Breathe with the cue</div>
        <div className="text-sm tabular-nums text-slate-200">
          {pacerBpm.toFixed(1)} <span className="text-[10px] text-slate-500">br/min</span>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 76 }} preserveAspectRatio="none">
        <defs>
          <linearGradient id="breathstroke" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#22d3ee" />
            <stop offset="100%" stopColor="#34d399" />
          </linearGradient>
        </defs>
        <path d={curve} fill="none" stroke="url(#breathstroke)" strokeWidth={2} opacity={0.55} strokeLinecap="round" />
        <line ref={headRef} y1={PAD - 4} y2={H - PAD + 4} stroke="#94a3b8" strokeWidth={1} opacity={0.35} />
        <circle ref={orbRef} r={6} fill="#5eead4" stroke="#0f172a" strokeWidth={1.5} />
      </svg>
      <div className="flex items-baseline justify-between mt-1">
        <span
          className={'text-base font-serif italic ' + (phase === 'inhale' ? 'text-cyan-300' : 'text-emerald-300')}
        >
          {phase === 'inhale' ? 'Inhale ↑' : 'Exhale ↓'}
        </span>
        {hint ? <span className="text-xs italic font-serif text-slate-400">{hint}</span> : null}
      </div>
    </div>
  );
}
