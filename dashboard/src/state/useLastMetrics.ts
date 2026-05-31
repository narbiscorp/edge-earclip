import { useEffect, useState } from 'react';
import { metricsRunner, type MetricsUpdatedDetail } from './metricsRunner';
import type { MetricsSnapshot } from './metricsBuffer';

/** Subscribes to metricsRunner's `metricsUpdated` event and returns the
 * latest MetricsSnapshot. Returns null until the worker has produced its
 * first result (needs ~4 IBIs in the window before it'll dispatch). Used
 * by Basic mode to surface RMSSD without having to poll the buffer. */
export function useLastMetrics(): MetricsSnapshot | null {
  const [snap, setSnap] = useState<MetricsSnapshot | null>(null);

  useEffect(() => {
    const onUpdate = (ev: Event) => {
      const detail = (ev as CustomEvent<MetricsUpdatedDetail>).detail;
      setSnap(detail.snapshot);
    };
    metricsRunner.addEventListener('metricsUpdated', onUpdate);
    return () => metricsRunner.removeEventListener('metricsUpdated', onUpdate);
  }, []);

  return snap;
}
