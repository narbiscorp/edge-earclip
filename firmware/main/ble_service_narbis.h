#ifndef NARBIS_BLE_SERVICE_NARBIS_H
#define NARBIS_BLE_SERVICE_NARBIS_H

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

esp_err_t ble_service_narbis_init(void);
esp_err_t ble_service_narbis_deinit(void);

#ifdef __cplusplus
}
#endif

#endif /* NARBIS_BLE_SERVICE_NARBIS_H */
