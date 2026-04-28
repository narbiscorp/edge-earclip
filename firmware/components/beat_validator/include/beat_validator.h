#ifndef NARBIS_BEAT_VALIDATOR_H
#define NARBIS_BEAT_VALIDATOR_H

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

esp_err_t beat_validator_init(void);
esp_err_t beat_validator_deinit(void);

#ifdef __cplusplus
}
#endif

#endif /* NARBIS_BEAT_VALIDATOR_H */
