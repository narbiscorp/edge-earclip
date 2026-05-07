/*
 * adaptive_detector.h — learning beat detector that wraps Elgendi.
 *
 * Layers (matches Narbis Edge HRV Dashboard v13.27):
 *   A. Online matched-filter template (NCC) — z-scored mean of last N beats.
 *   B. 1-D Kalman filter on IBI — rejects 3σ outliers; closed-loop R update.
 *   C. Self-tuning α offset — bumps elgendi_beta_x1000 on noise / decays on success.
 *   D. Watchdog — full state reset on consecutive rejects or active-signal silence.
 *
 * Mode switch is via narbis_runtime_config_t.detector_mode. In FIXED mode
 * the module is a transparent passthrough — propose→peak_cb directly, no
 * look-ahead delay. In ADAPTIVE mode it queues the candidate, waits HALF
 * window samples for the post-peak data, runs the gates, and only then
 * forwards accepted peaks to the registered cb (= beat_validator_feed).
 *
 * Data flow (in main.c):
 *   on_filtered → adaptive_detector_feed_sample
 *   on_peak     → adaptive_detector_propose_peak
 *                 (registered cb, e.g. on_accepted_peak) → beat_validator_feed
 */

#ifndef NARBIS_ADAPTIVE_DETECTOR_H
#define NARBIS_ADAPTIVE_DETECTOR_H

#include <stdint.h>

#include "esp_err.h"

#include "elgendi.h"
#include "narbis_protocol.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    uint32_t beats_learned;
    uint32_t ncc_rejects;
    uint32_t kalman_rejects;
    uint32_t watchdog_resets;
    int16_t  ncc_x1000;          /* last NCC ×1000 (signed: NCC ∈ [-1, 1]) */
    uint16_t alpha_x1000;        /* current α ×1000 (mirror of elgendi.beta) */
    uint16_t kalman_x_ms;        /* Kalman estimate of current IBI, ms */
    uint16_t kalman_r_ms2;       /* current measurement-noise variance */
    uint8_t  beats_in_template;  /* 0..template_max_beats */
    uint8_t  mode;               /* narbis_detector_mode_t */
} adaptive_detector_stats_t;

typedef void (*adaptive_detector_peak_cb_t)(const elgendi_peak_t *p, void *ctx);

esp_err_t adaptive_detector_init(void);
esp_err_t adaptive_detector_deinit(void);

/* Apply runtime config — repointers the mode + tuning fields. Idempotent. */
esp_err_t adaptive_detector_apply_config(const narbis_runtime_config_t *cfg);

/* Register the downstream peak consumer. Called for every ACCEPTED peak.
 * Wire this to beat_validator_feed (via a small main.c shim). */
esp_err_t adaptive_detector_register_peak_cb(adaptive_detector_peak_cb_t cb, void *ctx);

/* Per-sample feed of the bandpass-filtered signal. Cheap (push to ring +
 * watchdog tick + maybe one pending evaluation). Safe to call from the
 * elgendi filtered_cb in the PPG processing task. */
void adaptive_detector_feed_sample(uint32_t timestamp_ms, int32_t filtered);

/* Candidate peak from the elgendi block detector. In ADAPTIVE mode this
 * is queued and evaluated HALF samples later. In FIXED mode it forwards
 * to the registered peak_cb immediately. */
void adaptive_detector_propose_peak(const elgendi_peak_t *p);

/* Snapshot stats (for BLE diagnostics). Lock-free read of the latest values. */
void adaptive_detector_get_stats(adaptive_detector_stats_t *out);

/* Drop all learned state (template, Kalman, watchdog counters). Public
 * because the watchdog uses it internally and config-apply may want to
 * force a clean slate. */
void adaptive_detector_reset(void);

#ifdef __cplusplus
}
#endif

#endif /* NARBIS_ADAPTIVE_DETECTOR_H */
