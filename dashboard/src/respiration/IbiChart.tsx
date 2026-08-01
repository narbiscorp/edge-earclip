/*
 * IbiChart.tsx — the tachogram: every inter-beat interval, as recorded.
 *
 * This is the rawest view in the app. Metrics are derived from it, so when a
 * coherence trace does something surprising this is where you look first.
 * Rejected beats are drawn, not hidden: a gap in the tachogram with no marker
 * would look like the subject's heart paused.
 */
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { Data } from 'plotly.js';
import { sessionLog } from './log';
import { shapeSeries } from './dsp';
import { useAnalysisPlot } from './plot';
import { SERIES, STATUS, INK, baseLayout, axisStyle } from './theme';
import { useSettings } from './settings';
import { ShapingControls, Readout, fmt, Info, Check } from './ui';

export default function IbiChart(): ReactNode {
  const settings = useSettings();
  const {
    ibiShaping,
    patchIbiShaping,
    ibiShowH10,
    setIbiShowH10,
    ibiShowEarclip,
    setIbiShowEarclip,
    ibiShowArtifacts,
    setIbiShowArtifacts,
  } = settings;

  const viewRef = useRef(settings.viewWindowSec);
  viewRef.current = settings.viewWindowSec;
  const followRef = useRef(settings.follow);
  followRef.current = settings.follow;
  const shapingRef = useRef(ibiShaping);
  shapingRef.current = ibiShaping;
  const showRef = useRef({ h10: ibiShowH10, earclip: ibiShowEarclip, artifacts: ibiShowArtifacts });
  showRef.current = { h10: ibiShowH10, earclip: ibiShowEarclip, artifacts: ibiShowArtifacts };

  const rev = useRef(0);
  const shapingKey = JSON.stringify(ibiShaping);
  useEffect(() => {
    rev.current += 1;
  }, [shapingKey, ibiShowH10, ibiShowEarclip, ibiShowArtifacts, settings.viewWindowSec]);

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
        yaxis: axisStyle('y', { title: { text: 'IBI (ms)', font: { color: INK.muted, size: 11 } } }),
      }),
    [],
  );

  const divRef = useAnalysisPlot({
    key: 'ibi',
    baseLayout: layout,
    follow: () => followRef.current,
    windowSec: () => viewRef.current,
    refreshHz: 6,
    exportName: 'narbis-tachogram',
    pull: () => {
      const now = Date.now();
      const win = viewRef.current;
      const sh = shapingRef.current;
      const show = showRef.current;
      const traces: Data[] = [];

      const addSource = (src: 'h10' | 'earclip', name: string, color: string): void => {
        const w = sessionLog.beatWindow(win, now, src, false);
        if (w.x.length === 0) return;
        const shaped = shapeSeries(w.x, w.y, sh);
        traces.push({
          x: shaped.x.map((t) => new Date(t)),
          y: shaped.y,
          type: sh.shape === 'linear' ? 'scattergl' : 'scatter',
          mode: 'lines',
          name,
          line: { color, width: 1.6, shape: sh.shape },
          hovertemplate: `${name}: %{y:.0f} ms<extra></extra>`,
        } as Data);
      };

      if (show.h10) addSource('h10', 'Polar H10', SERIES.s1);
      if (show.earclip) addSource('earclip', 'Earclip', SERIES.s2);

      if (show.artifacts) {
        const src = show.h10 && show.earclip ? 'both' : show.earclip ? 'earclip' : 'h10';
        const a = sessionLog.artifactWindow(win, now, src);
        if (a.x.length > 0) {
          traces.push({
            x: a.x.map((t) => new Date(t)),
            y: a.y,
            type: 'scatter',
            mode: 'markers',
            name: 'Rejected',
            // A reserved status color plus a distinct symbol — never color alone.
            marker: { color: STATUS.critical, size: 9, symbol: 'x-thin', line: { width: 2, color: STATUS.critical } },
            hovertemplate: 'Rejected: %{y:.0f} ms<extra></extra>',
          } as Data);
        }
      }

      return { traces, seq: sessionLog.seq + rev.current * 1_000_000 };
    },
  });

  // Live readouts, taken from the tail of the log rather than the drawn (and
  // possibly filtered) series — the number beside the label is the real one.
  const lastH10 = sessionLog.lastIbi('h10');
  const lastEar = sessionLog.lastIbi('earclip');
  const shownSource: 'h10' | 'earclip' | 'both' =
    ibiShowH10 && ibiShowEarclip ? 'both' : ibiShowEarclip ? 'earclip' : 'h10';
  const rejected = sessionLog.artifactCountInWindow(
    settings.viewWindowSec,
    Date.now(),
    shownSource,
  );

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">
          Inter-beat intervals
          <Info text="One point per heartbeat: the time in milliseconds since the previous beat. Every beat recorded is in the CSV, including the rejected ones — the tachogram just draws them differently." />
        </h2>
        {ibiShowH10 && <Readout color={SERIES.s1} name="Polar H10" value={fmt(lastH10, 0)} unit="ms" />}
        {ibiShowEarclip && <Readout color={SERIES.s2} name="Earclip" value={fmt(lastEar, 0)} unit="ms" />}
        {ibiShowArtifacts && rejected > 0 && (
          <Readout color={STATUS.critical} name="Rejected in view" value={String(rejected)} />
        )}
      </div>

      <div className="card-body">
        <div ref={divRef} className="plot" style={{ height: 230 }} />
      </div>

      <div className="shaping" style={{ paddingBottom: 0, borderBottom: 'none' }}>
        <span className="label">Sources</span>
        <Check label="Polar H10" checked={ibiShowH10} onChange={setIbiShowH10} color={SERIES.s1} />
        <Check label="Earclip" checked={ibiShowEarclip} onChange={setIbiShowEarclip} color={SERIES.s2} />
        <div className="sep" />
        <Check
          label="Mark rejected beats"
          checked={ibiShowArtifacts}
          onChange={setIbiShowArtifacts}
          color={STATUS.critical}
        />
        <span className="hint">
          A beat is rejected when its interval falls outside 300–2000 ms, or when the earclip flagged
          it as an artifact. Rejected beats are excluded from the HRV metrics but never from the log
          or the CSV.
        </span>
      </div>

      <ShapingControls shaping={ibiShaping} patch={patchIbiShaping} />
    </section>
  );
}
