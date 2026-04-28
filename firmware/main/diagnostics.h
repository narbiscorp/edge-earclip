#ifndef NARBIS_DIAGNOSTICS_H
#define NARBIS_DIAGNOSTICS_H

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

esp_err_t diagnostics_init(void);
esp_err_t diagnostics_deinit(void);

#ifdef __cplusplus
}
#endif

#endif /* NARBIS_DIAGNOSTICS_H */
