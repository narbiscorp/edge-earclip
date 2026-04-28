#ifndef NARBIS_TRANSPORT_ESPNOW_H
#define NARBIS_TRANSPORT_ESPNOW_H

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

esp_err_t transport_espnow_init(void);
esp_err_t transport_espnow_deinit(void);

#ifdef __cplusplus
}
#endif

#endif /* NARBIS_TRANSPORT_ESPNOW_H */
