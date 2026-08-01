# Respiration Analysis

A bench tool for looking at breathing through the cardiovascular signal: heart
rate, HRV and coherence over time, the raw tachogram they are derived from, and
every axis of the Polar H10 chest accelerometer — which is the only *direct*
measurement of the breath in the stack.

Published at `respiration.html`, linked from the dev hub.

```
https://narbiscorp.github.io/edge-earclip/respiration.html
https://narbiscorp.github.io/edge-earclip/respiration.html?demo=1   # no hardware
```

## Why it lives inside `dashboard/`

It is a second Vite entry in the dashboard project, not a standalone static app
like `functest/`. That is deliberate: the whole point of the coherence trace is
that it is **the engine's real output**, so this page imports
`engine/coherenceEngine`, `workers/metricsWorker` and `ble/polarH10` directly.
A separate app would have needed its own copy of each, and copies drift.

Nothing outside `src/respiration/` was modified to add it. The build emits both
pages; the deploy step already copies all of `dashboard/dist/`, so no workflow
change was needed.

## What it shows

**Heart rate, HRV & coherence** — four stacked panels sharing one x-axis:

| Panel | Series | Unit |
|---|---|---|
| Heart rate | mean HR | bpm |
| HRV | RMSSD, SDNN | ms |
| Coherence | engine, firmware port, HeartMath, resonance, breath–heart γ² | 0–100 |
| Respiration rate | from HRV (Lomb-Scargle peak), from ACC | br/min |

Stacked rather than overlaid because the units differ. A dual-axis plot pins two
scales against each other arbitrarily and invents a correlation that is not in
the data; separate panels with a shared time axis show the same alignment
without the lie.

The four coherence definitions are deliberately side by side. "Engine" is the
app-side `CoherenceEngine` running in Mode A — the same number that drives the
glasses lens elsewhere in the product. The others are computed over the same
beats so they can be compared against it.

**Inter-beat intervals** — the tachogram everything above is derived from, per
source, with rejected beats marked rather than hidden.

**Polar H10 accelerometer** — X, Y, Z and the vector magnitude, one panel per
axis.

Isolated rather than overlaid, because on a chest strap they cannot share a
scale: gravity pins whichever axis points down near +/-1000 mG while the
breathing excursion is a few mG on top of it. Auto-gain does two things per
channel — subtracts the slow baseline (gravity, posture drift), then lets the
panel autorange to what is left — so a 3 mG breath fills the panel whichever way
the strap is facing. Set a fixed +/- range instead when you need the channels to
be comparable to each other. Both are display transforms; the readout beside each
label is always the true absolute value and the CSV always holds raw samples.

**Polar H10 accelerometer, lower strap** — an optional second H10 worn further
down the torso, logged and plotted for its accelerometer only.

Its heart-rate notifications are ignored: mixing a second RR source into the HRV
analysis would corrupt it silently. Both straps share the axis selection,
baseline, gain and filter settings, because the point of the second one is
comparing it against the first and that only means anything if they are shaped
identically. Exports as `acc_lower_samples.csv`.

**ECG** — the raw Polar H10 lead, 130 Hz, signed microvolts, unfiltered.

Off by default: it is 130 Hz of data that respiration work does not need and it
costs strap battery, so it is opt-in rather than something you find draining the
H10. Polar's own R-peak detector runs on this signal to produce the RR intervals
in the tachogram, so it is where to look when a beat there seems wrong. It shares
the H10's PMD service with the accelerometer — both can stream at once, though
the strap may narrow the settings it offers for the second one.

## Controls

Above all three charts (one row, scopes everything):

- **View window** — how much time is on screen.
- **Playback** — Live follows the clock; Paused unlocks pan, zoom, box-select
  and PNG export on every chart. Recording continues either way.
- **Analysis window** — seconds of beats each 1 Hz metric is computed over.
  Note the Coherence Engine and the firmware-port coherence each keep their own
  fixed 64 s window, so this setting only moves the time-domain and
  Lomb-Scargle metrics.
- **Source** — which device feeds the HRV metrics and the engine. Both are
  always logged regardless.

Per chart (conditions how that signal is drawn, never what is recorded):

- **Filter** — none, moving average, median, Savitzky–Golay, or a zero-phase
  EWMA. Median is the one that removes an ectopic beat outright; Savitzky–Golay
  is the one that preserves peak height.
- **Baseline** — subtracts a slow centred moving average, which is the auto-gain
  half of "make the small movements visible". Zero-phase, so nothing shifts in
  time. Defaults to 12 s on the accelerometer, off on ECG.
- **Spline resample** — monotone cubic (PCHIP) onto a uniform grid. Chosen over
  a plain cubic spline because it cannot overshoot: a ringing spline through a
  tachogram invents RR values below the shortest measured beat, and those feed
  straight into RMSSD.
- **Line** — Plotly's rendering shape. `spline` curves the drawing only.
- **Max points** — drawing budget, reduced with largest-triangle-three-buckets
  so peaks survive.

## Recording and export

Logging is **continuous** from the moment a device connects — there is no record
button to forget. Exports are always the raw log; display filters never touch
them.

| File | One row per |
|---|---|
| `metrics_1hz.csv` | 1 Hz analysis row (27 columns) |
| `beats.csv` | heartbeat, both devices, chronological, rejected ones flagged |
| `acc_samples.csv` | accelerometer sample, with magnitude |
| `acc_lower_samples.csv` | lower-strap accelerometer sample (only when worn) |
| `ecg_samples.csv` | ECG sample in microvolts (only when ECG was streamed) |
| `manifest.json` | session — devices, counts, settings, build id |

Every CSV carries both an absolute epoch timestamp and a session-relative
seconds column. A metric that could not be computed is written as an **empty
cell, never 0** — a column of zeros is indistinguishable from a real
measurement once it is in a file.

## Demo mode

`?demo=1` generates a synthetic H10: resting heart rate with respiratory sinus
arrhythmia at 6 br/min, a Mayer-wave component, periodic ectopic beats, and a
chest accelerometer carrying gravity plus the breathing excursion, and a
synthetic ECG whose R peaks come off the same beat clock as the RR intervals (so
a misalignment between the waveform and the beat stream shows up as a bug rather
than hiding in noise). It dispatches
on the **real** `PolarH10` event surface, so the log, the worker, the engine and
the exports all run exactly as they do with hardware.

It is seeded, so two runs look the same. A banner is shown, and the export
manifest is stamped `synthetic: true` — synthetic data must never be mistaken
for a measurement of a person.

## Polar PMD notes

ECG and the accelerometer share one PMD service, control point and data
characteristic. Frames are told apart by the measurement type in byte 0; the
subscription is set up once and released only when the last stream stops; and
control-point exchanges are serialised, because there is a single response slot
and two possible callers.

The settings response is
`[0xF0][opcode][measType][status][moreFrames][ TLVs... ]` — the TLVs start at
offset **5**. Parsing from 4 swallows the more-frames byte, yields an empty
rate list, and every start command then silently falls back to its preferred
values. That is survivable for ACC (50 Hz / +-8 g / 16-bit is valid) which is
why it hid for a long time, and fatal for ECG, where the device answers
`INVALID_PARAMETER`. `src/ble/__tests__/pmd.test.ts` pins the layout.

Some H10s also refuse ECG while the accelerometer is streaming. The app retries
once with ACC paused and says so in the event log, restoring ACC when ECG stops.

## Notes

- `← Dev hub` points at `./index.html`. On the deployed site that is the hub
  (the deploy step renames the dashboard to `app.html`). Running `npm run dev`
  locally it lands on the dashboard instead.
- Web Bluetooth only: Chrome, Edge, Brave on desktop or Android. Not Firefox,
  not iOS Safari.
- Beats outside 300–2000 ms are flagged and excluded from the analysis window,
  never dropped from the log.

## Tests

```bash
npm test -- src/respiration
```

`dsp.test.ts` holds the property tests that matter: Savitzky–Golay must
reproduce a polynomial of its own order exactly (the edge handling fits the
edge window rather than padding, because mirror-padding bends a trend), and
PCHIP must never leave the range of its input.
