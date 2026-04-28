#ifndef NARBIS_BLE_SERVICE_HRS_H
#define NARBIS_BLE_SERVICE_HRS_H

#include "esp_err.h"

#include "host/ble_gatt.h"

#include "narbis_protocol.h"

#ifdef __cplusplus
extern "C" {
#endif

esp_err_t ble_service_hrs_init(void);
esp_err_t ble_service_hrs_deinit(void);

const struct ble_gatt_svc_def *ble_service_hrs_svc_defs(void);
void ble_service_hrs_on_register(struct ble_gatt_register_ctxt *ctxt);

/* Push a beat into the HRS notification path. In LOW_LATENCY profile,
 * notifies immediately with one R-R interval. In BATCHED profile,
 * accumulates R-R intervals and flushes when the buffer is full or when
 * ble_service_hrs_flush() is called from the batch timer. */
void ble_service_hrs_push_beat(const beat_event_t *beat);

/* Flush any pending batched R-R intervals. */
void ble_service_hrs_flush(void);

/* Switch profile (BATCHED or LOW_LATENCY). Flushes pending batch if
 * dropping into LOW_LATENCY. */
void ble_service_hrs_set_profile(uint8_t ble_profile);

#ifdef __cplusplus
}
#endif

#endif /* NARBIS_BLE_SERVICE_HRS_H */
