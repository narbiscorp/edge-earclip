# Stage 13 — Dashboard: Recording, export, replay

## Task

Session recording with multi-file CSV/JSON format. Replay through the same UI.

## Prerequisites

Stages 09-12 complete.

## What to build

1. **`dashboard/src/state/recording.ts`** — state machine: IDLE / PRE_RECORDING / RECORDING / FINALIZING / COMPLETE
   - Subscribe to all data streams during RECORDING
   - Per-stream buffers
   - Periodic flush to IndexedDB (every 10 sec)
   - Assemble final files at stop, package as zip

2. **`dashboard/src/recording/format.ts`** — file writers:
   - `writeRawSamplesCSV(samples)` — timestamp_ms, sample_index, red, ir, green, dc_red, dc_ir, led_red_ma, led_ir_ma, led_green_ma, saturation_flags
   - `writeBeatsCSV(beats)` — beat_timestamp_ms, ibi_ms, bpm, sqi, is_artifact, rejection_reason, detection_offset_ms, channel_used
   - `writeMetricsCSV(metrics)` — 1 Hz: timestamp_ms, window_seconds, beats_in_window, mean_hr_bpm, sdnn_ms, rmssd_ms, pnn50_pct, vlf/lf/hf_power, lf_hf_ratio, total_power, peak_freq_hz, peak_power, coherence_score, sqi_avg
   - `writeAnnotationsCSV(annotations)` — timestamp_ms, event_type, annotation_text, source
   - `writeConfigHistoryJSON(history)` — initial + change events
   - `writeManifestJSON(metadata, summaryStats)`
   - `writeReplayJSON(allEvents)` — time-ordered

3. **`dashboard/src/recording/manifest.ts`** — session metadata, summary stats at end

4. **`dashboard/src/recording/export.ts`** — JSZip bundling, browser download or File System Access API

5. **`dashboard/src/components/RecordingControls.tsx`**:
   - Pre-recording modal: session name, subject ID, notes, stream selection, format options
   - During recording: record indicator, elapsed time, annotation input (Enter drops marker), Mark moment button, byte count, Stop button
   - Post-recording: summary stats, Download button, Open in replay

6. **`dashboard/src/components/ReplayControls.tsx`**:
   - Load file (replay.json or session zip)
   - Play, pause, scrub, 1x/2x/5x/10x speed
   - Charts behave identically to live mode but data from file
   - Toggle between live and replay
   - Annotations as vertical markers on charts

7. **HRV metric recomputation in replay**:
   - On load, metrics_1hz.csv values shown as-is
   - "Recompute metrics" button — different window sizes
   - All beats in beats.csv → recompute from those

8. **H10 reference recording**:
   - When H10 connected during recording, separate buffers
   - Output goes into `reference_h10/` subdir of session zip
   - `comparison.csv` with time-aligned earclip-vs-H10 IBIs

## Recording session output

```
session_<timestamp>_<subject>/
├── manifest.json
├── raw_samples.csv
├── beats.csv
├── metrics_1hz.csv
├── annotations.csv
├── config_history.json
├── replay.json
├── reference_h10/  (if H10 was connected)
│   ├── h10_beats.csv
│   ├── h10_metrics_1hz.csv
│   └── h10_raw_ecg.csv  (if ECG mode used)
└── comparison.csv  (if H10 was connected)
```

## Success criteria

- 5-min session: all files generated correctly
- CSVs open cleanly in Excel and Pandas
- Manifest is valid JSON
- H10 comparison.csv shows sensible alignment when H10 connected
- Replay matches live experience
- Scrubbing works
- Recompute metrics with different windows produces different results
- 1-hour session doesn't crash browser

## When done

Report file sizes for typical sessions, any browser memory issues, replay accuracy.
