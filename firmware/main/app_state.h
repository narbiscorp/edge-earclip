#ifndef NARBIS_APP_STATE_H
#define NARBIS_APP_STATE_H

#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/* High-level operating state of the earclip. Driven by mode writes from
 * the dashboard and by OTA events. */
typedef enum {
    APP_STATE_BOOT         = 0,  /* before first config_apply_initial */
    APP_STATE_IDLE         = 1,  /* transient state on startup before first mode resolves */
    APP_STATE_EDGE_ONLY    = 2,  /* ESP-NOW only; BLE notifications quiescent */
    APP_STATE_HYBRID       = 3,  /* ESP-NOW + BLE notifications */
    APP_STATE_OTA_UPDATING = 4   /* OTA in progress; mode changes blocked */
} app_state_t;

esp_err_t   app_state_init(void);
esp_err_t   app_state_deinit(void);
app_state_t app_state_current(void);

/* Resume the persisted last-active mode. No-op if nothing is persisted
 * (factory state — current g_config drives the first transition instead). */
esp_err_t app_state_resume_last_mode(void);

/* Translate a mode triplet into the right APP_STATE_* and transition.
 * Returns ESP_ERR_INVALID_STATE if currently in OTA. Persists last_mode
 * on a successful transition. */
esp_err_t app_state_request_mode(uint8_t transport_mode, uint8_t ble_profile, uint8_t data_format);

/* OTA hooks. Stage 08 fills the body of ble_ota — these are wired now so
 * the state reflects OTA progress as soon as it lands. */
esp_err_t app_state_notify_ota_started(void);
esp_err_t app_state_notify_ota_complete(esp_err_t result);

#ifdef __cplusplus
}
#endif

#endif /* NARBIS_APP_STATE_H */
