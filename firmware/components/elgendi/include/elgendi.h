#ifndef NARBIS_ELGENDI_H
#define NARBIS_ELGENDI_H

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

esp_err_t elgendi_init(void);
esp_err_t elgendi_deinit(void);

#ifdef __cplusplus
}
#endif

#endif /* NARBIS_ELGENDI_H */
