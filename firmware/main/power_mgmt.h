#ifndef NARBIS_POWER_MGMT_H
#define NARBIS_POWER_MGMT_H

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

esp_err_t power_mgmt_init(void);
esp_err_t power_mgmt_deinit(void);

#ifdef __cplusplus
}
#endif

#endif /* NARBIS_POWER_MGMT_H */
