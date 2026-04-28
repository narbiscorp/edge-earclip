#ifndef NARBIS_TRANSPORT_BLE_H
#define NARBIS_TRANSPORT_BLE_H

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

esp_err_t transport_ble_init(void);
esp_err_t transport_ble_deinit(void);

#ifdef __cplusplus
}
#endif

#endif /* NARBIS_TRANSPORT_BLE_H */
