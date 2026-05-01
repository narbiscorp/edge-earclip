#ifndef NARBIS_APP_STATE_H
#define NARBIS_APP_STATE_H

#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/* High-level operating state of the earclip. After Path B (BLE-only)
 * collapses ESP-NOW, EDGE_ONLY and HYBRID merged into STREAMING. */
typedef enum {
    APP_STATE_BOOT         = 0,  /* before first config_apply_initial */
    APP_STATE_IDLE         = 1,  /* transient state on startup before first mode resolves */
    APP_STATE_STREAMING    = 2,  /* BLE notifications active */
    APP_STATE_OTA_UPDATING = 3   /* OTA in progress; mode changes blocked */
} app_state_t;

esp_err_t   app_state_init(void);
esp_err_t   app_state_deinit(void);
app_state_t app_state_current(void);

/* Resume the persisted last-active mode. No-op if nothing is persisted
 * (factory state — current g_config drives the first transition instead). */
esp_err_t app_state_resume_last_mode(void);

/* Translate a mode tuple into STREAMING and persist last_mode.
 * Returns ESP_ERR_INVALID_STATE if currently in OTA. */
esp_err_t app_state_request_mode(uint8_t ble_profile, uint8_t data_format);

/* OTA hooks. Stage 08 fills the body of ble_ota — these are wired now so
 * the state reflects OTA progress as soon as it lands. */
esp_err_t app_state_notify_ota_started(void);
esp_err_t app_state_notify_ota_complete(esp_err_t result);

#ifdef __cplusplus
}
#endif

#endif /* NARBIS_APP_STATE_H */
