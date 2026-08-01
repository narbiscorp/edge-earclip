/*
 * CardiacChart.tsx — heart rate, HRV, coherence and respiration rate.
 *
 * Stacked small multiples, NOT a dual-axis plot. HR is bpm, RMSSD/SDNN are ms,
 * coherence is a 0–100 index and respiration is breaths/min; putting any two of
 * those on one pair of axes would let the reader see a correlation that is an
 * artifact of where the two scales happened to be pinned. Each panel therefore
 * owns exactly one y-scale, and they share the x-axis so events still line up.
 *
 * RMSSD and SDNN DO share a panel: both are milliseconds, so comparing their
 * heights is meaningful.
 */
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { Data } from 'plotly.js';
import { sessionLog, type MetricRow } from './log';
import { shapeSeries, type TraceShaping } from './dsp';
import { useAnalysisPlot, type ChartKey } from './plot';
import { SERIES, INK, baseLayout, axisStyle } from './theme';
import { useSettings } from './settings';
import { ShapingControls, Readout, fmt, Info } from './ui';

export interface SeriesDef {
  id: string;
  name: string;
  color: string;
  pick: (row: MetricRow) => number | null;
  decimals: number;
}

interface PanelProps {
  chartKey: ChartKey;
  title: string;
  unit: string;
  info?: string;
  series: SeriesDef[];
  height: number;
  showXLabels: boolean;
  shaping: TraceShaping;
  yRange?: [number, number];
  latest: MetricRow | null;
}

function MetricPanel({
  chartKey,
  title,
  unit,
  info,
  series,
  height,
  showXLabels,
  shaping,
  yRange,
  latest,
}: PanelProps): ReactNode {
  const settings = useSettings();
  const viewRef = useRef(settings.viewWindowSec);
  viewRef.current = settings.viewWindowSec;
  const followRef = useRef(settings.follow);
  followRef.current = settings.follow;
  const shapingRef = useRef(shaping);
  shapingRef.current = shaping;
  const seriesRef = useRef(series);
  seriesRef.current = series;

  // Any control change has to force a redraw even when no new sample arrived.
  const rev = useRef(0);
  const shapingKey = JSON.stringify(shaping);
  const seriesKey = series.map((s) => s.id).join(',');
  useEffect(() => {
    rev.current += 1;
  }, [shapingKey, seriesKey, settings.viewWindowSec]);

  const layout = useMemo(
    () =>
      baseLayout({
        margin: { l: 58, r: 16, t: 4, b: showXLabels ? 30 : 8 },
        xaxis: axisStyle('x', { showticklabels: showXLabels, showspikes: true, spikemode: 'across', spikethickness: 1, spikecolor: INK.muted, spikedash: 'dot' }),
        yaxis: axisStyle('y', yRange ? { range: yRange, autorange: false } : { autorange: true }),
      }),
    [showXLabels, yRange],
  );

  const divRef = useAnalysisPlot({
    key: chartKey,
    baseLayout: layout,
    follow: () => followRef.current,
    windowSec: () => viewRef.current,
    refreshHz: 4,
    exportName: `narbis-${title.toLowerCase().replace(/\s+/g, '-')}`,
    pull: () => {
      const now = Date.now();
      const win = viewRef.current;
      const sh = shapingRef.current;
      const traces: Data[] = seriesRef.current.map((s) => {
        const w = sessionLog.metricWindow(win, now, s.pick);
        const shaped = shapeSeries(w.x, w.y, sh);
        return {
          x: shaped.x.map((t) => new Date(t)),
          y: shaped.y,
          type: sh.shape === 'linear' ? 'scattergl' : 'scatter',
          mode: 'lines',
          name: s.name,
          line: { color: s.color, width: 2, shape: sh.shape },
          hovertemplate: `${s.name}: %{y:.${s.decimals}f} ${unit}<extra></extra>`,
        } as Data;
      });
      return { traces, seq: sessionLog.seq + rev.current * 1_000_000 };
    },
  });

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">
          {title} <span className="unit">({unit})</span>
          {info && <Info text={info} />}
        </span>
        {series.map((s) => (
          <Readout
            key={s.id}
            color={s.color}
            name={s.name}
            value={fmt(latest ? s.pick(latest) : null, s.decimals)}
          />
        ))}
      </div>
      <div ref={divRef} className="plot" style={{ height }} />
    </div>
  );
}

export default function CardiacChart({ latest }: { latest: MetricRow | null }): ReactNode {
  const {
    panels,
    togglePanel,
    coherence,
    toggleCoherence,
    metricsShaping,
    patchMetricsShaping,
  } = useSettings();

  // Coherence definitions all normalised onto 0–100 so one y-scale is honest for
  // the whole panel. Slots assigned in the validated palette order, never cycled.
  const coherenceSeries = useMemo<SeriesDef[]>(() => {
    const all: Array<{ on: boolean; def: Omit<SeriesDef, 'color'> }> = [
      {
        on: coherence.engine,
        def: {
          id: 'engine',
          name: 'Engine',
          decimals: 1,
          pick: (r) => r.engineCoherence,
        },
      },
      {
        on: coherence.firmware,
        def: {
          id: 'firmware',
          name: 'Firmware port',
          decimals: 1,
          pick: (r) => r.firmwareCoherence,
        },
      },
      {
        on: coherence.heartmath,
        def: {
          id: 'hm',
          name: 'HeartMath',
          decimals: 1,
          // Both HeartMath and resonance are 0–10 scores; ×10 puts them on the
          // panel's shared 0–100 scale alongside the engine and firmware values.
          pick: (r) => (r.hmCoherence == null ? null : r.hmCoherence * 10),
        },
      },
      {
        on: coherence.resonance,
        def: {
          id: 'res',
          name: 'Resonance',
          decimals: 1,
          pick: (r) => (r.resonanceCoherence == null ? null : r.resonanceCoherence * 10),
        },
      },
      {
        on: coherence.breathHeart,
        def: {
          id: 'bh',
          name: 'Breath–heart γ²',
          decimals: 1,
          pick: (r) => (r.breathHeartCoherence == null ? null : r.breathHeartCoherence * 100),
        },
      },
    ];
    const palette = [SERIES.s1, SERIES.s2, SERIES.s3, SERIES.s4, SERIES.s5];
    return all
      .filter((e) => e.on)
      .map((e, i) => ({ ...e.def, color: palette[i] }));
  }, [coherence]);

  const visible = [panels.hr, panels.hrv, panels.coherence, panels.respiration];
  const lastVisible = visible.lastIndexOf(true);

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Heart rate, HRV &amp; coherence</h2>
        <Segment label="HR" on={panels.hr} onClick={() => togglePanel('hr')} />
        <Segment label="HRV" on={panels.hrv} onClick={() => togglePanel('hrv')} />
        <Segment label="Coherence" on={panels.coherence} onClick={() => togglePanel('coherence')} />
        <Segment
          label="Respiration"
          on={panels.respiration}
          onClick={() => togglePanel('respiration')}
        />
      </div>

      <div className="card-body">
        {lastVisible < 0 && <div className="empty">All panels hidden — turn one on above.</div>}

        {panels.hr && (
          <MetricPanel
            chartKey="metrics:hr"
            title="Heart rate"
            unit="bpm"
            info="Mean heart rate over the analysis window, from 60000 / mean(IBI)."
            height={130}
            showXLabels={lastVisible === 0}
            shaping={metricsShaping}
            latest={latest}
            series={[
              { id: 'hr', name: 'Mean HR', color: SERIES.s1, decimals: 1, pick: (r) => r.meanHr },
            ]}
          />
        )}

        {panels.hrv && (
          <MetricPanel
            chartKey="metrics:hrv"
            title="HRV"
            unit="ms"
            info="RMSSD is the root mean square of successive IBI differences — a short-term, largely parasympathetic index. SDNN is the standard deviation of all IBIs in the window and reflects total variability. Both are in milliseconds, so their heights are directly comparable."
            height={150}
            showXLabels={lastVisible === 1}
            shaping={metricsShaping}
            latest={latest}
            series={[
              { id: 'rmssd', name: 'RMSSD', color: SERIES.s1, decimals: 1, pick: (r) => r.rmssd },
              { id: 'sdnn', name: 'SDNN', color: SERIES.s2, decimals: 1, pick: (r) => r.sdnn },
            ]}
          />
        )}

        {panels.coherence && (
          <>
            <MetricPanel
              chartKey="metrics:coh"
              title="Coherence"
              unit="0–100"
              info="Engine is the app-side Coherence Engine's live output (Lomb-Scargle coherence ratio, squashed to 0–100) — the same number the glasses lens is driven from elsewhere in the product. The others are alternative definitions computed over the same beats for comparison: the firmware port, HeartMath's in-band power ratio, the Lehrer/Vaschillo resonance peak fraction, and the true cross-spectral breath–heart coherence γ² (which needs the H10 accelerometer)."
              height={170}
              showXLabels={lastVisible === 2}
              shaping={metricsShaping}
              yRange={[0, 100]}
              latest={latest}
              series={coherenceSeries}
            />
            <div className="shaping" style={{ borderTop: 'none', background: 'transparent', paddingTop: 0 }}>
              <span className="label">Definitions</span>
              <Segment label="Engine" on={coherence.engine} onClick={() => toggleCoherence('engine')} />
              <Segment label="Firmware port" on={coherence.firmware} onClick={() => toggleCoherence('firmware')} />
              <Segment label="HeartMath" on={coherence.heartmath} onClick={() => toggleCoherence('heartmath')} />
              <Segment label="Resonance" on={coherence.resonance} onClick={() => toggleCoherence('resonance')} />
              <Segment label="Breath–heart γ²" on={coherence.breathHeart} onClick={() => toggleCoherence('breathHeart')} />
            </div>
          </>
        )}

        {panels.respiration && (
          <MetricPanel
            chartKey="metrics:resp"
            title="Respiration rate"
            unit="br/min"
            info="Two independent estimates. 'From HRV' is the engine's Lomb-Scargle respiratory peak read off the tachogram — it infers breathing from the heart. 'From ACC' is measured directly from the Polar H10 chest accelerometer. When they agree, the respiratory sinus arrhythmia is real; when they diverge, the rhythm in the tachogram is being driven by something other than the breath."
            height={140}
            showXLabels={lastVisible === 3}
            shaping={metricsShaping}
            latest={latest}
            series={[
              {
                id: 'lsresp',
                name: 'From HRV',
                color: SERIES.s1,
                decimals: 2,
                pick: (r) => (r.engineRespHz == null ? null : r.engineRespHz * 60),
              },
              { id: 'accresp', name: 'From ACC', color: SERIES.s2, decimals: 2, pick: (r) => r.accRespBpm },
            ]}
          />
        )}
      </div>

      <ShapingControls shaping={metricsShaping} patch={patchMetricsShaping} />
    </section>
  );
}

/** A small on/off chip used for panel and series visibility. */
function Segment({
  label,
  on,
  onClick,
}: {
  label: string;
  on: boolean;
  onClick: () => void;
}): ReactNode {
  return (
    <div className="seg">
      <button type="button" aria-pressed={on} onClick={onClick}>
        {label}
      </button>
    </div>
  );
}
