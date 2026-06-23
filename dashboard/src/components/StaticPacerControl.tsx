import { useEffect, useState } from 'react';
import { useDashboardStore } from '../state/store';
import { useClientStore } from '../clients/clientStore';
import { useClientList } from '../clients/useClients';
import {
  coherenceEngine,
  STATIC_PACER_MIN_BPM,
  STATIC_PACER_MAX_BPM,
} from '../engine/coherenceEngine';

/*
 * StaticPacerControl — Mode B ("Static Pacer") rate setter, plus the Mode A/C manual nudge.
 *
 * Mode B paces at a FIXED rate (Mode-A coherence feedback, no follow). This card sets that rate:
 * ▼/▲ step ±0.1 br/min and the number is directly typeable (4.0–10.0). Changes apply live and are
 * remembered per signed-in client (store write-through to Supabase) with a localStorage fallback.
 */

const STEP = 0.1;

/** Hydrate the store's static-pacer rate from the active client's saved DB setting. Call once near
 * the top of the main view so the value is ready before Mode B starts. No-op when not signed in /
 * unassigned (the store's localStorage fallback stands). */
export function useStaticPacerClientSync(): void {
  const activeClientId = useClientStore((s) => s.activeClientId);
  const { rows } = useClientList();
  const hydrate = useDashboardStore((s) => s.hydrateStaticPacerBpm);
  useEffect(() => {
    if (!activeClientId) return;
    const v = rows.find((r) => r.id === activeClientId)?.settings?.static_pacer_bpm;
    if (typeof v === 'number' && Number.isFinite(v)) hydrate(v);
  }, [activeClientId, rows, hydrate]);
}

export function StaticPacerControl() {
  const bpm = useDashboardStore((s) => s.staticPacerBpm);
  const setBpm = useDashboardStore((s) => s.setStaticPacerBpm);
  const [draft, setDraft] = useState<string | null>(null); // typed-but-uncommitted text, or null when idle

  const commit = (raw: string) => {
    const n = Number(raw);
    if (Number.isFinite(n)) setBpm(n); // store clamps + snaps to the 0.1 grid
    setDraft(null);
  };

  const atMin = bpm <= STATIC_PACER_MIN_BPM + 1e-9;
  const atMax = bpm >= STATIC_PACER_MAX_BPM - 1e-9;
  const btn =
    'h-9 w-9 rounded-lg border border-slate-700 bg-slate-800/60 text-slate-200 text-lg leading-none ' +
    'flex items-center justify-center hover:border-slate-500 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed';

  return (
    <div className="rounded-xl border border-slate-800/80 bg-slate-900/60 px-4 py-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] tracking-[0.18em] uppercase text-slate-400">Pacer rate</div>
        <div className="text-[10px] text-slate-500">
          {STATIC_PACER_MIN_BPM.toFixed(1)}–{STATIC_PACER_MAX_BPM.toFixed(1)} br/min
        </div>
      </div>
      <div className="flex items-center justify-center gap-3">
        <button type="button" className={btn} onClick={() => setBpm(bpm - STEP)} disabled={atMin} aria-label="Slower by 0.1 br/min">
          ▼
        </button>
        <div className="flex items-baseline gap-1">
          <input
            type="number"
            inputMode="decimal"
            step={STEP}
            min={STATIC_PACER_MIN_BPM}
            max={STATIC_PACER_MAX_BPM}
            value={draft ?? bpm.toFixed(1)}
            onFocus={() => setDraft(bpm.toFixed(1))}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
            className="w-24 bg-transparent text-center text-3xl tabular-nums text-slate-100 outline-none border-b border-transparent focus:border-slate-600"
            aria-label="Breathing pacer rate (breaths per minute)"
          />
          <span className="text-[11px] text-slate-500">br/min</span>
        </div>
        <button type="button" className={btn} onClick={() => setBpm(bpm + STEP)} disabled={atMax} aria-label="Faster by 0.1 br/min">
          ▲
        </button>
      </div>
      <div className="mt-1.5 text-center text-[10px] text-slate-500">
        Your coherence drives the lens — the breathing rate stays fixed where you set it.
      </div>
    </div>
  );
}

/** Manual ± nudge for Mode A / Mode C (±0.1 br/min). Mode A re-follows after a few breaths; Mode C
 * restarts its resonance test at the nudged rate. Mode B uses StaticPacerControl instead. */
export function PaceNudge() {
  const pacerBpm = useDashboardStore((s) => s.engineStatus?.pacerBpm ?? 0);
  const btn =
    'h-7 w-7 rounded-md border border-slate-700 bg-slate-800/60 text-slate-300 text-base leading-none ' +
    'flex items-center justify-center hover:border-slate-500 hover:text-white';
  return (
    <div className="flex items-center justify-center gap-2 text-[11px] text-slate-400">
      <span className="uppercase tracking-[0.14em] text-[10px]">Adjust pace</span>
      <button type="button" className={btn} onClick={() => coherenceEngine.nudgePacer(-STEP)} aria-label="Slower by 0.1 br/min">
        ‹
      </button>
      <span className="w-16 text-center tabular-nums text-slate-300">
        {pacerBpm > 0 ? `${pacerBpm.toFixed(1)} br/min` : '—'}
      </span>
      <button type="button" className={btn} onClick={() => coherenceEngine.nudgePacer(STEP)} aria-label="Faster by 0.1 br/min">
        ›
      </button>
    </div>
  );
}
