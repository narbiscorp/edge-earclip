/*
 * plot.ts — the live-plot hook and cross-chart x-axis link.
 *
 * Deliberately not the dashboard's useLivePlot: that one locks every axis
 * (`fixedrange: true`, `dragmode: false`) because the dashboard is a monitor.
 * This is an analysis tool, so pausing must give you real pan, zoom, box-select
 * and PNG export. Following and interacting are mutually exclusive by nature —
 * you cannot drag an axis that is being rewritten 10 times a second — so
 * "follow" is an explicit toggle and the axis is only driven while it is on.
 */
import { useEffect, useRef } from 'react';
import Plotly from 'plotly.js-dist-min';
import type { Config, Data, Layout } from 'plotly.js';

/** Identifies one plot for the x-link. Every panel needs its own key, including
 * the stacked panels inside a single card — a chart ignores its OWN echo, so
 * two panels sharing a key would never sync to each other. */
export type ChartKey = string;

/** Broadcasts an x-range and a hover position so the stacked charts behave as
 * one instrument: pan one and they all pan, hover one and every chart shows
 * where you are at that instant. Charts ignore their own echo, which is what
 * stops a two-chart feedback loop. */
class XAxisLink extends EventTarget {
  emit(source: ChartKey, range: [number, number] | null): void {
    this.dispatchEvent(new CustomEvent('range', { detail: { source, range } }));
  }
  subscribe(cb: (source: ChartKey, range: [number, number] | null) => void): () => void {
    const handler = (ev: Event): void => {
      const d = (ev as CustomEvent<{ source: ChartKey; range: [number, number] | null }>).detail;
      cb(d.source, d.range);
    };
    this.addEventListener('range', handler);
    return () => this.removeEventListener('range', handler);
  }
  emitHover(source: ChartKey, x: number | null): void {
    this.dispatchEvent(new CustomEvent('hover', { detail: { source, x } }));
  }
  subscribeHover(cb: (source: ChartKey, x: number | null) => void): () => void {
    const handler = (ev: Event): void => {
      const d = (ev as CustomEvent<{ source: ChartKey; x: number | null }>).detail;
      cb(d.source, d.x);
    };
    this.addEventListener('hover', handler);
    return () => this.removeEventListener('hover', handler);
  }
}

export const xAxisLink = new XAxisLink();

/** The synced crosshair drawn on charts the pointer is NOT over. The chart
 * under the pointer gets Plotly's own spike line and tooltip instead. */
function crosshairShape(x: number): Record<string, unknown> {
  return {
    type: 'line',
    xref: 'x',
    yref: 'paper',
    x0: x,
    x1: x,
    y0: 0,
    y1: 1,
    line: { color: '#94a3b8', width: 1, dash: 'dot' },
    layer: 'above',
  };
}

export interface PlotSnapshot {
  traces: Data[];
  /** Layout keys to merge on this frame (y-ranges, annotations, …). */
  layoutPatch?: Partial<Layout>;
  /** Monotonic revision. When unchanged and not following, the frame is skipped. */
  seq: number;
}

export interface UseAnalysisPlotOptions {
  key: ChartKey;
  baseLayout: Partial<Layout>;
  pull: () => PlotSnapshot;
  /** Live-follow: the x-axis tracks [now − windowSec, now]. */
  follow: () => boolean;
  windowSec: () => number;
  refreshHz?: number;
  /** Filename stem for the modebar's PNG export. */
  exportName?: string;
}

const DEFAULT_REFRESH_HZ = 10;

export function useAnalysisPlot(opts: UseAnalysisPlotOptions): React.RefObject<HTMLDivElement | null> {
  const divRef = useRef<HTMLDivElement | null>(null);
  // Latest options every render, read by the rAF loop, so the loop can be set
  // up once on mount without capturing stale closures.
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    const div = divRef.current;
    if (!div) {
      // This effect runs once on mount, so a ref that is null here is never
      // retried — the chart would sit blank forever while its readouts updated
      // beside it. Callers must render the plot div unconditionally and overlay
      // any empty state, rather than swapping the div out.
      console.error(
        `[respiration] plot "${opts.key}" has no container element on mount; ` +
          'render the plot div unconditionally and overlay the empty state instead.',
      );
      return;
    }

    const o = optsRef.current;
    let lastSeq = -1;
    let lastRangeKey = '';
    // Set while we are the one writing the axis, so our own relayout event
    // does not get rebroadcast as if the user had panned.
    let selfDriven = false;
    let externalRange: [number, number] | null = null;
    let hoverX: number | null = null;

    const config: Partial<Config> = {
      responsive: true,
      displaylogo: false,
      displayModeBar: true,
      scrollZoom: true,
      doubleClick: 'reset',
      modeBarButtonsToRemove: ['lasso2d', 'select2d', 'toggleSpikelines'],
      toImageButtonOptions: {
        format: 'png',
        filename: o.exportName ?? `narbis-${o.key}`,
        scale: 2,
      },
    };

    /* Plotly MUTATES the layout object it is handed — it writes back computed
     * values such as `autorange: true` and the default empty-axis range. A
     * shallow spread shares the nested axis objects, so those writes would land
     * in the caller's memoized baseLayout and then be re-applied on every
     * subsequent frame. Clone before every call so the base stays pristine. */
    const cloneLayout = (l: Partial<Layout>): Partial<Layout> =>
      JSON.parse(JSON.stringify(l)) as Partial<Layout>;

    /** The follow range for right now, so the axis is correct on the FIRST
     * paint rather than after the first animation frame — which matters when
     * the tab starts hidden and rAF is suspended. */
    const followRange = (): [number, number] | null => {
      const cur = optsRef.current;
      if (!cur.follow()) return null;
      const t1 = Date.now();
      return [t1 - cur.windowSec() * 1000, t1];
    };

    const initial = o.pull();
    const initialLayout = cloneLayout(o.baseLayout);
    const r0 = followRange();
    if (r0) {
      initialLayout.xaxis = { ...(initialLayout.xaxis ?? {}), range: r0, autorange: false };
    }
    void Plotly.newPlot(div, initial.traces, initialLayout, config);
    lastSeq = initial.seq;

    // Plotly attaches its own EventEmitter methods to the div at newPlot time;
    // the DOM lib does not know about them. Same cast the dashboard's plot hook uses.
    type PlotlyEventDiv = HTMLDivElement & {
      on: (event: string, cb: (data: unknown) => void) => void;
      removeAllListeners?: (event: string) => void;
    };
    const evDiv = div as PlotlyEventDiv;

    const onRelayout = (data: unknown): void => {
      if (selfDriven) return;
      const cur = optsRef.current;
      // A manual pan/zoom is only meaningful while paused; while following, the
      // next frame would overwrite it anyway.
      if (cur.follow()) return;
      const d = data as Record<string, unknown>;
      if (d['xaxis.autorange'] === true) {
        xAxisLink.emit(cur.key, null);
        return;
      }
      const lo = toMs(d['xaxis.range[0]']);
      const hi = toMs(d['xaxis.range[1]']);
      if (lo == null || hi == null) return;
      xAxisLink.emit(cur.key, [lo, hi]);
    };
    evDiv.on('plotly_relayout', onRelayout);

    const unsubscribe = xAxisLink.subscribe((source, range) => {
      if (source === optsRef.current.key) return;
      externalRange = range;
    });

    // Hover: broadcast where the pointer is, and draw a crosshair when another
    // chart is the one being hovered.
    const onHover = (data: unknown): void => {
      const pts = (data as { points?: Array<{ x?: unknown }> }).points;
      const x = pts && pts.length > 0 ? toMs(pts[0].x) : null;
      if (x == null) return;
      xAxisLink.emitHover(optsRef.current.key, x);
    };
    const onUnhover = (): void => xAxisLink.emitHover(optsRef.current.key, null);
    evDiv.on('plotly_hover', onHover);
    evDiv.on('plotly_unhover', onUnhover);
    const unsubscribeHover = xAxisLink.subscribeHover((source, x) => {
      hoverX = source === optsRef.current.key ? null : x;
    });

    let raf = 0;
    let lastFrame = 0;
    const loop = (now: number): void => {
      raf = requestAnimationFrame(loop);
      const cur = optsRef.current;
      const period = 1000 / (cur.refreshHz ?? DEFAULT_REFRESH_HZ);
      if (now - lastFrame < period) return;
      lastFrame = now;

      const snap = cur.pull();
      // Pristine copy of the caller's layout for this frame — see cloneLayout.
      const base = cloneLayout(cur.baseLayout);
      const follow = followRange();

      const layoutPatch: Partial<Layout> = { ...(snap.layoutPatch ?? {}) };
      let rangeKey = '';
      if (follow) {
        layoutPatch.xaxis = { ...(base.xaxis ?? {}), range: follow, autorange: false };
        rangeKey = `f:${Math.round(follow[0] / 100)}`;
        externalRange = null;
      } else if (externalRange) {
        layoutPatch.xaxis = {
          ...(base.xaxis ?? {}),
          range: externalRange,
          autorange: false,
        };
        rangeKey = `x:${externalRange[0]}:${externalRange[1]}`;
      }

      // The synced crosshair rides in the same layout patch as the range, so a
      // hover on a neighbouring chart repaints this one on the next frame.
      const baseShapes = (base as { shapes?: unknown[] }).shapes ?? [];
      if (hoverX != null) {
        layoutPatch.shapes = [...baseShapes, crosshairShape(hoverX)] as Layout['shapes'];
        rangeKey += `|h:${hoverX}`;
      } else {
        layoutPatch.shapes = baseShapes as Layout['shapes'];
      }

      const dataChanged = snap.seq !== lastSeq;
      const rangeChanged = rangeKey !== lastRangeKey;
      if (!dataChanged && !rangeChanged) return;
      lastSeq = snap.seq;
      lastRangeKey = rangeKey;

      selfDriven = true;
      if (dataChanged) {
        void Plotly.react(div, snap.traces, { ...base, ...layoutPatch }, config);
      } else {
        void Plotly.relayout(div, layoutPatch as Partial<Layout>);
      }
      // Release on the next macrotask: Plotly emits relayout synchronously for
      // relayout() but asynchronously after react().
      setTimeout(() => {
        selfDriven = false;
      }, 0);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      unsubscribe();
      unsubscribeHover();
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

/** Plotly hands back a number, an ISO-ish date string, or a Date depending on
 * the axis type and how the value was produced. */
function toMs(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}
