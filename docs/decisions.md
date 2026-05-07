# Architectural decisions

Living log of design decisions that aren't obvious from the code. New
entries go on top.

---

## 2026-05-07 — Adaptive detector: Path C, earclip-only

**Decision.** Port the dashboard's v13.27 learning beat detector (online
NCC template matching + 1-D Kalman on IBI + self-tuning α + state
watchdog) into the earclip firmware as a new component
`firmware/components/adaptive_detector/`. Gated behind a runtime config
flag `detector_mode` (0=FIXED, 1=ADAPTIVE), default FIXED. Bumps
`config_version` to 4.

**Why earclip, not Edge.**

- Edge does **not** subscribe to RAW_PPG (Path B explicit decision in
  [`narbis_ble_central.c`](../EDGE/EDGE%20FIRMWARE/components/narbis_ble_central/narbis_ble_central.c) — "wastes air time + power for a stream the
  glasses do not use"). NCC matched-filter requires the waveform, so Edge
  cannot host the full detector without subscribing to RAW_PPG. That
  reverses Path B and adds 4–8 KB/s of BLE traffic.
- Edge CPU is already saturated by the lens / strobe / breathing / OTA
  stack and the coherence FFT (see [`main.c`](../EDGE/EDGE%20FIRMWARE/main/main.c) ~6100 LOC).
- Putting the detector on the earclip means **every consumer** (dashboard
  + Edge) gets the cleaner IBI stream automatically, with no Edge code
  changes. The ground-truth IBI source stays where the raw signal lives.

**Numerics on earclip.** The per-sample hot path (bandpass / square /
moving averages / threshold) stays fixed-point — unchanged. The
candidate-rate path (NCC + z-score + Kalman, runs ≤1 Hz when a peak
proposal arrives plus a half-window of look-ahead later) uses the
ESP32-C6 hardware FPU. CLAUDE.md's "no float in firmware hot path" rule
applies to the per-sample loop; the candidate path runs in the same task
that drains the FIFO, never in an ISR, and is bounded to ~1 Hz, so float
is acceptable there.

**Latency.** Adaptive detection adds `template_window_ms / 2` of
look-ahead between physiological event and BLE notify. At the default
`template_window_ms=200` and `sample_rate_hz=200`, that's 100 ms — well
inside the <300 ms target.

**Validation plan.** See plan in
`.claude/plans/c-users-dgrec-downloads-index-11-html-a-temporal-seal.md`
section "Verification". Acceptance is FIXED→ADAPTIVE comparison vs Polar
H10 reference for ±10 ms RMSE at rest and ≥30% artifact-rate reduction
during deliberate motion.

## 2026-05-07 — Adaptive detector: Tier-2 auto-knobs deferred

The "Layer E" auto-adjusting knobs split into Tier-1 (shipped now) and
Tier-2 (follow-up). This entry exists so Tier-2 ideas don't get lost.

**Tier 1 — shipped this PR:**

1. **Adaptive Kalman R** — closed-loop measurement-noise estimation
   tracked over a 16-beat ring. R bumps ×1.5 when rejection rate >25%,
   decays toward baseline ×0.95/beat when <5%. Capped at 10000 ms². Lives
   in [`adaptive_detector.c`](../firmware/components/adaptive_detector/adaptive_detector.c) (`update_kalman_R_adaptive`).

2. **AGC step-size auto-scaling** — gated by `agc_adaptive_step`. The AGC
   step (`agc_step_ma_x10`) is multiplied by `clamp(|dc - center| /
   center, 1×, 4×)` so big DC excursions converge fast and small drifts
   don't oscillate. Lives in [`ppg_channel.c`](../firmware/components/ppg_channel/ppg_channel.c) (`compute_agc_step_x10`).

3. **Adaptive refractory period** — runtime-config field
   `refractory_ibi_pct` (default 60). Refractory = `max(ibi_min_ms, pct ×
   last_IBI / 100)`. Works in **both FIXED and ADAPTIVE** modes via
   elgendi's local `last_ibi_ms` tracker, with adaptive_detector
   optionally overriding via `elgendi_set_dynamic_refractory_ms()` when
   it has a Kalman estimate. Lives in [`elgendi.c`](../firmware/components/elgendi/elgendi.c) refractory check.

**Tier 2 — follow-up PRs.** Out of scope for this PR; documented so we
don't forget:

4. **Adaptive bandpass low cutoff.** Track rolling variance of the post-DC
   signal in the 0.1–0.5 Hz band. When motion-drift variance crosses an
   EWMA threshold, raise `bandpass_low_hz` from 0.5 → 0.8 Hz. Restore on
   calm. Requires storing two biquad coefficient sets (or recomputing on
   the fly) and atomic swap into the per-sample fixed-point biquad.

5. **MA window auto-scaling with HR.** `W1=111 ms` and `W2=667 ms` are
   fixed; optimal `W2 ≈ 1×IBI`. At 120 BPM (500 ms IBI), 667 ms is too
   long. Scale `W1=0.15×IBI`, `W2=0.7×IBI`, bounded by Kconfig caps
   (W2 ≤ 320 samples). Resize ring buffers at config-apply boundaries,
   not mid-stream.

6. **Channel auto-select (red vs IR).** [`ppg_channel.c`](../firmware/components/ppg_channel/ppg_channel.c) currently
   hardcodes `k_active = PPG_ACTIVE_IR` (TODO note already at line 42).
   Track AC RMS / DC ratio per channel, prefer the higher SNR. Hot-swap
   invalidates the matched-filter template — needs a re-warmup signal.

7. **Skin-contact watchdog.** When DC < 5000 counts for >2 s, declare
   NO_CONTACT, drop LED current to minimum, pause detection, emit a
   state event. Saves ~5 mA off-ear. Already partly observable via AGC
   saturation; making it first-class simplifies dashboard UX.
