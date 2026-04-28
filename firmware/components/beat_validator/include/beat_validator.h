/*
 * beat_validator.h — IBI plausibility + continuity gating.
 *
 * Consumes elgendi_peak_t, emits beat_event_t (defined in narbis_protocol.h).
 * Never silently drops: failures set NARBIS_BEAT_FLAG_ARTIFACT and reduce
 * confidence, but the event is always emitted so downstream transports
 * (and the dashboard's recorder) see the full picture.
 */

#ifndef NARBIS_BEAT_VALIDATOR_H
#define NARBIS_BEAT_VALIDATOR_H

#include <stdint.h>

#include "esp_err.h"

#include "elgendi.h"
#include "narbis_protocol.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef void (*beat_validator_event_cb_t)(const beat_event_t *e, void *ctx);

esp_err_t beat_validator_init(void);
esp_err_t beat_validator_deinit(void);

esp_err_t beat_validator_register_event_cb(beat_validator_event_cb_t cb, void *ctx);

/* Synchronously process one peak. Called from elgendi stage. */
void beat_validator_feed(const elgendi_peak_t *p);

/* Apply runtime config (ibi_min_ms, ibi_max_ms, ibi_max_delta_pct,
 * sqi_threshold_x100). */
esp_err_t beat_validator_apply_config(const narbis_runtime_config_t *cfg);

#ifdef __cplusplus
}
#endif

#endif /* NARBIS_BEAT_VALIDATOR_H */
