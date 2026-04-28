#ifndef NARBIS_DIAGNOSTICS_H
#define NARBIS_DIAGNOSTICS_H

#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Single ring buffer behind a per-stream bitmask gate. Producers call
 * diagnostics_push() from any context (drained off-thread). A consumer
 * task batches records and emits them via NARBIS_CHR_DIAGNOSTICS BLE
 * notifications when subscribed. Disabled streams (mask bit clear) cost
 * a single load + branch per producer call.
 *
 * Stream IDs are NARBIS_DIAG_STREAM_* from narbis_protocol.h. */

esp_err_t diagnostics_init(void);
esp_err_t diagnostics_deinit(void);

/* Update the active stream mask. Called by config_apply on
 * diagnostics_enabled / diagnostics_mask changes. */
void diagnostics_set_mask(uint8_t mask);

/* Enqueue a record. Drops on backpressure (no blocking). stream_id is
 * the raw bit, not the bit position. */
void diagnostics_push(uint8_t stream_id, const void *payload, size_t len);

#ifdef __cplusplus
}
#endif

#endif /* NARBIS_DIAGNOSTICS_H */
