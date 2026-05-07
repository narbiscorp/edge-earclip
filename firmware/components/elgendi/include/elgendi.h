/*
 * elgendi.h — bandpass filter + Elgendi systolic peak detection.
 *
 * Pipeline:
 *   processed sample → cascaded biquads (BP) → square → MA(W1)/MA(W2)
 *                    → block detection → local max → peak event
 *
 * Outputs `elgendi_peak_t` to a registered consumer (beat_validator).
 * Refractory period is taken from narbis_runtime_config_t.ibi_min_ms,
 * which doubles as the validator's IBI floor.
 */

#ifndef NARBIS_ELGENDI_H
#define NARBIS_ELGENDI_H

#include <stdint.h>

#include "esp_err.h"

#include "narbis_protocol.h"
#include "ppg_channel.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    uint32_t timestamp_ms;   /* peak time (from processed sample) */
    uint32_t sample_index;   /* index from start of session */
    int32_t  amplitude;      /* filtered-signal value at peak */
} elgendi_peak_t;

/* Per-sample bandpass output. Emitted at the same rate as samples enter
 * elgendi_feed. Used to drive the dashboard's "filtered signal" stream
 * via the diagnostics pipe. */
typedef struct {
    uint32_t timestamp_ms;
    int32_t  filtered;       /* post-bandpass value (same units as ac) */
} elgendi_filtered_sample_t;

typedef void (*elgendi_peak_cb_t)(const elgendi_peak_t *p, void *ctx);
typedef void (*elgendi_filtered_cb_t)(const elgendi_filtered_sample_t *s, void *ctx);

esp_err_t elgendi_init(void);
esp_err_t elgendi_deinit(void);

esp_err_t elgendi_register_peak_cb(elgendi_peak_cb_t cb, void *ctx);
/* Optional. When set, called for every sample after the bandpass step.
 * Skipped while the filter is still settling (first ~W2 samples). */
esp_err_t elgendi_register_filtered_cb(elgendi_filtered_cb_t cb, void *ctx);

/* Synchronously process one processed sample. Called from channel stage. */
void elgendi_feed(const ppg_processed_sample_t *s);

/* Apply runtime config (cutoffs, MA windows, beta, refractory). Recomputes
 * Q28 biquad coefficients via float math and atomically swaps the active
 * coefficient set. Resets filter + MA state. */
esp_err_t elgendi_apply_config(const narbis_runtime_config_t *cfg);

/* Drop biquad state, MA sums, block tracking, last-peak time. */
void elgendi_reset_state(void);

/* Live-tune the threshold offset (β / α). Used by the adaptive detector to
 * bump α up on rejection and decay it back on success. Clamped to the
 * config-supplied [alpha_min_x1000, alpha_max_x1000] window inside the
 * adaptive component before this is called, so this just stores the value
 * atomically into the per-sample threshold computation. */
void elgendi_set_beta_x1000(uint16_t v);

/* Override the refractory floor with an externally-computed value (ms).
 * When non-zero, this takes precedence over ibi_min_ms and the internal
 * refractory_ibi_pct × last_ibi computation — used by the adaptive detector
 * to drive refractory off the Kalman IBI estimate (which is smoother than
 * elgendi's per-block last_ibi). Pass 0 to fall back to the internal logic.
 *
 * In FIXED mode the adaptive_detector never calls this, so elgendi's local
 * refractory_ibi_pct tracking still applies and the new Tier-1 auto-knob
 * works without the adaptive layer.  */
void elgendi_set_dynamic_refractory_ms(uint32_t ms);

#ifdef __cplusplus
}
#endif

#endif /* NARBIS_ELGENDI_H */
