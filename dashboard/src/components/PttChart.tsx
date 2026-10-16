import { useEffect, useMemo, useRef, useState } from 'react';
import type { Data, Layout } from 'plotly.js';
import { useDashboardStore } from '../state/store';
import { useLivePlot } from '../charts/useLivePlot';
import { CHART_COLORS, darkLayout } from '../charts/chartTheme';
import { patBuffer, pttStats } from '../state/pttState';
import { recentMedian } from '../metrics/ptt';

/*
 * PttChart — pulse arrival time per beat: H10 ECG R-peak → the earclip's pulse (metrics/ptt.ts).
 * Dots per beat (grey: found during light motion), and the median of the last 15 as a line.
 * Needs the H10's ECG running (H10EcgChart "Start ECG") and the earclip streaming.
 */

const MEDIAN_N = 15;

export default function PttChart() {
  const windowSec = useDashboardStore((s) => s.windowSec);
  const windowSecRef = useRef(windowSec);
  windowSecRef.current = windowSec;
  const [now, setNow] = useState<{ med: number | null; n: number; ecg: number | null; ear: number | null; un: number }>({
    med: null, n: 0, ecg: null, ear: null, un: 0,
  });

  useEffect(() => {
    const id = window.setInterval(() => {
      const last = patBuffer.getWindow(30).map((s) => s.value.pat);
      setNow({
        med: recentMedian(last, MEDIAN_N),
        n: pttStats.paired,
        ecg: pttStats.ecgOffsetMs,
        ear: pttStats.earOffsetMs,
        un: pttStats.unpaired,
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  const yaxis: Partial<Layout['yaxis']> = useMemo(
    () => ({ gridcolor: '#334155', zerolinecolor: '#475569', linecolor: '#475569', title: { text: 'ms' } }),
    [],
  );

  const divRef = useLivePlot({
    id: 'ptt',
    refreshHz: 5,
    followWindowSec: () => windowSecRef.current,
    baseLayout: darkLayout({
      xaxis: { gridcolor: '#334155', zerolinecolor: '#475569', linecolor: '#475569', type: 'date' },
      yaxis,
      showlegend: true,
    }),
    pull: () => {
      const xs: number[] = [], ys: number[] = [], xm: number[] = [], ym: number[] = [];
      const xmed: number[] = [], ymed: number[] = [];
      const hist: number[] = [];
      patBuffer.forEachInWindow(windowSecRef.current, (t, s) => {
        (s.motion ? xm : xs).push(t);
        (s.motion ? ym : ys).push(s.pat);
        hist.push(s.pat);
        const m = recentMedian(hist, MEDIAN_N);
        if (m !== null) {
          xmed.push(t);
          ymed.push(m);
        }
      });
      const traces: Data[] = [
        { x: xs, y: ys, type: 'scattergl', mode: 'markers', name: 'per beat', marker: { color: CHART_COLORS.earclip, size: 4 } },
        { x: xm, y: ym, type: 'scattergl', mode: 'markers', name: 'during motion', marker: { color: CHART_COLORS.flaggedBeat, size: 4 } },
        { x: xmed, y: ymed, type: 'scattergl', mode: 'lines', name: `median of ${MEDIAN_N}`, line: { color: '#fde047', width: 2 } },
      ];
      return { traces, seq: patBuffer.seq };
    },
  });

  const clock = (v: number | null) => (v === null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(0)} ms`);

  return (
    <div className="rounded border border-slate-800 bg-slate-900/50 flex flex-col min-h-[200px]">
      <div className="flex items-center justify-between gap-3 px-3 py-1.5 border-b border-slate-800">
        <span
          className="text-xs font-medium text-slate-300"
          title={
            'Pulse arrival time: from the R-peak in the H10 ECG to the earclip beat (the pulse reaching the ear). ' +
            'It includes the pre-ejection period, so it reads above true transit time, and a finger reads longer than an ear; ' +
            'its changes follow blood pressure and vascular tone. Both clocks are moved onto their fastest packet of the last ' +
            'minute (the corrections at right); what is left is a few ms, constant.'
          }
        >
          Pulse transit · ECG R → earclip
        </span>
        <div className="flex items-center gap-3 text-[11px] text-slate-400 tabular-nums">
          <span className="text-2xl font-semibold text-slate-100">{now.med !== null ? `${now.med.toFixed(0)} ms` : '— ms'}</span>
          <span className="leading-tight">
            {now.n} beats paired{now.un ? `, ${now.un} not` : ''}
            <br />
            clock fix: H10 {clock(now.ecg)} · earclip {clock(now.ear)}
          </span>
        </div>
      </div>
      <div ref={divRef} className="flex-1 min-h-0" />
    </div>
  );
}
