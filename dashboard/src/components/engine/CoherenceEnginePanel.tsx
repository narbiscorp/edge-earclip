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
import { ENGINE_MODE_INFO, modeBStatusText, modeCStatusText } from './modeInfo';
import { useLastMetrics } from '../../state/useLastMetrics';

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
  const [infoMode, setInfoMode] = useState<EngineMode | null>(null);
  const info = infoMode != null ? ENGINE_MODE_INFO.find((x) => x.id === infoMode) ?? null : null;

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

      {/* Mode selector — 4 modes total. Each has an (i) info popover. */}
      <div className="grid grid-cols-2 gap-1 text-[11px]">
        {ENGINE_MODE_INFO.map((opt) => {
          const active = engineMode === opt.id;
          return (
            <div key={opt.id} className="relative">
              <button
                type="button"
                onClick={() => void setEngineMode(opt.id)}
                title={opt.desc}
                className={`w-full rounded px-2 py-1.5 pr-6 text-left border transition ${
                  active
                    ? 'border-indigo-400/60 bg-indigo-600 text-white'
                    : 'border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-300'
                }`}
              >
                <div className="font-medium">{opt.title}</div>
                <div className={`text-[9px] ${active ? 'text-indigo-200' : 'text-slate-500'}`}>{opt.sub}</div>
              </button>
              <button
                type="button"
                onClick={(ev) => { ev.stopPropagation(); setInfoMode(opt.id); }}
                title={`What is ${opt.title}?`}
                aria-label={`What is ${opt.title}?`}
                className="absolute top-0.5 right-0.5 h-4 w-4 rounded-full border border-slate-500/70 text-slate-300 text-[10px] font-serif italic leading-none flex items-center justify-center hover:bg-slate-600"
              >
                i
              </button>
            </div>
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
          {(engineMode === 'modeB' || engineMode === 'modeC') && !polarConnected ? (
            <div className="rounded border border-amber-700/40 bg-amber-900/10 px-2 py-1 text-[10px] text-amber-300">
              {engineMode === 'modeB' ? 'Mode B' : 'Mode C'} needs a Polar H10 (validated RR + accelerometer for dwell verification).
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

      {info ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4"
          onClick={() => setInfoMode(null)}
        >
          <div
            className="max-w-md rounded-xl border border-slate-700 bg-slate-900 p-4 flex flex-col gap-2"
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="text-sm font-semibold text-slate-100">
              {info.title} <span className="text-slate-400 font-normal">· {info.sub}</span>
            </div>
            <p className="text-[13px] leading-relaxed text-slate-300">{info.details}</p>
            {info.references && info.references.length > 0 ? (
              <div className="mt-1 border-t border-slate-800 pt-2">
                <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">Based on</div>
                <ul className="list-disc list-inside text-[11px] leading-snug text-slate-400 space-y-1">
                  {info.references.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="flex justify-end pt-1">
              <button
                type="button"
                onClick={() => setInfoMode(null)}
                className="rounded bg-slate-700 hover:bg-slate-600 px-3 py-1 text-xs"
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function EngineReadout() {
  const status = useDashboardStore((s) => s.engineStatus);
  const metrics = useLastMetrics();
  const respConfidenceMin = useDashboardStore((s) => s.coherenceTunables.respConfidenceMin);
  const [showInfo, setShowInfo] = useState(false);
  if (!status || !status.running) {
    return (
      <div className="text-[10px] text-slate-500">Engine idle — waiting for a beat source.</div>
    );
  }
  // The REAL coherence: cross-spectral γ² between H10-ACC respiration and heart rate (null when no
  // ACC / poor signal). The single-signal CR is shown honestly as "rhythm steadiness" — it measures
  // spectral concentration, not breath–heart coupling — and still drives the lens (unchanged).
  const bh = status.breathHeartCoherence;
  return (
    <div className="rounded border border-slate-800 bg-slate-950/40 px-2 py-1.5 text-[10px] text-slate-300 flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5">
        {bh != null ? (
          <>
            <span>
              breath–heart coherence <span className="text-emerald-400 font-medium">γ² {bh.toFixed(2)}</span>{' '}
              <span className="text-slate-500">measured</span>
            </span>
            {status.breathHeartPhaseDeg != null ? (
              <span>phase <span className="text-slate-100">{status.breathHeartPhaseDeg.toFixed(0)}°</span></span>
            ) : null}
            {status.coherenceConfounded ? (
              <span className="text-amber-400" title="The followed rhythm is not being driven by your breathing.">
                ⚠ confounded
              </span>
            ) : null}
          </>
        ) : (
          <span className="text-slate-500">breath–heart coherence — needs a Polar H10 (accelerometer)</span>
        )}
        <button
          type="button"
          onClick={() => setShowInfo((v) => !v)}
          aria-label="What do these readouts mean?"
          aria-expanded={showInfo}
          title="What do these readouts mean?"
          className="shrink-0 h-4 w-4 rounded-full border border-slate-500/70 text-slate-400 text-[10px] font-serif italic leading-none flex items-center justify-center hover:bg-slate-700 hover:text-slate-100"
        >
          i
        </button>
      </div>
      {showInfo ? (
        <div className="rounded-md border border-slate-700/70 bg-slate-900/60 px-2.5 py-2 text-[11px] leading-relaxed text-slate-300 flex flex-col gap-1.5">
          <div>
            <span className="text-emerald-400 font-medium">Breath–heart coherence (γ²)</span> — magnitude-squared
            coherence between your breathing (sensed from the Polar H10 accelerometer) and your heart rate, 0–1,
            at your breathing frequency. Near 1 means breath and heart rate genuinely move together (resonance).
            This is the real coherence the literature means, time-averaged so it stays steady.
          </div>
          <div>
            <span className="text-slate-100 font-medium">phase</span> — the timing offset between the breathing and
            heart-rate rhythms at that frequency; near 0° at resonance. Shown only when γ² is high enough to be
            meaningful (hidden at low coherence, where phase is just noise).
          </div>
          <div>
            <span className="text-amber-400 font-medium">⚠ confounded</span> — the rhythm the pacer is following is
            not being driven by your breathing: either the followed rate differs from your measured breathing rate,
            or the coherence is low. Often the ~0.1 Hz Mayer (blood-pressure) wave. When lit, do not trust a high
            rhythm-steadiness as real coherence.
          </div>
          <div>
            <span className="text-cyan-300 font-medium">rhythm steadiness</span> (CR) — how concentrated your
            heart-rate variability is at a single frequency (the field-standard coherence ratio, 0–100). It drives
            the lens, but on its own it cannot tell whether that rhythm is actually your breathing — that is what
            γ² and the confound flag add.
          </div>
          <div>
            <span className="text-slate-100 font-medium">resp / pacer</span> — your detected breathing rate vs the
            rate the lens is pacing you toward, in breaths per minute.
          </div>
          <div>
            <span className="text-slate-100 font-medium">RMSSD / SDNN / LF/HF</span> — standard, independent HRV
            indices (RMSSD and SDNN in milliseconds; LF/HF is the low- to high-frequency power ratio), shown so the
            proprietary score is never the only number.
          </div>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-x-4 gap-y-0.5">
        <span>rhythm steadiness <span className="text-cyan-300 font-medium">{status.coherence.toFixed(0)}/100</span> <span className="text-slate-500">CR {status.cr.toFixed(2)}</span></span>
        <span>resp <span className="text-slate-100">{(status.respHz * 60).toFixed(1)}</span> br/min</span>
        <span>pacer <span className="text-cyan-400 font-medium">{status.pacerBpm.toFixed(1)}</span> br/min</span>
        <span>beats <span className="text-slate-100">{status.beats}</span></span>
        <span>duty <span className="text-slate-100">{status.duty}</span></span>
      </div>
      {metrics ? (
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-slate-400">
          <span>RMSSD <span className="text-slate-100">{metrics.rmssd.toFixed(0)}</span> ms</span>
          <span>SDNN <span className="text-slate-100">{metrics.sdnn.toFixed(0)}</span> ms</span>
          <span>LF/HF <span className="text-slate-100">{metrics.lfHfRatio.toFixed(2)}</span></span>
        </div>
      ) : null}
      {status.mode === 'modeB' && status.modeBState === 'searching' ? (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-slate-400">
          <span title="Breathing rate measured from the H10 accelerometer — the independent channel Mode B verifies each dwell against">
            ACC <span className="text-slate-100">{status.accMeasuredBpm != null ? status.accMeasuredBpm.toFixed(1) : '—'}</span> br/min
          </span>
          <span title="Spectral confidence of the ACC breathing peak; must clear the min-confidence knob to count as verified">
            conf{' '}
            <span className={status.accRespConfidence >= respConfidenceMin ? 'text-emerald-400' : 'text-amber-400'}>
              {status.accRespConfidence.toFixed(2)}
            </span>
            <span className="text-slate-600">/{respConfidenceMin.toFixed(2)}</span>
          </span>
          {status.modeBVerifiedRatio != null ? (
            <span title="Fraction of this dwell's scored breaths whose ACC rate matched the paced rate">
              verified <span className="text-slate-100">{Math.round(status.modeBVerifiedRatio * 100)}%</span>
            </span>
          ) : null}
        </div>
      ) : null}
      {status.mode === 'modeB' && status.modeBState ? (
        <div
          className={
            'pt-0.5 border-t border-slate-800/60 ' +
            (status.searchAborted
              ? 'text-rose-400'
              : status.modeBState === 'maintaining'
                ? 'text-emerald-300'
                : 'text-amber-300')
          }
        >
          {modeBStatusText(status)}
        </div>
      ) : status.mode === 'modeC' ? (
        <div
          className={
            'pt-0.5 border-t border-slate-800/60 ' +
            (status.modeCPhase === 'maintaining'
              ? 'text-emerald-300'
              : status.modeCPhase === 'searching'
                ? 'text-amber-300'
                : status.modeCAccConfident
                  ? 'text-cyan-300'
                  : 'text-slate-400')
          }
        >
          {modeCStatusText(status)}
        </div>
      ) : null}
    </div>
  );
}
