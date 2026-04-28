#ifndef NARBIS_PPG_CHANNEL_H
#define NARBIS_PPG_CHANNEL_H

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

esp_err_t ppg_channel_init(void);
esp_err_t ppg_channel_deinit(void);

#ifdef __cplusplus
}
#endif

#endif /* NARBIS_PPG_CHANNEL_H */
