#ifndef NARBIS_CONFIG_MANAGER_H
#define NARBIS_CONFIG_MANAGER_H

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

esp_err_t config_manager_init(void);
esp_err_t config_manager_deinit(void);

#ifdef __cplusplus
}
#endif

#endif /* NARBIS_CONFIG_MANAGER_H */
