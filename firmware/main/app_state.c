/*
 * app_state.c — high-level state machine.
 *
 * State transitions:
 *
 *   BOOT ─→ IDLE ─→ {EDGE_ONLY | HYBRID} ⇄ each other
 *                      │
 *                      ↓ (OTA write)
 *                  OTA_UPDATING
 *                      │
 *                      ↓ (OTA complete)
 *                  back to last running mode
 *
 * Held in a plain volatile uint8_t — single writer (this module), readers
 * call app_state_current() lock-free.
 */

#include "app_state.h"

#include <string.h>

#include "esp_log.h"
#include "nvs.h"

#include "config_manager.h"
#include "narbis_protocol.h"

static const char *TAG = "app_state";

static volatile uint8_t s_state = APP_STATE_BOOT;
static uint8_t          s_pre_ota_state = APP_STATE_HYBRID;

static const char *state_name(app_state_t s)
{
    switch (s) {
    case APP_STATE_BOOT:         return "BOOT";
    case APP_STATE_IDLE:         return "IDLE";
    case APP_STATE_EDGE_ONLY:    return "EDGE_ONLY";
    case APP_STATE_HYBRID:       return "HYBRID";
    case APP_STATE_OTA_UPDATING: return "OTA";
    default:                     return "?";
    }
}

static void transition(app_state_t to)
{
    app_state_t from = (app_state_t)s_state;
    if (from == to) return;
    s_state = (uint8_t)to;
    ESP_LOGI(TAG, "%s -> %s", state_name(from), state_name(to));
}

esp_err_t app_state_init(void)
{
    s_state = APP_STATE_IDLE;
    ESP_LOGI(TAG, "init -> IDLE");
    return ESP_OK;
}

esp_err_t app_state_deinit(void)
{
    return ESP_OK;
}

app_state_t app_state_current(void)
{
    return (app_state_t)s_state;
}

esp_err_t app_state_resume_last_mode(void)
{
    uint8_t t, p, f;
    esp_err_t err = config_get_last_mode(&t, &p, &f);
    if (err == ESP_ERR_NVS_NOT_FOUND) {
        /* Factory state — derive mode from the loaded config. */
        const narbis_runtime_config_t *cfg = config_get();
        return app_state_request_mode(cfg->transport_mode, cfg->ble_profile, cfg->data_format);
    }
    if (err != ESP_OK) return err;
    return app_state_request_mode(t, p, f);
}

esp_err_t app_state_request_mode(uint8_t transport_mode, uint8_t ble_profile, uint8_t data_format)
{
    if (s_state == APP_STATE_OTA_UPDATING) {
        return ESP_ERR_INVALID_STATE;
    }
    if (transport_mode > NARBIS_TRANSPORT_HYBRID) return ESP_ERR_INVALID_ARG;

    app_state_t next = (transport_mode == NARBIS_TRANSPORT_HYBRID)
        ? APP_STATE_HYBRID : APP_STATE_EDGE_ONLY;
    transition(next);
    (void)config_persist_last_mode(transport_mode, ble_profile, data_format);
    return ESP_OK;
}

esp_err_t app_state_notify_ota_started(void)
{
    s_pre_ota_state = s_state;
    transition(APP_STATE_OTA_UPDATING);
    return ESP_OK;
}

esp_err_t app_state_notify_ota_complete(esp_err_t result)
{
    if (result == ESP_OK) {
        ESP_LOGI(TAG, "OTA complete — device will reboot");
        return ESP_OK;
    }
    ESP_LOGW(TAG, "OTA failed (%s) — restoring %s",
             esp_err_to_name(result), state_name((app_state_t)s_pre_ota_state));
    transition((app_state_t)s_pre_ota_state);
    return ESP_OK;
}
