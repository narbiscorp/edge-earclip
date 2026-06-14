/*
 * CoherenceEnginePanel.tsx — the app-side Coherence Engine control surface.
 *
 * Mode selector (Firmware / Mode A / Mode B) + the tunables for the selected mode (each
 * mode's tunables only appear when that mode is selected) + a live status readout. Pairs
 * with CoherencePresetBar for save/load of the full tunable set.
 */
import { useMemo, useState } from 'react';
import { useDashboardStore } from '../../state/store';
import { DEFAULT_TUNABLES, type CoherenceTunableKey } from '../../engine/tunables';
import type { EngineMode } from '../../engine/coherenceEngine';
import {
  COH_SECTIONS,
  type CohSectionId,
  fieldsForSection,
  sectionVisible,
} from './coherenceFieldSchema';
import { validateCoherenceTunables } from './validateCoherenceTunables';
import CoherenceField from './CoherenceField';

const MODE_OPTIONS: Array<{ id: EngineMode; label: string; sub: string }> = [
  { id: 'firmware', label: 'Firmware', sub: 'on-glasses' },
  { id: 'modeA', label: 'Mode A', sub: 'Follow' },
  { id: 'modeB', label: 'Mode B', sub: 'Resonance' },
];

export default function CoherenceEnginePanel() {
  const engineMode = useDashboardStore((s) => s.engineMode);
  const setEngineMode = useDashboardStore((s) => s.setEngineMode);
  const tunables = useDashboardStore((s) => s.coherenceTunables);
  const setCoherenceTunables = useDashboardStore((s) => s.setCoherenceTunables);
  const edgeConnected = useDashboardStore((s) => s.connection.edge.state === 'connected');
  const polarConnected = useDashboardStore((s) => s.connection.polar.state === 'connected');

  const [expanded, setExpanded] = useState<Record<CohSectionId, boolean>>(() => {
    const m = {} as Record<CohSectionId, boolean>;
    for (const sec of COH_SECTIONS) m[sec.id] = sec.defaultExpanded;
    return m;
  });

  const errors = useMemo(() => validateCoherenceTunables(tunables), [tunables]);

  const setField = (key: CoherenceTunableKey, value: number) => {
    setCoherenceTunables({ ...tunables, [key]: value });
  };

  const visibleSections = COH_SECTIONS.filter((sec) => sectionVisible(sec, engineMode));

  return (
    <div className="rounded border border-slate-800 bg-slate-900/50 p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="text-[12px] font-medium text-slate-200">Coherence Engine</div>
        {engineMode !== 'firmware' ? (
          <button
            type="button"
            onClick={() => setCoherenceTunables({ ...DEFAULT_TUNABLES })}
            className="text-[10px] rounded bg-slate-800 hover:bg-slate-700 px-2 py-0.5 text-slate-300"
            title="Reset every tunable to factory defaults"
          >
            reset all
          </button>
        ) : null}
      </div>

      {/* Mode selector — 3 modes total. */}
      <div className="inline-flex rounded-md border border-slate-700 overflow-hidden text-[11px]">
        {MODE_OPTIONS.map((opt) => {
          const active = engineMode === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => void setEngineMode(opt.id)}
              className={`flex-1 px-2 py-1.5 border-l border-slate-700 first:border-l-0 ${
                active ? 'bg-indigo-600 text-white' : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
              }`}
            >
              <div className="font-medium">{opt.label}</div>
              <div className={`text-[9px] ${active ? 'text-indigo-200' : 'text-slate-500'}`}>{opt.sub}</div>
            </button>
          );
        })}
      </div>

      {engineMode === 'firmware' ? (
        <div className="text-[10px] text-slate-500">
          The glasses firmware drives the lens (the existing behavior). Select Mode A or Mode B to run
          the app-side engine — it computes coherence from the live signal and streams the lens duty
          (0xA5) to the glasses.
        </div>
      ) : (
        <>
          {!edgeConnected ? (
            <div className="rounded border border-amber-700/40 bg-amber-900/10 px-2 py-1 text-[10px] text-amber-300">
              Connect the glasses — the engine drives the lens over BLE.
            </div>
          ) : null}
          {engineMode === 'modeB' && !polarConnected ? (
            <div className="rounded border border-amber-700/40 bg-amber-900/10 px-2 py-1 text-[10px] text-amber-300">
              Mode B needs a Polar H10 (validated RR + accelerometer for dwell verification).
            </div>
          ) : null}
          <EngineReadout />
        </>
      )}

      {visibleSections.map((sec) => {
        const fields = fieldsForSection(sec.id, engineMode);
        if (fields.length === 0) return null;
        const isOpen = expanded[sec.id];
        return (
          <div key={sec.id} className="rounded border border-slate-800 bg-slate-900/40">
            <button
              type="button"
              onClick={() => setExpanded((p) => ({ ...p, [sec.id]: !p[sec.id] }))}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] font-medium text-slate-200 hover:text-white"
              aria-expanded={isOpen}
            >
              <span className="text-[10px] text-slate-500 w-3 inline-block">{isOpen ? '▾' : '▸'}</span>
              <span>{sec.label}</span>
            </button>
            {isOpen ? (
              <div className="border-t border-slate-800 px-3 py-2 flex flex-col">
                {fields.map((fld) => (
                  <CoherenceField
                    key={fld.key}
                    spec={fld}
                    value={tunables[fld.key]}
                    error={errors[fld.key]}
                    onChange={(v) => setField(fld.key, v)}
                  />
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function EngineReadout() {
  const status = useDashboardStore((s) => s.engineStatus);
  if (!status || !status.running) {
    return (
      <div className="text-[10px] text-slate-500">Engine idle — waiting for a beat source.</div>
    );
  }
  return (
    <div className="rounded border border-slate-800 bg-slate-950/40 px-2 py-1.5 text-[10px] text-slate-300 flex flex-col gap-0.5">
      <div className="flex flex-wrap gap-x-4 gap-y-0.5">
        <span>coh <span className="text-emerald-400 font-medium">{status.coherence.toFixed(0)}%</span></span>
        <span>CR <span className="text-slate-100">{status.cr.toFixed(2)}</span></span>
        <span>resp <span className="text-slate-100">{(status.respHz * 60).toFixed(1)}</span> bpm</span>
        <span>pacer <span className="text-cyan-400 font-medium">{status.pacerBpm.toFixed(1)}</span> bpm</span>
        <span>beats <span className="text-slate-100">{status.beats}</span></span>
        <span>duty <span className="text-slate-100">{status.duty}</span></span>
      </div>
      {status.mode === 'modeB' && status.modeBState ? (
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 pt-0.5 border-t border-slate-800/60">
          <span>
            state{' '}
            <span className={status.modeBState === 'maintaining' ? 'text-emerald-400' : 'text-amber-300'}>
              {status.modeBState}
            </span>
          </span>
          {status.lockedRF != null ? (
            <span>RF <span className="text-emerald-400 font-medium">{status.lockedRF.toFixed(2)}</span> bpm{status.boundaryLimited ? ' (edge)' : ''}</span>
          ) : null}
          {status.unverifiedDwells > 0 ? (
            <span className="text-amber-300">hold still ({status.unverifiedDwells})</span>
          ) : null}
          {status.searchAborted ? <span className="text-rose-400">search aborted</span> : null}
        </div>
      ) : null}
    </div>
  );
}
