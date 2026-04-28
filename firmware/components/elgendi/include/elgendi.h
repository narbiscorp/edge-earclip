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

typedef void (*elgendi_peak_cb_t)(const elgendi_peak_t *p, void *ctx);

esp_err_t elgendi_init(void);
esp_err_t elgendi_deinit(void);

esp_err_t elgendi_register_peak_cb(elgendi_peak_cb_t cb, void *ctx);

/* Synchronously process one processed sample. Called from channel stage. */
void elgendi_feed(const ppg_processed_sample_t *s);

/* Apply runtime config (cutoffs, MA windows, beta, refractory). Recomputes
 * Q28 biquad coefficients via float math and atomically swaps the active
 * coefficient set. Resets filter + MA state. */
esp_err_t elgendi_apply_config(const narbis_runtime_config_t *cfg);

/* Drop biquad state, MA sums, block tracking, last-peak time. */
void elgendi_reset_state(void);

#ifdef __cplusplus
}
#endif

#endif /* NARBIS_ELGENDI_H */
