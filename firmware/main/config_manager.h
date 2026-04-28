#ifndef NARBIS_CONFIG_MANAGER_H
#define NARBIS_CONFIG_MANAGER_H

#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

esp_err_t config_manager_init(void);
esp_err_t config_manager_deinit(void);

/* Pairing helpers (NVS namespace "narbis_pair"). The full runtime-config
 * persistence (Stage 07) will share this namespace. */

/* Read the stored ESP-NOW partner MAC into mac[6].
 * Returns ESP_OK on success, ESP_ERR_NVS_NOT_FOUND if no partner has been
 * stored (e.g. fresh device or after config_clear_pairing). */
esp_err_t config_get_partner_mac(uint8_t mac[6]);

/* Persist the ESP-NOW partner MAC to NVS. Commits before returning. */
esp_err_t config_set_partner_mac(const uint8_t mac[6]);

/* Erase the stored partner MAC. Subsequent config_get_partner_mac calls
 * return ESP_ERR_NVS_NOT_FOUND. */
esp_err_t config_clear_pairing(void);

#ifdef __cplusplus
}
#endif

#endif /* NARBIS_CONFIG_MANAGER_H */
