#ifndef NARBIS_BLE_OTA_H
#define NARBIS_BLE_OTA_H

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

esp_err_t ble_ota_init(void);
esp_err_t ble_ota_deinit(void);

#ifdef __cplusplus
}
#endif

#endif /* NARBIS_BLE_OTA_H */
