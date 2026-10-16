import { useEffect, useMemo, useRef, useState } from 'react';
import type { Data, Layout } from 'plotly.js';
import { useDashboardStore } from '../state/store';
import { spo2Buffers } from '../state/spo2Buffer';
import { oximeterBuffers } from '../state/oximeterBuffer';
import { useLivePlot } from '../charts/useLivePlot';
import { CHART_COLORS, darkLayout } from '../charts/chartTheme';
import {
  CAL_MIN_PAIRS, SPO2_CAL_TEXTBOOK, SPO2_OPTIONS, fitSpo2Cal, pairWithReference, spo2FromR,
  type Spo2Cal, type Spo2Estimate, type Spo2Reject,
} from '../metrics/spo2';

/*
 * Spo2Chart — pulse ox from the earclip's red and IR (metrics/spo2.ts): SpO2 a second over the
 * shared window, with the IR perfusion index on the right axis, and the latest reading in the
 * header. Windows that fail a check leave a gap, and the header says why.
 *
 * UNCALIBRATED: SpO2 = a − b·R with the textbook line (110 − 25 R) until it is fitted against a
 * reference pulse oximeter worn at the same time ("cal"). The ratio R is shown so a calibration
 * can be read straight off it. With the reference oximeter connected (ble/innovoOximeter.ts) its
 * SpO2 is drawn beside the earclip's, and "fit from oximeter" fits a and b to the last 5 minutes.
 */

const CAL_KEY = 'spo2Calibration';

function loadCal(): Spo2Cal {
  try {
    const raw = localStorage.getItem(CAL_KEY);
    if (raw) {
      const c = JSON.parse(raw) as Partial<Spo2Cal>;
      if (Number.isFinite(c.a) && Number.isFinite(c.b)) return { a: c.a as number, b: c.b as number };
    }
  } catch { /* private mode / bad JSON */ }
  return SPO2_CAL_TEXTBOOK;
}

function saveCal(c: Spo2Cal): void {
  try { localStorage.setItem(CAL_KEY, JSON.stringify(c)); } catch { /* quota / private mode */ }
}

const WITHHELD: Record<Spo2Reject, string> = {
  warming: 'measuring…',
  no_signal: 'no red / IR signal',
  clipped: 'signal clipped',
  level_step: 'signal level moving',
  weak: 'pulse too weak',
  motion: 'paused: movement (it would read falsely low)',
};

function activeSpo2Buffer() {
  return useDashboardStore.getState().dataSource === 'replay' ? spo2Buffers.replay : spo2Buffers.live;
}

function activeOximeterBuffer() {
  return useDashboardStore.getState().dataSource === 'replay' ? oximeterBuffers.replay : oximeterBuffers.live;
}

/** How much of the recent past "fit from oximeter" pairs up. */
const FIT_WINDOW_SEC = 300;

/** A live reading this old means the stream stopped: show nothing rather than a frozen number. */
const LIVE_STALE_MS = 5000;

export default function Spo2Chart() {
  const windowSec = useDashboardStore((s) => s.windowSec);
  const windowSecRef = useRef(windowSec);
  windowSecRef.current = windowSec;
  const [cal, setCal] = useState<Spo2Cal>(loadCal);
  const calRef = useRef(cal);
  calRef.current = cal;
  /* Bumped on every calibration change, so the plot redraws with the new line. */
  const calVersionRef = useRef(0);
  const [showCal, setShowCal] = useState(false);
  const [fitNote, setFitNote] = useState<string | null>(null);
  const [reading, setReading] = useState<Spo2Estimate | null>(null);
  const oximeterState = useDashboardStore((s) => s.connection.oximeter.state);
  const lastOximeter = useDashboardStore((s) => s.lastOximeter);

  useEffect(() => {
    const id = window.setInterval(() => {
      const last = activeSpo2Buffer().latest();
      const live = useDashboardStore.getState().dataSource === 'live';
      setReading(last && !(live && Date.now() - last.timestamp > LIVE_STALE_MS) ? last.value : null);
    }, 500);
    return () => window.clearInterval(id);
  }, []);

  const yaxisStyle: Partial<Layout['yaxis']> = useMemo(
    () => ({
      gridcolor: '#334155',
      zerolinecolor: '#475569',
      linecolor: '#475569',
      title: { text: 'SpO2 %' },
    }),
    [],
  );
  const yaxis2Style: Partial<Layout['yaxis2']> = useMemo(
    () => ({
      overlaying: 'y',
      side: 'right',
      title: { text: 'PI %' },
      gridcolor: 'transparent',
      zerolinecolor: 'transparent',
      linecolor: '#475569',
      rangemode: 'tozero',
    }),
    [],
  );

  const divRef = useLivePlot({
    id: 'spo2',
    refreshHz: 10,
    followWindowSec: () => windowSecRef.current,
    baseLayout: darkLayout({
      xaxis: { gridcolor: '#334155', zerolinecolor: '#475569', linecolor: '#475569', type: 'date' },
      yaxis: yaxisStyle,
      yaxis2: yaxis2Style,
      margin: { l: 56, r: 48, t: 8, b: 32 },
      showlegend: true,
    }),
    pull: () => {
      const buf = activeSpo2Buffer();
      const oxBuf = activeOximeterBuffer();
      const c = calRef.current;
      const x: number[] = [];
      const spo2: Array<number | null> = [];
      const pi: Array<number | null> = [];
      let lo = 100;
      buf.forEachInWindow(windowSecRef.current, (ts, e) => {
        x.push(ts);
        if (e.reject === null) {
          const v = spo2FromR(e.r, c);
          spo2.push(v);
          pi.push(e.piIr);
          lo = Math.min(lo, v);
        } else {
          spo2.push(null);
          pi.push(null);
        }
      });
      const xRef: number[] = [];
      const ref: Array<number | null> = [];
      oxBuf.forEachInWindow(windowSecRef.current, (ts, r) => {
        xRef.push(ts);
        ref.push(r.spo2);
        if (r.spo2 !== null) lo = Math.min(lo, r.spo2);
      });
      const bottom = Math.min(90, Math.floor(lo) - 1);
      const traces: Data[] = [
        {
          x,
          y: spo2,
          type: 'scatter',
          mode: 'lines',
          name: 'SpO2 (uncalibrated)',
          connectgaps: false,
          line: { color: CHART_COLORS.spo2, width: 2 },
          yaxis: 'y',
        },
        {
          x,
          y: pi,
          type: 'scatter',
          mode: 'lines',
          name: 'perfusion index (IR)',
          connectgaps: false,
          line: { color: CHART_COLORS.perfusion, width: 1, dash: 'dot' },
          yaxis: 'y2',
        },
      ];
      if (xRef.length > 0) {
        traces.push({
          x: xRef,
          y: ref,
          type: 'scatter',
          mode: 'lines',
          name: 'oximeter (reference)',
          connectgaps: false,
          line: { color: CHART_COLORS.oximeter, width: 1.5, shape: 'hv' },
          yaxis: 'y',
        });
      }
      const layoutPatch: Partial<Layout> = {
        yaxis: { ...yaxisStyle, range: [bottom, 100.5], autorange: false },
      };
      // Every term only grows, so the sum changes whenever any of them does.
      return { traces, layoutPatch, seq: buf.seq + oxBuf.seq + calVersionRef.current * 1e9 };
    },
  });

  const updateCal = (patch: Partial<Spo2Cal>) => {
    const next = { ...cal, ...patch };
    if (!Number.isFinite(next.a) || !Number.isFinite(next.b)) return;
    calVersionRef.current++;
    setCal(next);
    saveCal(next);
  };
  const isTextbook = cal.a === SPO2_CAL_TEXTBOOK.a && cal.b === SPO2_CAL_TEXTBOOK.b;

  const fitFromOximeter = () => {
    const pairs = pairWithReference(
      activeSpo2Buffer().getWindow(FIT_WINDOW_SEC),
      activeOximeterBuffer().getWindow(FIT_WINDOW_SEC).map((x) => ({ timestamp: x.timestamp, spo2: x.value.spo2 })),
    );
    const fit = fitSpo2Cal(pairs, cal);
    if (!fit) {
      setFitNote(`needs ${CAL_MIN_PAIRS} s of both readings together (have ${pairs.length})`);
      return;
    }
    updateCal(fit.cal);
    setFitNote(
      `fitted on ${fit.n} s, oximeter ${fit.refMin}–${fit.refMax} %` +
        (fit.mode === 'offset' ? ', so only a (it needs a 4-point spread to fit b)' : '') +
        `; RMS ${fit.rmse.toFixed(1)} points`,
    );
  };

  const est = reading;
  const shown = est && est.reject === null ? spo2FromR(est.r, cal) : null;

  return (
    <div className="rounded border border-slate-800 bg-slate-900/50 flex flex-col min-h-[200px]">
      <div className="flex items-center justify-between gap-3 px-3 py-1.5 border-b border-slate-800">
        <span
          className="text-xs font-medium text-slate-300"
          title={
            `Estimated from the red / IR ratio of ratios over ${SPO2_OPTIONS.windowSec} s, once a second. ` +
            `SpO2 = ${cal.a} − ${cal.b} × R` +
            (isTextbook
              ? ' (the textbook line, uncalibrated). Read it as a trend until it is calibrated against a reference pulse oximeter. '
              : ' (calibrated here, against a reference oximeter or by hand). ') +
            'Not a medical measurement.'
          }
        >
          Pulse ox · SpO2
          {isTextbook ? (
            <span className="ml-1.5 text-[10px] font-normal text-amber-400/80">uncalibrated</span>
          ) : (
            <span className="ml-1.5 text-[10px] font-normal text-slate-400">
              cal {cal.a} − {cal.b} R
            </span>
          )}
        </span>
        <div className="flex items-center gap-3">
          <span className="text-2xl font-semibold tabular-nums" style={{ color: shown !== null ? CHART_COLORS.spo2 : '#64748b' }}>
            {shown !== null ? `${shown.toFixed(0)} %` : '— %'}
          </span>
          {oximeterState !== 'disconnected' ? (
            <span
              className="text-[11px] tabular-nums leading-tight text-right"
              style={{ color: CHART_COLORS.oximeter }}
              title="The reference fingertip oximeter (rated ±2 %)"
            >
              oximeter
              <br />
              {lastOximeter?.reading.spo2 != null ? `${lastOximeter.reading.spo2} %` : '—'}
            </span>
          ) : null}
          <span className="text-[11px] text-slate-400 tabular-nums leading-tight">
            {est && Number.isFinite(est.r) ? (
              <>
                R {est.r.toFixed(3)} · PI {est.piIr.toFixed(2)} %
                <br />
                {est.reject ? WITHHELD[est.reject] : `red/IR match ${(100 * est.corr).toFixed(1)} %`}
              </>
            ) : (
              est ? WITHHELD[est.reject ?? 'warming'] : 'needs the earclip\'s red + IR'
            )}
          </span>
          <button
            type="button"
            onClick={() => setShowCal((v) => !v)}
            className="text-[11px] px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200"
            title="Calibration: SpO2 = a − b × R"
          >
            cal
          </button>
        </div>
      </div>
      {showCal ? (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-slate-800 text-[11px] text-slate-400">
          <span>SpO2 =</span>
          <input
            type="number"
            step="0.5"
            value={cal.a}
            onChange={(e) => updateCal({ a: Number(e.target.value) })}
            className="w-16 px-1 py-0.5 rounded bg-slate-800 text-slate-100 tabular-nums"
            aria-label="calibration a"
          />
          <span>−</span>
          <input
            type="number"
            step="0.5"
            value={cal.b}
            onChange={(e) => updateCal({ b: Number(e.target.value) })}
            className="w-16 px-1 py-0.5 rounded bg-slate-800 text-slate-100 tabular-nums"
            aria-label="calibration b"
          />
          <span>× R</span>
          <button
            type="button"
            disabled={isTextbook}
            onClick={() => updateCal(SPO2_CAL_TEXTBOOK)}
            className="ml-2 px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:opacity-40"
          >
            textbook
          </button>
          <button
            type="button"
            onClick={fitFromOximeter}
            className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200"
            title={`Fit a (and b, if the oximeter moved enough) to the last ${FIT_WINDOW_SEC / 60} minutes of paired readings`}
          >
            fit from oximeter
          </button>
          <span className="ml-auto text-slate-500">
            {fitNote ?? 'wear the reference oximeter at the same time, then fit'}
          </span>
        </div>
      ) : null}
      <div ref={divRef} className="flex-1 min-h-0" />
    </div>
  );
}
