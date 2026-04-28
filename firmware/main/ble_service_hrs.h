#ifndef NARBIS_BLE_SERVICE_HRS_H
#define NARBIS_BLE_SERVICE_HRS_H

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

esp_err_t ble_service_hrs_init(void);
esp_err_t ble_service_hrs_deinit(void);

#ifdef __cplusplus
}
#endif

#endif /* NARBIS_BLE_SERVICE_HRS_H */
