#ifndef NARBIS_BLE_SERVICE_BATTERY_H
#define NARBIS_BLE_SERVICE_BATTERY_H

#include <stdint.h>

#include "esp_err.h"

#include "host/ble_gatt.h"

#ifdef __cplusplus
extern "C" {
#endif

esp_err_t ble_service_battery_init(void);
esp_err_t ble_service_battery_deinit(void);

const struct ble_gatt_svc_def *ble_service_battery_svc_defs(void);
void ble_service_battery_on_register(struct ble_gatt_register_ctxt *ctxt);

/* Cache and notify the battery state. Caches the latest values for new
 * subscribers' read requests and emits a notify on the standard 0x2A19
 * (1 byte SoC%) — the custom Narbis-side battery characteristic is owned
 * by ble_service_narbis. */
void ble_service_battery_push(uint8_t soc_pct, uint16_t mv, uint8_t charging);

/* Last known SoC percentage (0..100). For internal use by reads. */
uint8_t ble_service_battery_get_soc(void);

#ifdef __cplusplus
}
#endif

#endif /* NARBIS_BLE_SERVICE_BATTERY_H */
