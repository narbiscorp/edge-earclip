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

**Diaphragmatic activation** — chest against abdomen, from the two straps.

Both streams are band-passed into the respiratory band (12 s baseline removal
for the high-pass, a 2 s centred average for the low-pass), put on ONE common
20 Hz grid, and compared:

| Output | Meaning |
|---|---|
| Ratio R | normalised abdominal / thoracic peak-to-peak. >= 1.5 diaphragmatic, < 0.7 thoracic |
| Phase dPhi | lag between the straps over one breath. <= 45 normal, > 135 paradoxical |
| Differential | abdomen minus chest — common-mode rejection for posture and chair movement |

Three details that are easy to get wrong and are the reason this has its own
test file:

- **One common grid.** The straps have independent clocks and their frames
  arrive at different instants. Cross-correlating raw samples measures the gap
  between two BLE streams, not between two parts of a torso.
- **The low-pass is not optional.** High-pass alone leaves the ~1 Hz cardiac
  ballistogram, which is a similar size to a shallow breath. It inflates
  peak-to-peak, and inflates the smaller stream proportionally more, so a
  genuinely belly-dominant pattern reads as merely balanced.
- **The period estimator declines rather than guesses.** A biased
  autocorrelation decays with lag; in a short window that decay outruns the real
  peak and the maximum lands on the shortest lag searched, so the estimator
  returns its own lower bound. That produced a 2 s "breath period" from a 10 s
  breath and a false paradoxical warning. It now uses unbiased normalisation,
  searches no further than half the window, requires a genuine local maximum,
  and takes the EARLIEST strong peak so a harmonic cannot halve the rate.

Calibration is a 10-second two-deep-breath capture whose per-strap peak-to-peak
becomes the scale factor, so the ratio reflects effort rather than how much
tissue each strap sits on.

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

## Posture alignment and the guided learning sequence

Checked and shown BEFORE any classification, because an accelerometer axis is a
direction in the STRAP's frame, not the body's. If two straps are rotated
differently, the same axis points different ways on each and the chest wall's
motion projects onto it with different sign — a phase comparison then measures
how the straps were put on. A real recording where they sat 23 deg apart
produced a PARADOXICAL warning from a subject breathing normally; on the axis
where the straps agreed to within 1 mG, the same recording correlated at 0.95
with zero lag.

Gravity is the one direction both straps measure independently, so it is the
reference they get checked against:

- **Straps misaligned** — the angle between the two gravity vectors exceeds
  15 deg. The classification is shown muted and marked PROVISIONAL.
- **Posture drifted** — either strap has tilted more than 12 deg from the
  calibrated upright reference.
- **Aligned** — straps agree with each other and with the reference.

**Guided calibration** (90 s, six steps): sit upright, then demonstrate chest,
diaphragmatic and belly breathing, then sit slouched and sit back. Upright comes
first so all three breathing demonstrations share one posture, which is what
makes their ratios comparable; the disturbed postures come last.

What it buys:

- **Per-subject thresholds.** The spec's fixed 0.7 / 1.5 are population guesses
  applied to a ratio that depends on strap tightness and body shape — the same
  person can cross a threshold by refastening a strap. (Measured: the same
  strap moved 13 deg between two sessions minutes apart.) Boundaries are instead
  the geometric mean between consecutive demonstrations, i.e. the midpoint in
  log space, which is the neutral choice for a ratio. If the demonstrations come
  out too alike, it says so and keeps the defaults rather than inventing a
  personal boundary from two identical measurements.
- **Nearest-signature classification.** "Closest to your belly demonstration",
  with a confidence from the gap to the runner-up.
- **Posture recognition.** Reports whether you are currently sitting upright,
  slouched or back, using both straps — one alone cannot tell leaning back from
  sliding down.

## Why the plots stay smooth

`useAnalysisPlot` takes a cheap `seq()` and an expensive `pull()`, and only
calls `pull()` when `seq()` changes.

That split is the whole performance story. Building one accelerometer trace
means extracting the window, removing a 12 s baseline and decimating — measured
at 1.6 ms for a 5-minute window at 50 Hz, 2.6 ms at 100 Hz. Six panels (three
axes x two straps) is ~10-15 ms. Doing that on every animation frame, and only
then checking whether the data had changed, consumed the entire frame budget
before Plotly drew anything: the accelerometer looked like it updated at 1 Hz
when it was in fact redrawing constantly with no time left to do it in.

Now that cost is paid only when a frame of data actually arrives. Between
arrivals the loop does a cheap `relayout` to slide the axis, so the trace scrolls
continuously at the panel's refresh rate.

The other half is how often data arrives at all, which is a property of the
strap: the H10 fills each notification to the MTU, so 200 Hz sends frames four
times as often as 50 Hz. The rate selector on the accelerometer card requests
25/50/100/200 Hz (default 100); it is about frame cadence, not about resolving
faster breathing, since respiration is below 0.5 Hz either way.

Filter windows are specified in SECONDS, not samples, so the same setting means
the same smoothing at any rate.

## Deviations from the dual-strap spec

- **Default sample rate is 100 Hz, selectable 25-200 Hz.** The spec asks for
  200 Hz; Respiration lives below 0.5 Hz, so
  50 Hz is 50x Nyquist and already far more than the analysis needs. Raising the
  driver's preferred ACC rate would also change it for the main dashboard's
  Mode B, which is a bigger blast radius than the benefit justifies.
- **Waveform colours are not the spec's cyan/green.** That pair measures
  ΔE 12.5 for normal vision (below the 15 floor) and 3.4 under tritan
  simulation — unusable where colour is the only thing separating the chest
  trace from the abdomen trace. The chart uses validated categorical slots; the
  spec's four colours are kept for the classification badge, where a text label
  always accompanies them.
- **Role assignment is one "Sternum strap" selector**, not two dropdowns. There
  are only two straps, so naming one names the other.

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
