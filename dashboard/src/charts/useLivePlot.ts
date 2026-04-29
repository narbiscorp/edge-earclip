import { useEffect, useRef } from 'react';
import Plotly from 'plotly.js-dist-min';
import type { Data, Layout, Shape } from 'plotly.js';
import { chartSync, type ChartId } from './chartSync';

export interface LivePlotSnapshot {
  traces: Data[];
  layoutPatch?: Partial<Layout>;
}

export interface UseLivePlotOptions {
  id: ChartId;
  baseLayout: Partial<Layout>;
  pull: () => LivePlotSnapshot;
  pausedRef?: React.MutableRefObject<boolean>;
  refreshHz?: number;
}

const DEFAULT_HZ = 30;

export function useLivePlot(opts: UseLivePlotOptions): React.RefObject<HTMLDivElement | null> {
  const divRef = useRef<HTMLDivElement | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    const div = divRef.current;
    if (!div) return;

    const initial = optsRef.current.pull();
    const baseLayout: Partial<Layout> = {
      ...optsRef.current.baseLayout,
      ...(initial.layoutPatch ?? {}),
    };
    void Plotly.newPlot(div, initial.traces, baseLayout, {
      responsive: true,
      displayModeBar: false,
      doubleClick: 'reset',
    });

    let crosshair_ms: number | null = null;
    let externalRange: [number, number] | null = null;
    let raf = 0;
    let lastDraw = 0;
    const period = 1000 / (optsRef.current.refreshHz ?? DEFAULT_HZ);

    const tick = (now: number): void => {
      raf = requestAnimationFrame(tick);
      if (optsRef.current.pausedRef?.current) return;
      if (now - lastDraw < period) return;
      lastDraw = now;
      const snap = optsRef.current.pull();
      const layoutPatch: Partial<Layout> = { ...(snap.layoutPatch ?? {}) };
      if (externalRange) {
        layoutPatch.xaxis = { ...(layoutPatch.xaxis ?? {}), range: externalRange, autorange: false };
      }
      if (crosshair_ms !== null) {
        const shape: Partial<Shape> = {
          type: 'line',
          xref: 'x',
          yref: 'paper',
          x0: crosshair_ms,
          x1: crosshair_ms,
          y0: 0,
          y1: 1,
          line: { color: '#94a3b8', width: 1, dash: 'dot' },
        };
        layoutPatch.shapes = [shape as Shape];
      } else {
        layoutPatch.shapes = [];
      }
      void Plotly.react(div, snap.traces, { ...optsRef.current.baseLayout, ...layoutPatch });
    };
    raf = requestAnimationFrame(tick);

    type PlotlyEventDiv = HTMLDivElement & {
      on: (event: string, cb: (data: unknown) => void) => void;
      removeAllListeners?: (event: string) => void;
    };
    const evDiv = div as PlotlyEventDiv;

    const toMs = (v: unknown): number | null => {
      if (typeof v === 'number') return v;
      if (typeof v === 'string') {
        const t = Date.parse(v);
        return Number.isNaN(t) ? null : t;
      }
      if (v instanceof Date) return v.getTime();
      return null;
    };
    const onRelayout = (data: unknown): void => {
      const d = data as Record<string, unknown>;
      const r0 = toMs(d['xaxis.range[0]']);
      const r1 = toMs(d['xaxis.range[1]']);
      if (r0 !== null && r1 !== null) {
        chartSync.emitTimeRange(optsRef.current.id, [r0, r1]);
      } else if (d['xaxis.autorange'] === true) {
        chartSync.emitTimeRange(optsRef.current.id, null);
      }
    };
    const onHover = (data: unknown): void => {
      const d = data as { points?: { x: unknown }[] };
      const pt = d.points?.[0]?.x;
      const x_ms = typeof pt === 'number' ? pt : pt instanceof Date ? pt.getTime() : null;
      if (x_ms !== null) chartSync.emitHover(optsRef.current.id, x_ms);
    };
    const onUnhover = (): void => {
      chartSync.emitHover(optsRef.current.id, null);
    };
    evDiv.on('plotly_relayout', onRelayout);
    evDiv.on('plotly_hover', onHover);
    evDiv.on('plotly_unhover', onUnhover);

    const detachRange = chartSync.onTimeRange((ev) => {
      if (ev.source === optsRef.current.id) return;
      externalRange = ev.range;
    });
    const detachHover = chartSync.onHover((ev) => {
      if (ev.source === optsRef.current.id) return;
      crosshair_ms = ev.x_ms;
    });

    return () => {
      cancelAnimationFrame(raf);
      detachRange();
      detachHover();
      if (typeof evDiv.removeAllListeners === 'function') {
        evDiv.removeAllListeners('plotly_relayout');
        evDiv.removeAllListeners('plotly_hover');
        evDiv.removeAllListeners('plotly_unhover');
      }
      Plotly.purge(div);
    };
  }, []);

  return divRef;
}
