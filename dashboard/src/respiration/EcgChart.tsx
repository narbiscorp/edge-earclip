/*
 * EcgChart.tsx — the raw Polar H10 ECG lead.
 *
 * 130 Hz, signed microvolts, straight off the strap with no filtering applied
 * to the stored samples. This is the ground truth the whole page rests on: the
 * tachogram is Polar's R-peak detector's opinion about this waveform, so when a
 * beat looks wrong, this is where you check whether the beat was real.
 *
 * The stream is OFF by default. It is 130 Hz of data that respiration work does
 * not need, and it costs H10 battery — so it is opt-in rather than something
 * you discover draining the strap.
 */
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { Data } from 'plotly.js';
import { sessionLog } from './log';
import { shapeSeries } from './dsp';
import { useAnalysisPlot } from './plot';
import { SERIES, INK, baseLayout, axisStyle } from './theme';
import { useSettings, DETREND_OPTIONS } from './settings';
import { ShapingControls, Readout, fmt, Info } from './ui';

export default function EcgChart({
  streaming,
  onToggle,
  busy,
}: {
  streaming: boolean;
  onToggle: (on: boolean) => void;
  busy: boolean;
}): ReactNode {
  const settings = useSettings();
  const { ecgShaping, patchEcgShaping } = settings;

  const viewRef = useRef(settings.viewWindowSec);
  viewRef.current = settings.viewWindowSec;
  const followRef = useRef(settings.follow);
  followRef.current = settings.follow;
  const shapingRef = useRef(ecgShaping);
  shapingRef.current = ecgShaping;
  const p2pRef = useRef<number | null>(null);

  const rev = useRef(0);
  const shapingKey = JSON.stringify(ecgShaping);
  useEffect(() => {
    rev.current += 1;
  }, [shapingKey, settings.viewWindowSec]);

  const layout = useMemo(
    () =>
      baseLayout({
        margin: { l: 62, r: 16, t: 4, b: 30 },
        xaxis: axisStyle('x', {
          showspikes: true,
          spikemode: 'across',
          spikethickness: 1,
          spikecolor: INK.muted,
          spikedash: 'dot',
        }),
        yaxis: axisStyle('y', {
          title: { text: 'µV', font: { color: INK.muted, size: 11 } },
        }),
      }),
    [],
  );

  const divRef = useAnalysisPlot({
    key: 'ecg',
    baseLayout: layout,
    follow: () => followRef.current,
    windowSec: () => viewRef.current,
    refreshHz: 20,
    exportName: 'narbis-h10-ecg',
    seq: () => sessionLog.seq + rev.current * 1_000_000,
    pull: () => {
      const now = Date.now();
      const sh = shapingRef.current;
      const w = sessionLog.ecgWindow(viewRef.current, now);
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
          name: 'ECG',
          line: { color: SERIES.s1, width: 1.2, shape: sh.shape },
          hovertemplate: 'ECG: %{y:.0f} µV<extra></extra>',
        } as Data,
      ];
      return { traces };
    },
  });

  const n = sessionLog.ecg.t.length;
  const lastUv = n > 0 ? sessionLog.ecg.uv[n - 1] : null;

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">
          ECG
          <Info text="The raw electrocardiogram lead from the Polar H10, 130 Hz in signed microvolts. Polar's own R-peak detector runs on this signal to produce the RR intervals in the tachogram above — so this is where to look when a beat there seems wrong." />
        </h2>
        {n > 0 && <Readout color={SERIES.s1} name="now" value={fmt(lastUv, 0)} unit="µV" />}
        {n > 0 && (
          <Readout color={SERIES.s1} name="peak-to-peak" value={fmt(p2pRef.current, 0)} unit="µV" />
        )}
        <span className="pill">{n.toLocaleString()} samples</span>
        <button
          className={streaming ? 'btn sm' : 'btn primary sm'}
          disabled={busy}
          onClick={() => onToggle(!streaming)}
        >
          {busy ? 'Working…' : streaming ? 'Stop ECG' : 'Start ECG'}
        </button>
      </div>

      <div className="card-body">
        <div className="plot-wrap">
          <div ref={divRef} className="plot" style={{ height: 250 }} />
          {!streaming && n === 0 && (
            <div className="plot-overlay">
              ECG is off. Connect a Polar H10 and press Start ECG — it streams at 130 Hz and is not
              needed for respiration analysis, so it stays off until you ask for it.
            </div>
          )}
        </div>
      </div>

      <div className="shaping" style={{ paddingBottom: 0 }}>
        <label className="field">
          <span className="label">
            Baseline
            <Info text="Removes slow wander — respiration and electrode drift move the whole trace up and down by more than the P and T waves are tall. 2-4 s keeps the QRS intact while flattening the wander. Display only; the CSV keeps raw samples." />
          </span>
          <select
            className="input"
            value={String(ecgShaping.detrendSec)}
            onChange={(e) => patchEcgShaping({ detrendSec: Number(e.target.value) })}
          >
            {DETREND_OPTIONS.map((o) => (
              <option key={o.value} value={String(o.value)}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <span className="hint">
          Raw lead, unfiltered — no mains notch and no bandpass. At a 5-minute view window the
          drawing budget reduces roughly 39 000 samples to a few thousand, so individual QRS
          complexes only resolve once you narrow the view to 30 s or so.
        </span>
      </div>

      <ShapingControls shaping={ecgShaping} patch={patchEcgShaping} />
    </section>
  );
}
