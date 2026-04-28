#ifndef NARBIS_POWER_MGMT_H
#define NARBIS_POWER_MGMT_H

#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

esp_err_t power_mgmt_init(void);
esp_err_t power_mgmt_deinit(void);

/* Battery state. Stage 05 returns plausible fixed values so the ESP-NOW
 * battery frame can be wired end-to-end; Stage 06 swaps the body for real
 * ADC reads of the XIAO ESP32-C6's battery sense pin. */
esp_err_t power_mgmt_get_battery(uint16_t *mv, uint8_t *soc_pct, uint8_t *charging);

#ifdef __cplusplus
}
#endif

#endif /* NARBIS_POWER_MGMT_H */
