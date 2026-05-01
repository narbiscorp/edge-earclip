#ifndef NARBIS_CONFIG_MANAGER_H
#define NARBIS_CONFIG_MANAGER_H

#include <stdint.h>

#include "esp_err.h"
#include "narbis_protocol.h"

#ifdef __cplusplus
extern "C" {
#endif

/* =============================================================================
 * Runtime config persistence + apply orchestration.
 *
 * config_manager owns the single in-RAM copy of narbis_runtime_config_t.
 * On boot it loads from NVS (key cfg_blob in namespace narbis_pair) or falls
 * back to compiled-in defaults if missing/corrupt. Apply paths are routed
 * through config_apply(): validate, then call the affected components'
 * *_apply_config() functions, then persist on success and notify
 * NARBIS_CHR_CONFIG subscribers. On any apply failure the previous config
 * is restored best-effort and the error is returned.
 * ============================================================================= */

esp_err_t config_manager_init(void);
esp_err_t config_manager_deinit(void);

const narbis_runtime_config_t *config_get(void);

esp_err_t config_apply_initial(void);
esp_err_t config_apply(const narbis_runtime_config_t *new_cfg);

/* Apply only the 2-axis mode pair. Persists last_mode to NVS on success. */
esp_err_t config_apply_mode(uint8_t ble_profile, uint8_t data_format);

esp_err_t config_persist(void);

esp_err_t config_persist_last_mode(uint8_t ble_profile, uint8_t data_format);
esp_err_t config_get_last_mode(uint8_t *ble_profile, uint8_t *data_format);

/* Wipe all narbis_pair NVS entries, reload defaults, re-apply. */
esp_err_t config_factory_reset(void);

#ifdef __cplusplus
}
#endif

#endif /* NARBIS_CONFIG_MANAGER_H */
