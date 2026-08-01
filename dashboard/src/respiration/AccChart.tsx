/*
 * AccChart.tsx — every axis of the Polar H10 accelerometer.
 *
 * X, Y and Z in raw milli-g plus the vector magnitude. All four share one
 * y-scale because they share a unit, which is what makes the gravity split
 * legible: whichever axis the strap has pointing down sits near ±1000 mG while
 * the others hover near zero, and the breathing signal is the slow ripple on
 * top of that.
 *
 * This chart is the reason the app decimates. A 10 minute window at 50 Hz is
 * 30 000 samples per axis; the LTTB reduction keeps the envelope of the
 * breathing waveform where plain striding would drop the turning points.
 */
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { Data } from 'plotly.js';
import { sessionLog } from './log';
import { shapeSeries } from './dsp';
import { useAnalysisPlot } from './plot';
import { SERIES, INK, baseLayout, axisStyle } from './theme';
import { useSettings } from './settings';
import { ShapingControls, Readout, fmt, Info, Check } from './ui';

const AXES = [
  { key: 'x', name: 'X', color: SERIES.s1 },
  { key: 'y', name: 'Y', color: SERIES.s2 },
  { key: 'z', name: 'Z', color: SERIES.s3 },
  { key: 'mag', name: '|magnitude|', color: SERIES.s4 },
] as const;

export default function AccChart({ streaming }: { streaming: boolean }): ReactNode {
  const settings = useSettings();
  const { accShaping, patchAccShaping, acc, toggleAcc } = settings;

  const viewRef = useRef(settings.viewWindowSec);
  viewRef.current = settings.viewWindowSec;
  const followRef = useRef(settings.follow);
  followRef.current = settings.follow;
  const shapingRef = useRef(accShaping);
  shapingRef.current = accShaping;
  const accRef = useRef(acc);
  accRef.current = acc;

  const rev = useRef(0);
  const shapingKey = JSON.stringify(accShaping);
  const accKey = JSON.stringify(acc);
  useEffect(() => {
    rev.current += 1;
  }, [shapingKey, accKey, settings.viewWindowSec]);

  const layout = useMemo(
    () =>
      baseLayout({
        margin: { l: 58, r: 16, t: 4, b: 30 },
        xaxis: axisStyle('x', {
          showspikes: true,
          spikemode: 'across',
          spikethickness: 1,
          spikecolor: INK.muted,
          spikedash: 'dot',
        }),
        yaxis: axisStyle('y', {
          title: { text: 'mG  (1000 ≈ 1 g)', font: { color: INK.muted, size: 11 } },
        }),
      }),
    [],
  );

  const divRef = useAnalysisPlot({
    key: 'acc',
    baseLayout: layout,
    follow: () => followRef.current,
    windowSec: () => viewRef.current,
    refreshHz: 8,
    exportName: 'narbis-h10-accelerometer',
    pull: () => {
      const now = Date.now();
      const win = viewRef.current;
      const sh = shapingRef.current;
      const on = accRef.current;
      const traces: Data[] = [];
      for (const a of AXES) {
        if (!on[a.key]) continue;
        const w = sessionLog.accWindow(win, now, a.key);
        if (w.x.length === 0) continue;
        const shaped = shapeSeries(w.x, w.y, sh);
        traces.push({
          x: shaped.x.map((t) => new Date(t)),
          y: shaped.y,
          type: sh.shape === 'linear' ? 'scattergl' : 'scatter',
          mode: 'lines',
          name: a.name,
          line: { color: a.color, width: 1.4, shape: sh.shape },
          hovertemplate: `${a.name}: %{y:.0f} mG<extra></extra>`,
        } as Data);
      }
      return { traces, seq: sessionLog.seq + rev.current * 1_000_000 };
    },
  });

  const n = sessionLog.acc.t.length;
  const last = n > 0 ? n - 1 : -1;
  const live = (k: (typeof AXES)[number]['key']): number | null => {
    if (last < 0) return null;
    if (k === 'mag') {
      const x = sessionLog.acc.x[last];
      const y = sessionLog.acc.y[last];
      const z = sessionLog.acc.z[last];
      return Math.sqrt(x * x + y * y + z * z);
    }
    return sessionLog.acc[k][last];
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">
          Polar H10 accelerometer
          <Info text="All three axes from the H10's Polar Measurement Data service, in raw milli-g, plus the vector magnitude. This is the only direct measurement of the chest wall moving — everything else in this app infers breathing from the heart." />
        </h2>
        {AXES.filter((a) => acc[a.key]).map((a) => (
          <Readout key={a.key} color={a.color} name={a.name} value={fmt(live(a.key), 0)} unit="mG" />
        ))}
      </div>

      <div className="card-body">
        {!streaming && n === 0 ? (
          <div className="empty">
            No accelerometer data yet. Connect a Polar H10 — the stream starts automatically.
          </div>
        ) : (
          <div ref={divRef} className="plot" style={{ height: 250 }} />
        )}
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
        <span className="hint">
          Gravity dominates whichever axis points down, so the axes sit at different offsets — the
          breathing signal is the slow ripple riding on top. To isolate it, try the Savitzky–Golay
          or median filter with a wide window.
        </span>
      </div>

      <ShapingControls shaping={accShaping} patch={patchAccShaping} />
    </section>
  );
}
