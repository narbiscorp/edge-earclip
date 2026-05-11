import { useEffect, useRef, useState } from 'react';
import { useDashboardStore } from '../state/store';
import {
  edgeDevice,
  type CoherenceDifficulty,
  type PpgProgram,
} from '../ble/edgeDevice';
import BeatChart from './BeatChart';

/* Friendly labels for the four PPG programs the firmware ships. The
 * expert UI shows them as "Prog 1 / 2 / 3 / 4"; a lay user is going to
 * want to know what each one actually does to the lens. */
const PROGRAM_INFO: Record<PpgProgram, { title: string; desc: string }> = {
  1: {
    title: 'Heartbeat Pulse',
    desc: 'Lens pulses softly with each heartbeat. Good for tuning into your pulse.',
  },
  2: {
    title: 'Breathing Guide',
    desc: 'Lens follows a calm breathing rhythm — adapts to your detected breathing rate.',
  },
  3: {
    title: 'Coherence Lens',
    desc: 'Lens clears as your heart-rate variability gets smoother. Quiet biofeedback.',
  },
  4: {
    title: 'Breath + Strobe',
    desc: 'Breathing rhythm with a gentle 10 Hz strobe. The most stimulating program.',
  },
};

/* Color hint for the coherence score. Tracks the same zones the firmware
 * uses internally — low / moderate / good. */
function cohColor(coh: number | null): string {
  if (coh == null) return 'text-slate-500';
  if (coh >= 70) return 'text-emerald-400';
  if (coh >= 30) return 'text-cyan-300';
  return 'text-amber-300';
}
function cohLabel(coh: number): string {
  if (coh >= 70) return 'High coherence';
  if (coh >= 30) return 'Building';
  return 'Settling';
}

/* Brainwave-entrainment frequency presets for the strobe (Program 4 +
 * standalone strobe). Values from Hutchison / Siever frequency-following-
 * response literature; band labels are conventional EEG ranges. The
 * dashboard sends the value at 0.1 Hz precision via the extended 0xAB
 * opcode (firmware v4.14.41+). */
const STROBE_PRESETS: Array<{ label: string; band: string; hz: number }> = [
  { label: 'Deep Relaxation', band: 'Delta',      hz: 2.0 },
  { label: 'Theta',           band: 'Theta',      hz: 6.0 },
  { label: 'Meditation',      band: 'Alpha',      hz: 10.0 },
  { label: 'Calm Focus',      band: 'low-Beta',   hz: 13.5 },
  { label: 'Focus',           band: 'Beta',       hz: 17.5 },
  { label: 'Gamma',           band: 'Gamma',      hz: 30.0 },
  { label: 'Gamma+',          band: 'high-Gamma', hz: 40.0 },
];

export default function BasicMode() {
  const polarConn = useDashboardStore((s) => s.connection.polar.state);
  const edgeConn = useDashboardStore((s) => s.connection.edge.state);
  const narbisConn = useDashboardStore((s) => s.connection.narbis.state);
  const lastBeat = useDashboardStore((s) => s.lastBeat);
  const lastPolarBeat = useDashboardStore((s) => s.lastPolarBeat);
  const lastEdgeCoh = useDashboardStore((s) => s.lastEdgeCoherence);
  const hrSource = useDashboardStore((s) => s.hrSourceForGlasses);
  const program = useDashboardStore((s) => s.activeProgram);
  const setActiveProgram = useDashboardStore((s) => s.setActiveProgram);

  /* Derived metrics. Each can be null when its data source isn't reporting. */
  const hrBpm = hrSource === 'h10'
    ? (lastPolarBeat?.bpm ?? null)
    : (lastBeat?.bpm ?? null);
  const coh = lastEdgeCoh?.coh ?? null;
  const respBpm = lastEdgeCoh != null && lastEdgeCoh.respMhz > 0
    ? (lastEdgeCoh.respMhz * 60) / 1000
    : null;
  const pacerBpm = lastEdgeCoh?.pacerBpm ?? 0;

  const edgeConnected = edgeConn === 'connected';
  const hrConnected = polarConn === 'connected' || narbisConn === 'connected';

  /* Local settings state — mirrored to the firmware via edgeDevice setters.
   * No read-back path from the glasses, so these default to reasonable
   * values; the user adjusts and we push. */
  const [difficulty, setDifficulty] = useState<CoherenceDifficulty>('easy');
  const [lensLimit, setLensLimit] = useState(100);
  const [adaptive, setAdaptive] = useState(true);
  const [strobeHz, setStrobeHz] = useState(10.0);

  /* Re-push lens limit + adaptive on every edge-connect since the
   * glasses' NVS may have a stale value the user reset elsewhere. */
  useEffect(() => {
    if (!edgeConnected) return;
    void edgeDevice.setLensLimitPct(lensLimit).catch(console.error);
    void edgeDevice.setAdaptivePacer(adaptive).catch(console.error);
    void edgeDevice.setDifficulty(difficulty).catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edgeConnected]);

  const commitStrobeHz = (hz: number): void => {
    setStrobeHz(hz);
    if (edgeConnected) {
      void edgeDevice.setStrobeFreqHz(hz).catch(console.error);
    }
  };

  return (
    <div className="flex-1 overflow-auto bg-slate-950">
      <div className="max-w-3xl mx-auto p-6 space-y-6">
        {/* Connection hint */}
        {(!edgeConnected || !hrConnected) && (
          <div className="rounded-lg border border-amber-700/50 bg-amber-900/20 p-4">
            <div className="text-amber-200 font-medium mb-1">Get started</div>
            <ol className="text-sm text-amber-100/80 space-y-0.5 list-decimal list-inside">
              {!hrConnected && <li>Connect a heart-rate source (Polar H10 or earclip) using the header buttons.</li>}
              {!edgeConnected && <li>Connect your Narbis Edge glasses using the header buttons.</li>}
              <li>Once both are green, pick a mode below.</li>
            </ol>
          </div>
        )}

        {/* Metric cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <MetricCard
            label="Coherence"
            value={coh != null ? `${coh}` : '—'}
            unit={coh != null ? '/100' : ''}
            colorClass={cohColor(coh)}
            sub={coh != null ? cohLabel(coh) : 'connect glasses'}
          />
          <MetricCard
            label="Breathing"
            value={respBpm != null ? respBpm.toFixed(2) : '—'}
            unit="BPM"
            colorClass="text-pink-300"
            sub={pacerBpm > 0 ? `Lens paces at ${pacerBpm} BPM` : (lastEdgeCoh ? 'waiting for resonance' : '')}
          />
          <MetricCard
            label="Heart rate"
            value={hrBpm != null ? `${hrBpm}` : '—'}
            unit="BPM"
            colorClass="text-rose-300"
            sub={hrConnected ? (hrSource === 'h10' ? 'Polar H10' : 'Earclip') : 'no source'}
          />
        </div>

        {/* Live glasses visual + IBI tachogram */}
        <Card title="Live view">
          <div className="flex justify-center">
            <GlassesVisual />
          </div>
          <div className="rounded border border-slate-800 overflow-hidden">
            <BeatChart compact defaultSmoothN={7} defaultShape="spline" />
          </div>
        </Card>

        {/* Program selector — the four named cards. */}
        <Card title="Mode" disabled={!edgeConnected}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {([1, 2, 3, 4] as PpgProgram[]).map((p) => {
              const info = PROGRAM_INFO[p];
              const active = program === p;
              return (
                <button
                  key={p}
                  disabled={!edgeConnected}
                  onClick={() => void setActiveProgram(p)}
                  className={
                    'text-left rounded-lg p-3 border transition disabled:opacity-50 ' +
                    (active
                      ? 'bg-indigo-600/30 border-indigo-500 text-white'
                      : 'bg-slate-900/70 border-slate-700 hover:border-slate-500 text-slate-100')
                  }
                >
                  <div className="font-medium text-sm">{info.title}</div>
                  <div className="text-xs text-slate-400 mt-1 leading-snug">{info.desc}</div>
                </button>
              );
            })}
          </div>
        </Card>

        {/* Strobe frequency — presets + slider. Used by Program 4 and the
            expert standalone strobe. Brainwave-band presets target common
            entrainment frequencies; the slider supports 0.1 Hz precision
            for users who want to dial in a specific value. */}
        <Card title="Strobe Frequency" disabled={!edgeConnected}>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1">
            {STROBE_PRESETS.map((preset) => {
              const active = Math.abs(strobeHz - preset.hz) < 0.05;
              return (
                <button
                  key={preset.label}
                  disabled={!edgeConnected}
                  onClick={() => commitStrobeHz(preset.hz)}
                  className={
                    'text-left rounded px-2 py-1.5 border text-xs disabled:opacity-50 ' +
                    (active
                      ? 'bg-indigo-600/30 border-indigo-500 text-white'
                      : 'bg-slate-800 border-slate-700 hover:border-slate-500 text-slate-200')
                  }
                  title={`${preset.band} band`}
                >
                  <div className="font-medium">{preset.label}</div>
                  <div className="text-slate-400 text-[10px]">{preset.hz.toFixed(1)} Hz · {preset.band}</div>
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-3 pt-2">
            <input
              type="range"
              min={1.0}
              max={50.0}
              step={0.1}
              value={strobeHz}
              disabled={!edgeConnected}
              onChange={(e) => setStrobeHz(Number(e.target.value))}
              onMouseUp={(e) => commitStrobeHz(Number((e.target as HTMLInputElement).value))}
              onTouchEnd={(e) => commitStrobeHz(Number((e.target as HTMLInputElement).value))}
              onKeyUp={(e) => commitStrobeHz(Number((e.target as HTMLInputElement).value))}
              className="flex-1 accent-indigo-500 disabled:opacity-50"
            />
            <span className="text-sm tabular-nums w-16 text-right">{strobeHz.toFixed(1)} Hz</span>
          </div>
          <div className="text-[11px] text-slate-500 leading-snug">
            Strobe only flashes during the <span className="font-medium">Breath + Strobe</span> program.
            Brainwave bands are approximate — try a few and notice how each feels.
          </div>
        </Card>

        {/* Difficulty + lens darkness + adaptive pacer */}
        <Card title="Settings" disabled={!edgeConnected}>
          <Row label="Difficulty" help="How responsive the lens is to changes in your coherence.">
            <div className="grid grid-cols-4 gap-1">
              {(['easy', 'medium', 'hard', 'expert'] as CoherenceDifficulty[]).map((d) => (
                <button
                  key={d}
                  disabled={!edgeConnected}
                  onClick={() => {
                    setDifficulty(d);
                    void edgeDevice.setDifficulty(d).catch(console.error);
                  }}
                  className={
                    'rounded px-2 py-1 text-xs disabled:opacity-50 ' +
                    (difficulty === d
                      ? 'bg-indigo-600 text-white'
                      : 'bg-slate-700 hover:bg-slate-600 text-slate-200')
                  }
                >
                  {d.charAt(0).toUpperCase() + d.slice(1)}
                </button>
              ))}
            </div>
          </Row>

          <Row label="Max lens darkness" help="Caps how dark the lens can get. Lower if it feels too intense.">
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={lensLimit}
                disabled={!edgeConnected}
                onChange={(e) => setLensLimit(Number(e.target.value))}
                onMouseUp={(e) => edgeDevice.setLensLimitPct(Number((e.target as HTMLInputElement).value)).catch(console.error)}
                onTouchEnd={(e) => edgeDevice.setLensLimitPct(Number((e.target as HTMLInputElement).value)).catch(console.error)}
                onKeyUp={(e) => edgeDevice.setLensLimitPct(Number((e.target as HTMLInputElement).value)).catch(console.error)}
                className="flex-1 accent-indigo-500 disabled:opacity-50"
              />
              <span className="text-sm tabular-nums w-12 text-right">{lensLimit}%</span>
            </div>
          </Row>

          <Row
            label="Follow my breathing rate"
            help="When on, the breathing programs (Breathing Guide, Breath + Strobe) start at 6 BPM and adjust to your actual breathing rate. Turn off for a fixed 6 BPM pace."
          >
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={adaptive}
                disabled={!edgeConnected}
                onChange={(e) => {
                  setAdaptive(e.target.checked);
                  void edgeDevice.setAdaptivePacer(e.target.checked).catch(console.error);
                }}
                className="accent-indigo-500"
              />
              <span className="text-sm text-slate-200">{adaptive ? 'On' : 'Off'}</span>
            </label>
          </Row>
        </Card>

        {/* Standalone modes — drive the lens directly without needing a
            heart-rate source. Useful when the glasses are worn alone
            (no earclip / H10) or for testing the lens itself. */}
        <StandaloneSection edgeConnected={edgeConnected} />
      </div>
    </div>
  );
}

/* Standalone modes — Static / Strobe / Breathe / Pulse on Beat. These
 * bypass the coherence pipeline entirely; they drive the lens directly
 * via the firmware's mode-switch opcodes (0xA5/0xA6/0xB0/0xB6). Pulse on
 * Beat still needs a heart-rate source (it flashes on each detected beat)
 * but doesn't run coherence. */
function StandaloneSection({ edgeConnected }: { edgeConnected: boolean }) {
  const standalone = useDashboardStore((s) => s.standaloneMode);
  const setStandalone = useDashboardStore((s) => s.setStandaloneMode);
  const [staticDuty, setStaticDuty] = useState(50);

  const STANDALONE_INFO: Array<{
    key: 'static' | 'strobe' | 'breathe' | 'pulse';
    title: string;
    desc: string;
  }> = [
    { key: 'static',  title: 'Solid Tint',     desc: 'Lens darkens to a fixed level. No motion.' },
    { key: 'breathe', title: 'Breathe (no HR)', desc: 'Lens guides 6 BPM breathing. No heart sensor needed.' },
    { key: 'strobe',  title: 'Strobe Only',    desc: 'Flashes at the Strobe Frequency set above. Brainwave entrainment.' },
    { key: 'pulse',   title: 'Pulse on Beat',  desc: 'Flashes once per detected heartbeat. Needs a heart sensor.' },
  ];

  return (
    <Card title="Standalone Modes (no HR sensor needed)" disabled={!edgeConnected}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {STANDALONE_INFO.map((s) => {
          const active = standalone === s.key;
          return (
            <button
              key={s.key}
              disabled={!edgeConnected}
              onClick={() => void setStandalone(s.key, s.key === 'static' ? staticDuty : undefined)}
              className={
                'text-left rounded-lg p-3 border transition disabled:opacity-50 ' +
                (active
                  ? 'bg-indigo-600/30 border-indigo-500 text-white'
                  : 'bg-slate-900/70 border-slate-700 hover:border-slate-500 text-slate-100')
              }
            >
              <div className="font-medium text-sm">{s.title}</div>
              <div className="text-xs text-slate-400 mt-1 leading-snug">{s.desc}</div>
            </button>
          );
        })}
      </div>
      {/* Static-mode duty slider appears only when Static is selected. */}
      {standalone === 'static' && (
        <Row label="Tint level" help="How dark the lens stays in Solid Tint mode.">
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={staticDuty}
              disabled={!edgeConnected}
              onChange={(e) => setStaticDuty(Number(e.target.value))}
              onMouseUp={(e) => {
                const v = Number((e.target as HTMLInputElement).value);
                void edgeDevice.setStandaloneStatic(v).catch(console.error);
              }}
              onTouchEnd={(e) => {
                const v = Number((e.target as HTMLInputElement).value);
                void edgeDevice.setStandaloneStatic(v).catch(console.error);
              }}
              onKeyUp={(e) => {
                const v = Number((e.target as HTMLInputElement).value);
                void edgeDevice.setStandaloneStatic(v).catch(console.error);
              }}
              className="flex-1 accent-indigo-500 disabled:opacity-50"
            />
            <span className="text-sm tabular-nums w-12 text-right">{staticDuty}%</span>
          </div>
        </Row>
      )}
    </Card>
  );
}

/* Glasses graphic with animated yellow lens tint. Opacity is computed
 * in a requestAnimationFrame loop from the active program + the most
 * recent firmware state:
 *
 *   Program 1 (HEARTBEAT)   — cosine pulse on each beat (300 ms decay)
 *   Program 2 (BREATHE)     — 40/60 sine waveform at pacerBpm × coh scale
 *   Program 3 (LENS)        — opacity = (100 − coh) / 100
 *   Program 4 (BREATHE+STR) — same waveform as Program 2 (strobe is
 *                             modeled as a fast modulation we don't try
 *                             to render at 10 Hz in the browser).
 *   No program / no glasses — clear lens.
 *
 * This is a visual approximation of `effective_duty` — the firmware
 * doesn't stream lens duty back to the dashboard. It's accurate to
 * within a few percent and the right tool for "is the lens doing
 * what I expect?" feedback. */
function GlassesVisual() {
  const program = useDashboardStore((s) => s.activeProgram);
  const standalone = useDashboardStore((s) => s.standaloneMode);
  const lastEdgeCoh = useDashboardStore((s) => s.lastEdgeCoherence);
  const lastBeatAt = useDashboardStore((s) => s.lastBeatAt);
  const edgeConnected = useDashboardStore((s) => s.connection.edge.state === 'connected');

  const [opacity, setOpacity] = useState(0);
  /* Refs into the rAF closure so it sees fresh state without forcing a
   * new RAF subscription each render. */
  const refs = useRef({ program, standalone, lastEdgeCoh, lastBeatAt });
  refs.current = { program, standalone, lastEdgeCoh, lastBeatAt };

  useEffect(() => {
    if (!edgeConnected) {
      setOpacity(0);
      return;
    }
    let raf = 0;
    const tick = () => {
      const { program, standalone, lastEdgeCoh, lastBeatAt } = refs.current;
      const now = Date.now();
      let target = 0;
      /* Standalone modes take precedence over programs (the firmware
       * makes them mutually exclusive too — entering a standalone bypasses
       * the PPG/coherence pipeline). */
      if (standalone === 'static') {
        target = 0.5;  /* approximate; the actual duty is set by the slider */
      } else if (standalone === 'breathe') {
        const cycleMs = 60000 / 6;
        const phase = (now % cycleMs) / cycleMs;
        let frac: number;
        if (phase < 0.4) frac = (1 - Math.cos(Math.PI * (phase / 0.4))) / 2;
        else            frac = (1 + Math.cos(Math.PI * ((phase - 0.4) / 0.6))) / 2;
        target = frac;
      } else if (standalone === 'strobe') {
        /* Real strobe is 10–40 Hz — too fast and headache-inducing to
         * render. Show a calm ~3 Hz square instead so the user can see
         * "yes, it's strobing." */
        target = Math.floor(now / 167) % 2 ? 0.7 : 0.05;
      } else if (standalone === 'pulse' || program === 1) {
        /* PULSE_DURATION_MS = 150, PULSE_PEAK_DUTY = 80 (matches firmware). */
        if (lastBeatAt != null) {
          const elapsed = now - lastBeatAt;
          if (elapsed >= 0 && elapsed < 150) {
            const p = elapsed / 150;
            const env = (1 + Math.cos(Math.PI * p)) / 2;
            target = env * 0.80;
          }
        }
      } else if (program === 2 || program === 4) {
        const bpm = lastEdgeCoh?.pacerBpm && lastEdgeCoh.pacerBpm > 0
          ? lastEdgeCoh.pacerBpm
          : 6;
        const cycleMs = 60000 / bpm;
        const phase = (now % cycleMs) / cycleMs;
        /* 40/60 inhale/exhale sine (matches firmware led_task). */
        let frac: number;
        if (phase < 0.4) {
          const p = phase / 0.4;
          frac = (1 - Math.cos(Math.PI * p)) / 2;
        } else {
          const p = (phase - 0.4) / 0.6;
          frac = (1 + Math.cos(Math.PI * p)) / 2;
        }
        /* Coh scale: 1 - (coh/100) × (1 - 0.20) (COH_DUTY_FLOOR_PCT=20). */
        const coh = lastEdgeCoh?.coh ?? 0;
        const cohScale = 1 - (coh / 100) * 0.80;
        target = frac * cohScale;
        /* Program 4 = breathing × strobe. The firmware strobes at 10 Hz+
         * which is unsafe to render in a browser; modulate the breath
         * envelope by a calm ~3 Hz square so the visual clearly shows
         * "this program is strobing" without inducing seizures. */
        if (program === 4) {
          const strobePhase = Math.floor(now / 167) % 2;  /* ~3 Hz */
          target = strobePhase ? target : target * 0.15;
        }
      } else if (program === 3) {
        const coh = lastEdgeCoh?.coh ?? 0;
        target = (100 - coh) / 100;
      }

      /* Light low-pass so the SVG re-render isn't noisy. Single-pole IIR.
       * Strobe modes (standalone or Program 4) get a higher α so the
       * on/off transitions still pop. */
      const isStrobing = standalone === 'strobe' || program === 4;
      const alpha = isStrobing ? 0.6 : 0.25;
      setOpacity((prev) => prev + (target - prev) * alpha);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [edgeConnected]);

  /* Cap visible opacity so the lens shape stays recognizable even at full
   * tint. The firmware's actual lens goes opaque; we don't need to. */
  const visualOpacity = Math.min(opacity, 0.85);
  const label =
    standalone === 'static'  ? 'Solid Tint'
    : standalone === 'breathe' ? 'Breathe (no HR)'
    : standalone === 'strobe'  ? 'Strobe Only'
    : standalone === 'pulse'   ? 'Pulse on Beat'
    : program === 1 ? 'Heartbeat Pulse'
    : program === 2 ? 'Breathing Guide'
    : program === 3 ? 'Coherence Lens'
    : program === 4 ? 'Breath + Strobe'
    : edgeConnected ? 'pick a mode'
    : 'connect glasses';

  return (
    <div className="flex flex-col items-center gap-2 py-2">
      <svg viewBox="0 0 240 90" className="w-64 h-24">
        {/* Left temple */}
        <path d="M 10 40 L 28 45" stroke="#94a3b8" strokeWidth="3" fill="none" strokeLinecap="round" />
        {/* Right temple */}
        <path d="M 230 40 L 212 45" stroke="#94a3b8" strokeWidth="3" fill="none" strokeLinecap="round" />
        {/* Bridge */}
        <path d="M 105 45 Q 120 38, 135 45" stroke="#94a3b8" strokeWidth="3" fill="none" strokeLinecap="round" />
        {/* Left lens frame */}
        <rect x="28" y="22" width="80" height="46" rx="22" ry="22"
              fill="#0f172a" stroke="#94a3b8" strokeWidth="2" />
        {/* Right lens frame */}
        <rect x="132" y="22" width="80" height="46" rx="22" ry="22"
              fill="#0f172a" stroke="#94a3b8" strokeWidth="2" />
        {/* Yellow lens tint — opacity driven by program state */}
        <rect x="28" y="22" width="80" height="46" rx="22" ry="22"
              fill="#facc15" opacity={visualOpacity} />
        <rect x="132" y="22" width="80" height="46" rx="22" ry="22"
              fill="#facc15" opacity={visualOpacity} />
      </svg>
      <div className="text-[11px] text-slate-400">
        Lens: <span className="text-amber-300 tabular-nums">{Math.round(opacity * 100)}%</span>
        <span className="ml-2 text-slate-500">{label}</span>
      </div>
    </div>
  );
}

function MetricCard({
  label, value, unit, colorClass, sub,
}: {
  label: string;
  value: string;
  unit: string;
  colorClass: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-4 flex flex-col gap-1">
      <div className="text-xs uppercase tracking-wide text-slate-400">{label}</div>
      <div className="flex items-baseline gap-2">
        <div className={`text-4xl font-semibold tabular-nums ${colorClass}`}>{value}</div>
        {unit && <div className="text-sm text-slate-500">{unit}</div>}
      </div>
      {sub && <div className="text-xs text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );
}

function Card({
  title, disabled, children,
}: {
  title: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={
        'rounded-lg border border-slate-800 bg-slate-900/40 p-4 space-y-3 ' +
        (disabled ? 'opacity-60' : '')
      }
    >
      <div className="text-sm font-medium text-slate-300">{title}</div>
      {children}
    </div>
  );
}

function Row({
  label, help, children,
}: {
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <div className="text-sm text-slate-200">{label}</div>
      </div>
      {children}
      {help && <div className="text-[11px] text-slate-500 mt-1 leading-snug">{help}</div>}
    </div>
  );
}
