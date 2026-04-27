# Stage 11 — Dashboard: Charts and HRV metrics

## Task

Real-time visualization layer.

## Prerequisites

Stage 10 complete. Live data flowing.

## What to build

1. **`dashboard/src/components/SignalChart.tsx`** — raw PPG, 30-sec rolling window, one line per active channel, 30 Hz update, pause/resume button

2. **`dashboard/src/components/FilteredChart.tsx`** — post-filter signal from diagnostic stream, peaks marked, rejected peaks in different color

3. **`dashboard/src/components/BeatChart.tsx`** — IBI tachogram, 5-min rolling, earclip + H10 overlaid, artifacts in third color

4. **`dashboard/src/components/MetricsChart.tsx`** — HRV metrics over time: rMSSD, SDNN, mean HR, LF, HF, LF/HF, coherence — toggleable traces, 10-min rolling

5. **`dashboard/src/metrics/`** — HRV computation:
   - `timeDomain.ts` — `computeRMSSD(beats, windowSec)`, `computeSDNN`, `computePNN50`, `computeMeanHR`
   - `frequencyDomain.ts` — Lomb-Scargle PSD on irregular IBIs, `computeLFPower`, `computeHFPower`, `computeLFHFRatio`
   - `coherence.ts` — HeartMath-style (fixed band) and Lehrer/Vaschillo (individualized resonance)
   - `windowing.ts` — rolling window utilities

6. **`dashboard/src/workers/metricsWorker.ts`** — Web Worker for Lomb-Scargle / FFTs:
   - Recompute every second using latest 60 sec of beats
   - Post results to main thread
   - Don't block UI

7. **Synchronized panning/zooming**:
   - Plotly relayout events coordinate across charts
   - Hover crosshair on all charts at same time

8. **Update App.tsx** to use real chart components

## Implementation notes

- `Plotly.extendTraces()` for performance, not full re-renders
- Pull from streamBuffer at render time
- `requestAnimationFrame` for smooth updates
- Transfer typed arrays to Web Worker for efficiency

## Success criteria

- All charts render with live data
- Smooth updates without lag
- Synchronized panning works
- HRV metrics physiologically reasonable (rMSSD 20-80ms, LF/HF 0.5-3 at rest)
- Coherence rises during paced breathing at ~6 BPM
- H10 IBIs visible alongside earclip in BeatChart
- 60 fps with all charts active

## When done

Report frame rate, earclip-vs-H10 IBI agreement, coherence behavior during paced breathing.
