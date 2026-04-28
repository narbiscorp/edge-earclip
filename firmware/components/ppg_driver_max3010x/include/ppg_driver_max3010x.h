#ifndef NARBIS_PPG_DRIVER_MAX3010X_H
#define NARBIS_PPG_DRIVER_MAX3010X_H

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

esp_err_t ppg_driver_max3010x_init(void);
esp_err_t ppg_driver_max3010x_deinit(void);

#ifdef __cplusplus
}
#endif

#endif /* NARBIS_PPG_DRIVER_MAX3010X_H */
