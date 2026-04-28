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

/* Load runtime config from NVS or defaults. Does NOT touch any module —
 * modules are not yet initialised at this point in app_main(). Call
 * config_apply_initial() once everything is up. */
esp_err_t config_manager_init(void);
esp_err_t config_manager_deinit(void);

/* Read-only pointer to the live config. Field reads are atomic on RV32 so
 * no locking is needed for plain reads. All writes must go through
 * config_apply* functions. */
const narbis_runtime_config_t *config_get(void);

/* Push the loaded/default config out to every module. Called once after
 * all dependent components have been initialised. */
esp_err_t config_apply_initial(void);

/* Validate a proposed config, route changes to the right component apply
 * functions, persist on success, notify CONFIG. Restores the previous
 * config on any apply failure. */
esp_err_t config_apply(const narbis_runtime_config_t *new_cfg);

/* Apply only the 3-axis mode triplet. Persists last_mode to NVS on success. */
esp_err_t config_apply_mode(uint8_t transport_mode, uint8_t ble_profile, uint8_t data_format);

/* Update the ESP-NOW partner MAC. Rejects all-zero / all-FF. */
esp_err_t config_apply_partner_mac(const uint8_t mac[6]);

/* Persist the current g_config blob to NVS. */
esp_err_t config_persist(void);

/* Persist the last-active mode triplet (separate fast key from the cfg blob). */
esp_err_t config_persist_last_mode(uint8_t transport_mode, uint8_t ble_profile, uint8_t data_format);

/* Read the persisted last-active mode. Returns ESP_ERR_NVS_NOT_FOUND if
 * never set (treat as factory state and use the loaded config's mode). */
esp_err_t config_get_last_mode(uint8_t *transport_mode, uint8_t *ble_profile, uint8_t *data_format);

/* Wipe all narbis_pair NVS entries, reload defaults, re-apply. */
esp_err_t config_factory_reset(void);

/* =============================================================================
 * Pairing helpers — same NVS namespace, retained API.
 * ============================================================================= */

esp_err_t config_get_partner_mac(uint8_t mac[6]);
esp_err_t config_set_partner_mac(const uint8_t mac[6]);
esp_err_t config_clear_pairing(void);

#ifdef __cplusplus
}
#endif

#endif /* NARBIS_CONFIG_MANAGER_H */
