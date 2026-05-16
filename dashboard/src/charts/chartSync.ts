export type ChartId = 'signal' | 'filtered' | 'beat' | 'metrics' | 'filteredbeat' | 'coherence';

export interface TimeRangeEvent {
  source: ChartId;
  range: [number, number] | null;
}

export interface HoverEvent {
  source: ChartId;
  x_ms: number | null;
}

class ChartSync extends EventTarget {
  emitTimeRange(source: ChartId, range: [number, number] | null): void {
    this.dispatchEvent(new CustomEvent<TimeRangeEvent>('timeRange', { detail: { source, range } }));
  }

  emitHover(source: ChartId, x_ms: number | null): void {
    this.dispatchEvent(new CustomEvent<HoverEvent>('hover', { detail: { source, x_ms } }));
  }

  onTimeRange(cb: (ev: TimeRangeEvent) => void): () => void {
    const h = (e: Event): void => cb((e as CustomEvent<TimeRangeEvent>).detail);
    this.addEventListener('timeRange', h);
    return () => this.removeEventListener('timeRange', h);
  }

  onHover(cb: (ev: HoverEvent) => void): () => void {
    const h = (e: Event): void => cb((e as CustomEvent<HoverEvent>).detail);
    this.addEventListener('hover', h);
    return () => this.removeEventListener('hover', h);
  }
}

export const chartSync = new ChartSync();
