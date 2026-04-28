#ifndef NARBIS_APP_STATE_H
#define NARBIS_APP_STATE_H

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

esp_err_t app_state_init(void);
esp_err_t app_state_deinit(void);

#ifdef __cplusplus
}
#endif

#endif /* NARBIS_APP_STATE_H */
