import { useMemo, useRef } from 'react';
import type { Data, Layout } from 'plotly.js';
import { accMagBuffer, useDashboardStore } from '../state/store';
import { useLivePlot } from '../charts/useLivePlot';
import { darkLayout } from '../charts/chartTheme';

/*
 * AccChart — the breathing wave extracted from the Polar H10 accelerometer.
 *
 * The PMD ACC stream's vector magnitude is dominated by gravity (a large DC offset). We
 * subtract a slow EWMA (~12 s) as a display high-pass, which drops the DC + posture drift
 * and leaves the small chest-wall oscillation: the up-slope is inhale, the down-slope is
 * exhale. This is the same independent respiration signal Mode B verifies each dwell against.
 */
interface Props {
  compact?: boolean;
  windowSec?: number;
}

export default function AccChart({ windowSec: windowSecProp }: Props = {}) {
  const storeWindowSec = useDashboardStore((s) => s.windowSec);
  const effectiveWindowSec = windowSecProp ?? storeWindowSec;
  const windowSecRef = useRef(effectiveWindowSec);
  windowSecRef.current = effectiveWindowSec;

  const yaxisStyle: Partial<Layout['yaxis']> = useMemo(
    () => ({
      gridcolor: '#334155',
      zerolinecolor: '#475569',
      linecolor: '#475569',
      title: { text: 'inhale ↑ / exhale ↓' },
      showticklabels: false,
      autorange: true,
    }),
    [],
  );

  const divRef = useLivePlot({
    id: 'acc',
    refreshHz: 10,
    followWindowSec: () => windowSecRef.current,
    baseLayout: darkLayout({
      xaxis: {
        gridcolor: '#334155',
        zerolinecolor: '#475569',
        linecolor: '#475569',
        type: 'date',
      },
      yaxis: yaxisStyle,
      showlegend: false,
    }),
    pull: () => {
      const seq = accMagBuffer.seq;
      const xs: number[] = [];
      const raw: number[] = [];
      accMagBuffer.forEachInWindow(windowSecRef.current, (ts, v) => {
        xs.push(ts);
        raw.push(v);
      });
      // Display BAND-pass ~0.014–0.4 Hz. A slow EWMA removes the gravity DC + posture drift
      // (high-pass); two fast EWMAs then knock down the ~1–1.5 Hz cardiac ballistogram (the H10
      // sits over the heart, so each beat jolts it far harder than the slow breath does). What's
      // left is the breathing oscillation.
      const y = new Array<number>(raw.length);
      let slow = raw.length > 0 ? raw[0] : 0;
      let lp1 = 0;
      let lp2 = 0;
      const slowAlpha = 0.0017; // ~12 s τ — high-pass (drops < ~0.014 Hz)
      const lpAlpha = 0.05; // ~0.4 Hz/pole — two poles attenuate the heartbeat, pass breathing
      for (let i = 0; i < raw.length; i++) {
        slow += (raw[i] - slow) * slowAlpha;
        const hp = raw[i] - slow;
        lp1 += (hp - lp1) * lpAlpha;
        lp2 += (lp1 - lp2) * lpAlpha;
        y[i] = lp2;
      }
      const traces: Data[] = [
        {
          x: xs,
          y,
          type: 'scattergl',
          mode: 'lines',
          name: 'breathing',
          line: { color: '#5eead4', width: 1.5, shape: 'spline' },
        },
      ];
      return { traces, seq };
    },
  });

  const hasData = useDashboardStore((s) => s.engineStatus?.mode === 'modeB' && s.connection.polar.state === 'connected');

  return (
    <div className="rounded border border-slate-800 bg-slate-900/50 flex flex-col min-h-[150px] relative">
      <div className="px-3 py-1.5 border-b border-slate-800">
        <span className="text-xs font-medium text-slate-300">Breathing wave · H10 accelerometer</span>
      </div>
      <div ref={divRef} className="flex-1 min-h-0" />
      {!hasData ? (
        <div className="absolute inset-0 top-8 flex items-center justify-center pointer-events-none text-xs text-slate-500">
          Mode B + Polar H10 streams the accelerometer breathing wave here
        </div>
      ) : null}
    </div>
  );
}
