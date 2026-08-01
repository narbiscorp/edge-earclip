/*
 * AccChart.tsx — the Polar H10 accelerometer, one axis per panel.
 *
 * Overlaying the axes on a shared scale does not work on a chest strap. Gravity
 * pins whichever axis points down near ±1000 mG while the other two sit near
 * zero, and the breathing excursion — the thing this page exists to show — is a
 * few mG riding on top of that. On one axis the ripple is a rounding error.
 *
 * So each axis gets its own panel and its own y-scale, and auto-gain does two
 * things per channel: subtracts the slow baseline (gravity and posture drift),
 * then lets the panel autorange to whatever is left. A 3 mG breath then fills
 * the panel regardless of which way the strap is facing.
 *
 * Auto-gain is a DISPLAY transform. The readout beside each label is always the
 * true absolute value in mG, and the CSV always holds raw samples.
 */
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { Data } from 'plotly.js';
import { sessionLog } from './log';
import { shapeSeries, type TraceShaping } from './dsp';
import { useAnalysisPlot } from './plot';
import { SERIES, INK, baseLayout, axisStyle } from './theme';
import { useSettings, DETREND_OPTIONS, GAIN_OPTIONS } from './settings';
import { ShapingControls, Readout, fmt, Info, Check } from './ui';

type AxisKey = 'x' | 'y' | 'z' | 'mag';

const AXES: ReadonlyArray<{ key: AxisKey; name: string; color: string; hint: string }> = [
  { key: 'x', name: 'X', color: SERIES.s1, hint: 'Lateral (across the chest).' },
  { key: 'y', name: 'Y', color: SERIES.s2, hint: 'Vertical (head–foot) when the strap is worn upright.' },
  { key: 'z', name: 'Z', color: SERIES.s3, hint: 'Front–back — usually the axis the chest wall moves along as you breathe.' },
  { key: 'mag', name: '|magnitude|', color: SERIES.s4, hint: 'Vector length. Orientation-independent, so it survives the strap sitting at a different angle.' },
];

interface AxisPanelProps {
  axis: (typeof AXES)[number];
  shaping: TraceShaping;
  height: number;
  showXLabels: boolean;
  /** Fixed ±range in mG, or null to autorange (auto-gain). */
  fixedRange: number | null;
  live: number | null;
}

function AxisPanel({
  axis,
  shaping,
  height,
  showXLabels,
  fixedRange,
  live,
}: AxisPanelProps): ReactNode {
  const settings = useSettings();
  const viewRef = useRef(settings.viewWindowSec);
  viewRef.current = settings.viewWindowSec;
  const followRef = useRef(settings.follow);
  followRef.current = settings.follow;
  const shapingRef = useRef(shaping);
  shapingRef.current = shaping;

  // Peak-to-peak of what is actually drawn — the honest way to read a panel
  // whose gain moves on its own.
  const p2pRef = useRef<number | null>(null);

  const rev = useRef(0);
  const shapingKey = JSON.stringify(shaping);
  useEffect(() => {
    rev.current += 1;
  }, [shapingKey, settings.viewWindowSec, fixedRange]);

  const layout = useMemo(
    () =>
      baseLayout({
        margin: { l: 62, r: 16, t: 4, b: showXLabels ? 30 : 8 },
        xaxis: axisStyle('x', {
          showticklabels: showXLabels,
          showspikes: true,
          spikemode: 'across',
          spikethickness: 1,
          spikecolor: INK.muted,
          spikedash: 'dot',
        }),
        yaxis: axisStyle(
          'y',
          fixedRange != null
            ? { range: [-fixedRange, fixedRange], autorange: false }
            : { autorange: true },
        ),
      }),
    [showXLabels, fixedRange],
  );

  const divRef = useAnalysisPlot({
    key: `acc:${axis.key}`,
    baseLayout: layout,
    follow: () => followRef.current,
    windowSec: () => viewRef.current,
    refreshHz: 8,
    exportName: `narbis-h10-acc-${axis.key}`,
    pull: () => {
      const now = Date.now();
      const sh = shapingRef.current;
      const w = sessionLog.accWindow(viewRef.current, now, axis.key);
      const shaped = shapeSeries(w.x, w.y, sh);
      let lo = Infinity;
      let hi = -Infinity;
      for (const v of shaped.y) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      p2pRef.current = shaped.y.length > 1 ? hi - lo : null;
      const traces: Data[] = [
        {
          x: shaped.x.map((t) => new Date(t)),
          y: shaped.y,
          type: sh.shape === 'linear' ? 'scattergl' : 'scatter',
          mode: 'lines',
          name: axis.name,
          line: { color: axis.color, width: 1.4, shape: sh.shape },
          hovertemplate: `${axis.name}: %{y:.1f} mG<extra></extra>`,
        } as Data,
      ];
      return { traces, seq: sessionLog.seq + rev.current * 1_000_000 };
    },
  });

  const detrended = shaping.detrendSec > 0;

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">
          {axis.name} <span className="unit">({detrended ? 'mG, baseline removed' : 'mG'})</span>
          <Info text={axis.hint} />
        </span>
        <Readout color={axis.color} name="now" value={fmt(live, 0)} unit="mG" />
        <Readout color={axis.color} name="peak-to-peak" value={fmt(p2pRef.current, 1)} unit="mG" />
      </div>
      <div ref={divRef} className="plot" style={{ height }} />
    </div>
  );
}

export default function AccChart({ streaming }: { streaming: boolean }): ReactNode {
  const settings = useSettings();
  const { accShaping, patchAccShaping, acc, toggleAcc, accGain, setAccGain } = settings;

  const enabled = AXES.filter((a) => acc[a.key]);
  const n = sessionLog.acc.t.length;
  const last = n > 0 ? n - 1 : -1;
  const live = (k: AxisKey): number | null => {
    if (last < 0) return null;
    if (k === 'mag') {
      const x = sessionLog.acc.x[last];
      const y = sessionLog.acc.y[last];
      const z = sessionLog.acc.z[last];
      return Math.sqrt(x * x + y * y + z * z);
    }
    return sessionLog.acc[k][last];
  };

  // Panel height shrinks as more channels are shown, so four axes still fit on
  // screen together without the card becoming a scroll trap.
  const height = enabled.length >= 4 ? 130 : enabled.length === 3 ? 155 : 190;

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">
          Polar H10 accelerometer
          <Info text="All three axes from the H10's Polar Measurement Data service, in raw milli-g, plus the vector magnitude. This is the only direct measurement of the chest wall moving — everything else on this page infers breathing from the heart." />
        </h2>
        {enabled.map((a) => (
          <Readout key={a.key} color={a.color} name={a.name} value={fmt(live(a.key), 0)} unit="mG" />
        ))}
      </div>

      <div className="card-body">
        <div className="plot-wrap">
          {enabled.length === 0 ? (
            <div className="empty">No axes selected — turn one on below.</div>
          ) : (
            enabled.map((a, i) => (
              <AxisPanel
                key={a.key}
                axis={a}
                shaping={accShaping}
                height={height}
                showXLabels={i === enabled.length - 1}
                fixedRange={accGain}
                live={live(a.key)}
              />
            ))
          )}
          {!streaming && n === 0 && (
            <div className="plot-overlay">
              No accelerometer data yet. Connect a Polar H10 — the stream starts automatically.
            </div>
          )}
        </div>
      </div>

      <div className="shaping" style={{ paddingBottom: 0 }}>
        <span className="label">Axes</span>
        {AXES.map((a) => (
          <Check
            key={a.key}
            label={a.name}
            checked={acc[a.key]}
            onChange={() => toggleAcc(a.key)}
            color={a.color}
          />
        ))}
        <div className="sep" />
        <label className="field">
          <span className="label">
            Baseline
            <Info text="Subtracts a slow centred moving average from each channel, which removes gravity and posture drift and leaves the movement. Without it, a few-mG breath is invisible against a ~1000 mG gravity offset. Zero-phase, so nothing shifts in time. Display only — the CSV keeps raw samples." />
          </span>
          <select
            className="input"
            value={String(accShaping.detrendSec)}
            onChange={(e) => patchAccShaping({ detrendSec: Number(e.target.value) })}
          >
            {DETREND_OPTIONS.map((o) => (
              <option key={o.value} value={String(o.value)}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="label">
            Gain
            <Info text="Auto lets each channel scale to its own content — best for seeing small movement, but the channels are then NOT comparable to each other. A fixed ± range puts every channel on the same scale so their amplitudes can be compared directly." />
          </span>
          <select
            className="input"
            value={String(accGain ?? 'auto')}
            onChange={(e) => setAccGain(e.target.value === 'auto' ? null : Number(e.target.value))}
          >
            {GAIN_OPTIONS.map((o) => (
              <option key={String(o.value)} value={String(o.value ?? 'auto')}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <span className="hint">
          {accShaping.detrendSec > 0
            ? `Each channel is shown with its slow ${accShaping.detrendSec}s baseline removed and ${
                accGain == null ? 'its own auto scale' : `a fixed ±${accGain} mG scale`
              }. Breathing is the slow ripple; the faster wobble on top is the cardiac ballistogram.`
            : 'Showing absolute mG. Gravity dominates whichever axis points down — switch Baseline on to see the breathing movement.'}
        </span>
      </div>

      <ShapingControls shaping={accShaping} patch={patchAccShaping} />
    </section>
  );
}
