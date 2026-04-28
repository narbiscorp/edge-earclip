#ifndef NARBIS_BLE_SERVICE_NARBIS_H
#define NARBIS_BLE_SERVICE_NARBIS_H

#include <stdint.h>

#include "esp_err.h"

#include "host/ble_gatt.h"

#include "narbis_protocol.h"
#include "ppg_driver_max3010x.h"

#ifdef __cplusplus
extern "C" {
#endif

esp_err_t ble_service_narbis_init(void);
esp_err_t ble_service_narbis_deinit(void);

const struct ble_gatt_svc_def *ble_service_narbis_svc_defs(void);
void ble_service_narbis_on_register(struct ble_gatt_register_ctxt *ctxt);

/* Pointer to the in-memory runtime config snapshot. main.c initialises this
 * to defaults; the CONFIG_WRITE access path mutates it via apply_config(). */
narbis_runtime_config_t *ble_service_narbis_config(void);

/* Notify the IBI characteristic for the given beat (subscription/profile-gated). */
esp_err_t ble_service_narbis_push_ibi(const beat_event_t *beat);

/* Accumulate one raw sample. Flushes a notify when 29 samples have built
 * up or when the data_format / subscription state requires immediate
 * emission. */
esp_err_t ble_service_narbis_push_raw(const ppg_sample_t *sample,
                                      uint16_t sample_rate_hz);

/* Notify the SQI characteristic. */
esp_err_t ble_service_narbis_push_sqi(const narbis_sqi_payload_t *sqi);

/* Notify the custom rich-battery characteristic. */
esp_err_t ble_service_narbis_push_battery(uint8_t soc_pct, uint16_t mv, uint8_t charging);

/* Re-emit the current config snapshot to subscribed clients. */
esp_err_t ble_service_narbis_notify_config(void);

#ifdef __cplusplus
}
#endif

#endif /* NARBIS_BLE_SERVICE_NARBIS_H */
