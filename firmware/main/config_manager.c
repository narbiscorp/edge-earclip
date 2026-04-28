/*
 * config_manager.c — runtime config persistence + apply orchestration.
 *
 * Owns the single in-RAM narbis_runtime_config_t. Other modules read it
 * via config_get(); writes go through config_apply*().
 *
 * NVS layout (namespace "narbis_pair"):
 *   "partner_mac"  blob, 6 bytes        ESP-NOW peer MAC (legacy key)
 *   "cfg_blob"     blob, NARBIS_CONFIG_WIRE_SIZE  serialized config + CRC16
 *   "last_mode"    blob, 3 bytes        transport, ble_profile, data_format
 */

#include "config_manager.h"

#include <string.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "nvs.h"
#include "nvs_flash.h"

#include "app_state.h"
#include "ble_service_narbis.h"
#include "ble_service_hrs.h"
#include "diagnostics.h"
#include "power_mgmt.h"
#include "transport_ble.h"
#include "transport_espnow.h"

#include "beat_validator.h"
#include "elgendi.h"
#include "ppg_channel.h"
#include "ppg_driver_max3010x.h"

static const char *TAG = "config_manager";

static const char *NVS_NS         = "narbis_pair";
static const char *KEY_PARTNER    = "partner_mac";
static const char *KEY_CFG_BLOB   = "cfg_blob";
static const char *KEY_LAST_MODE  = "last_mode";

static narbis_runtime_config_t g_config;
static SemaphoreHandle_t       g_config_mutex;

/* ============================================================================
 * Defaults
 * ========================================================================= */

static void load_default_config(narbis_runtime_config_t *c)
{
    memset(c, 0, sizeof(*c));
    c->config_version        = 2;
    c->sample_rate_hz        = 200;
    c->led_red_ma_x10        = 70;
    c->led_ir_ma_x10         = 70;
    c->agc_enabled           = 1;
    c->agc_update_period_ms  = 200;
    c->agc_target_dc_min     = 30000;
    c->agc_target_dc_max     = 100000;
    c->agc_step_ma_x10       = 5;
    c->bandpass_low_hz_x100  = 50;
    c->bandpass_high_hz_x100 = 800;
    c->elgendi_w1_ms         = 111;
    c->elgendi_w2_ms         = 667;
    c->elgendi_beta_x1000    = 20;
    c->sqi_threshold_x100    = 50;
    c->ibi_min_ms            = 300;
    c->ibi_max_ms            = 2000;
    c->ibi_max_delta_pct     = 30;
    c->transport_mode        = NARBIS_TRANSPORT_HYBRID;
    c->ble_profile           = NARBIS_BLE_BATCHED;
    c->data_format           = NARBIS_DATA_IBI_ONLY;
    c->ble_batch_period_ms   = 500;
    c->espnow_channel        = 1;
    c->diagnostics_enabled   = 1;
    c->light_sleep_enabled   = 1;
    c->diagnostics_mask      = 0;
    c->battery_low_mv        = 3300;
}

/* ============================================================================
 * Validation
 * ========================================================================= */

static bool validate_config(const narbis_runtime_config_t *c)
{
    if (c->sample_rate_hz != 50 && c->sample_rate_hz != 100 &&
        c->sample_rate_hz != 200 && c->sample_rate_hz != 400) return false;
    if (c->led_red_ma_x10 > 510 || c->led_ir_ma_x10 > 510)    return false;
    if (c->bandpass_low_hz_x100 == 0 ||
        c->bandpass_low_hz_x100 >= c->bandpass_high_hz_x100)  return false;
    if (c->elgendi_w1_ms == 0 || c->elgendi_w2_ms == 0 ||
        c->elgendi_w1_ms >= c->elgendi_w2_ms)                 return false;
    if (c->ibi_min_ms == 0 || c->ibi_min_ms >= c->ibi_max_ms) return false;
    if (c->ibi_max_delta_pct > 100)                            return false;
    if (c->transport_mode > NARBIS_TRANSPORT_HYBRID)           return false;
    if (c->ble_profile > NARBIS_BLE_LOW_LATENCY)               return false;
    if (c->data_format > NARBIS_DATA_IBI_PLUS_RAW)             return false;
    if (c->espnow_channel < 1 || c->espnow_channel > 13)       return false;
    if (c->battery_low_mv < 2800 || c->battery_low_mv > 4200)  return false;
    return true;
}

static bool mac_is_special(const uint8_t mac[6])
{
    bool all_zero = true, all_ff = true;
    for (int i = 0; i < 6; i++) {
        if (mac[i] != 0x00) all_zero = false;
        if (mac[i] != 0xFF) all_ff = false;
    }
    return all_zero || all_ff;
}

/* ============================================================================
 * Apply helpers — each routes a slice of the config to the owning module.
 * Called under g_config_mutex.
 * ========================================================================= */

static esp_err_t apply_dsp(const narbis_runtime_config_t *c)
{
    esp_err_t err;
    err = ppg_channel_apply_config(c);
    if (err != ESP_OK) return err;
    err = elgendi_apply_config(c);
    if (err != ESP_OK) return err;
    err = beat_validator_apply_config(c);
    return err;
}

static esp_err_t apply_sensor(const narbis_runtime_config_t *c,
                              const narbis_runtime_config_t *prev)
{
    esp_err_t err;
    if (prev == NULL || c->led_red_ma_x10 != prev->led_red_ma_x10) {
        err = ppg_driver_set_led_current(PPG_LED_RED, c->led_red_ma_x10);
        if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return err;
    }
    if (prev == NULL || c->led_ir_ma_x10 != prev->led_ir_ma_x10) {
        err = ppg_driver_set_led_current(PPG_LED_IR, c->led_ir_ma_x10);
        if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return err;
    }
    if (prev == NULL || c->sample_rate_hz != prev->sample_rate_hz) {
        err = ppg_driver_set_sample_rate(c->sample_rate_hz);
        if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return err;
    }
    return ESP_OK;
}

static esp_err_t apply_transport(const narbis_runtime_config_t *c,
                                 const narbis_runtime_config_t *prev)
{
    if (prev == NULL || c->ble_profile != prev->ble_profile) {
        ble_service_hrs_set_profile(c->ble_profile);
        esp_err_t err = transport_ble_set_profile(c->ble_profile);
        if (err != ESP_OK) return err;
    }
    if (prev == NULL || memcmp(c->partner_mac, prev->partner_mac, 6) != 0) {
        if (!mac_is_special(c->partner_mac)) {
            esp_err_t err = transport_espnow_set_partner(c->partner_mac);
            if (err != ESP_OK) return err;
        }
    }
    return ESP_OK;
}

static esp_err_t apply_aux(const narbis_runtime_config_t *c)
{
    diagnostics_set_mask(c->diagnostics_enabled ? c->diagnostics_mask : 0u);
    return power_mgmt_set_light_sleep_enabled(c->light_sleep_enabled);
}

static esp_err_t apply_all_unconditional(const narbis_runtime_config_t *c)
{
    esp_err_t err;
    if ((err = apply_sensor(c, NULL))    != ESP_OK) return err;
    if ((err = apply_dsp(c))             != ESP_OK) return err;
    if ((err = apply_transport(c, NULL)) != ESP_OK) return err;
    if ((err = apply_aux(c))             != ESP_OK) return err;
    return ESP_OK;
}

static esp_err_t apply_diff(const narbis_runtime_config_t *new_cfg,
                            const narbis_runtime_config_t *prev)
{
    esp_err_t err;
    if ((err = apply_sensor(new_cfg, prev)) != ESP_OK) return err;

    /* DSP fields are interdependent; if any changed, reapply all. */
    bool dsp_changed =
        new_cfg->bandpass_low_hz_x100  != prev->bandpass_low_hz_x100  ||
        new_cfg->bandpass_high_hz_x100 != prev->bandpass_high_hz_x100 ||
        new_cfg->elgendi_w1_ms         != prev->elgendi_w1_ms         ||
        new_cfg->elgendi_w2_ms         != prev->elgendi_w2_ms         ||
        new_cfg->elgendi_beta_x1000    != prev->elgendi_beta_x1000    ||
        new_cfg->sqi_threshold_x100    != prev->sqi_threshold_x100    ||
        new_cfg->ibi_min_ms            != prev->ibi_min_ms            ||
        new_cfg->ibi_max_ms            != prev->ibi_max_ms            ||
        new_cfg->ibi_max_delta_pct     != prev->ibi_max_delta_pct     ||
        new_cfg->agc_enabled           != prev->agc_enabled           ||
        new_cfg->agc_update_period_ms  != prev->agc_update_period_ms  ||
        new_cfg->agc_target_dc_min     != prev->agc_target_dc_min     ||
        new_cfg->agc_target_dc_max     != prev->agc_target_dc_max     ||
        new_cfg->agc_step_ma_x10       != prev->agc_step_ma_x10       ||
        new_cfg->sample_rate_hz        != prev->sample_rate_hz;
    if (dsp_changed) {
        if ((err = apply_dsp(new_cfg)) != ESP_OK) return err;
    }

    if ((err = apply_transport(new_cfg, prev)) != ESP_OK) return err;

    bool aux_changed =
        new_cfg->diagnostics_enabled != prev->diagnostics_enabled ||
        new_cfg->diagnostics_mask    != prev->diagnostics_mask    ||
        new_cfg->light_sleep_enabled != prev->light_sleep_enabled;
    if (aux_changed) {
        if ((err = apply_aux(new_cfg)) != ESP_OK) return err;
    }
    return ESP_OK;
}

/* ============================================================================
 * NVS persistence
 * ========================================================================= */

static esp_err_t persist_blob_locked(void)
{
    uint8_t buf[NARBIS_CONFIG_WIRE_SIZE];
    size_t  out_len = 0;
    if (narbis_config_serialize(buf, sizeof(buf), &g_config, &out_len) != 0) {
        return ESP_FAIL;
    }
    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NS, NVS_READWRITE, &h);
    if (err != ESP_OK) return err;
    err = nvs_set_blob(h, KEY_CFG_BLOB, buf, out_len);
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    return err;
}

static esp_err_t load_blob(narbis_runtime_config_t *out)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NS, NVS_READONLY, &h);
    if (err != ESP_OK) return err;
    uint8_t buf[NARBIS_CONFIG_WIRE_SIZE];
    size_t  len = sizeof(buf);
    err = nvs_get_blob(h, KEY_CFG_BLOB, buf, &len);
    nvs_close(h);
    if (err != ESP_OK) return err;
    if (len != NARBIS_CONFIG_WIRE_SIZE) return ESP_ERR_INVALID_SIZE;
    if (narbis_config_deserialize(buf, len, out) != 0) {
        return ESP_ERR_INVALID_CRC;
    }
    return ESP_OK;
}

/* ============================================================================
 * Public API
 * ========================================================================= */

esp_err_t config_manager_init(void)
{
    if (g_config_mutex == NULL) {
        g_config_mutex = xSemaphoreCreateMutex();
        if (g_config_mutex == NULL) return ESP_ERR_NO_MEM;
    }

    narbis_runtime_config_t loaded;
    esp_err_t err = load_blob(&loaded);
    if (err == ESP_OK && loaded.config_version >= 2 && validate_config(&loaded)) {
        g_config = loaded;
        ESP_LOGI(TAG, "loaded persisted config (version=%u)", loaded.config_version);
    } else {
        if (err == ESP_OK) {
            ESP_LOGW(TAG, "persisted config rejected (version=%u, valid=%d) — using defaults",
                     loaded.config_version, validate_config(&loaded));
        } else if (err == ESP_ERR_NVS_NOT_FOUND) {
            ESP_LOGI(TAG, "no persisted config — using defaults");
        } else {
            ESP_LOGW(TAG, "config load failed: %s — using defaults", esp_err_to_name(err));
        }
        load_default_config(&g_config);
    }
    return ESP_OK;
}

esp_err_t config_manager_deinit(void)
{
    return ESP_OK;
}

const narbis_runtime_config_t *config_get(void)
{
    return &g_config;
}

esp_err_t config_apply_initial(void)
{
    xSemaphoreTake(g_config_mutex, portMAX_DELAY);
    esp_err_t err = apply_all_unconditional(&g_config);
    xSemaphoreGive(g_config_mutex);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "initial apply failed: %s", esp_err_to_name(err));
    }
    return err;
}

esp_err_t config_apply(const narbis_runtime_config_t *new_cfg)
{
    if (new_cfg == NULL)            return ESP_ERR_INVALID_ARG;
    if (!validate_config(new_cfg))  return ESP_ERR_INVALID_ARG;

    xSemaphoreTake(g_config_mutex, portMAX_DELAY);
    narbis_runtime_config_t prev = g_config;
    g_config = *new_cfg;
    /* config_version is owned by the firmware; ignore whatever the writer sent. */
    g_config.config_version = 2;

    esp_err_t err = apply_diff(&g_config, &prev);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "apply failed (%s) — rolling back", esp_err_to_name(err));
        g_config = prev;
        (void)apply_all_unconditional(&g_config);
        xSemaphoreGive(g_config_mutex);
        return err;
    }

    esp_err_t pe = persist_blob_locked();
    xSemaphoreGive(g_config_mutex);
    if (pe != ESP_OK) {
        ESP_LOGW(TAG, "persist failed: %s", esp_err_to_name(pe));
    }
    (void)ble_service_narbis_notify_config();
    ESP_LOGI(TAG, "config applied + persisted");
    return ESP_OK;
}

esp_err_t config_apply_mode(uint8_t transport_mode, uint8_t ble_profile, uint8_t data_format)
{
    if (transport_mode > NARBIS_TRANSPORT_HYBRID ||
        ble_profile    > NARBIS_BLE_LOW_LATENCY  ||
        data_format    > NARBIS_DATA_IBI_PLUS_RAW) {
        return ESP_ERR_INVALID_ARG;
    }
    if (app_state_current() == APP_STATE_OTA_UPDATING) {
        return ESP_ERR_INVALID_STATE;
    }

    xSemaphoreTake(g_config_mutex, portMAX_DELAY);
    bool profile_changed = (g_config.ble_profile != ble_profile);
    g_config.transport_mode = transport_mode;
    g_config.ble_profile    = ble_profile;
    g_config.data_format    = data_format;

    esp_err_t err = ESP_OK;
    if (profile_changed) {
        ble_service_hrs_set_profile(ble_profile);
        err = transport_ble_set_profile(ble_profile);
    }
    if (err == ESP_OK) {
        (void)persist_blob_locked();
    }
    xSemaphoreGive(g_config_mutex);

    if (err == ESP_OK) {
        (void)config_persist_last_mode(transport_mode, ble_profile, data_format);
        (void)app_state_request_mode(transport_mode, ble_profile, data_format);
        (void)ble_service_narbis_notify_config();
        ESP_LOGI(TAG, "mode applied transport=%u profile=%u format=%u",
                 transport_mode, ble_profile, data_format);
    }
    return err;
}

esp_err_t config_apply_partner_mac(const uint8_t mac[6])
{
    if (mac == NULL)         return ESP_ERR_INVALID_ARG;
    if (mac_is_special(mac)) return ESP_ERR_INVALID_ARG;

    xSemaphoreTake(g_config_mutex, portMAX_DELAY);
    memcpy(g_config.partner_mac, mac, 6);
    esp_err_t err = transport_espnow_set_partner(mac);
    if (err == ESP_OK) {
        (void)persist_blob_locked();
    }
    xSemaphoreGive(g_config_mutex);
    if (err == ESP_OK) {
        (void)ble_service_narbis_notify_config();
    }
    return err;
}

esp_err_t config_persist(void)
{
    xSemaphoreTake(g_config_mutex, portMAX_DELAY);
    esp_err_t err = persist_blob_locked();
    xSemaphoreGive(g_config_mutex);
    return err;
}

esp_err_t config_persist_last_mode(uint8_t transport_mode, uint8_t ble_profile, uint8_t data_format)
{
    uint8_t blob[3] = { transport_mode, ble_profile, data_format };
    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NS, NVS_READWRITE, &h);
    if (err != ESP_OK) return err;
    err = nvs_set_blob(h, KEY_LAST_MODE, blob, sizeof(blob));
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    return err;
}

esp_err_t config_get_last_mode(uint8_t *transport_mode, uint8_t *ble_profile, uint8_t *data_format)
{
    if (transport_mode == NULL || ble_profile == NULL || data_format == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NS, NVS_READONLY, &h);
    if (err != ESP_OK) return err;
    uint8_t blob[3];
    size_t  len = sizeof(blob);
    err = nvs_get_blob(h, KEY_LAST_MODE, blob, &len);
    nvs_close(h);
    if (err != ESP_OK) return err;
    if (len != 3) return ESP_ERR_INVALID_SIZE;
    *transport_mode = blob[0];
    *ble_profile    = blob[1];
    *data_format    = blob[2];
    return ESP_OK;
}

esp_err_t config_factory_reset(void)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NS, NVS_READWRITE, &h);
    if (err == ESP_OK) {
        (void)nvs_erase_key(h, KEY_PARTNER);
        (void)nvs_erase_key(h, KEY_CFG_BLOB);
        (void)nvs_erase_key(h, KEY_LAST_MODE);
        (void)nvs_commit(h);
        nvs_close(h);
    }
    xSemaphoreTake(g_config_mutex, portMAX_DELAY);
    load_default_config(&g_config);
    esp_err_t aerr = apply_all_unconditional(&g_config);
    xSemaphoreGive(g_config_mutex);
    (void)ble_service_narbis_notify_config();
    ESP_LOGW(TAG, "factory reset: %s", esp_err_to_name(aerr));
    return aerr;
}

/* ============================================================================
 * Pairing helpers — unchanged behaviour.
 * ========================================================================= */

esp_err_t config_get_partner_mac(uint8_t mac[6])
{
    if (mac == NULL) return ESP_ERR_INVALID_ARG;
    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NS, NVS_READONLY, &h);
    if (err != ESP_OK) return err;
    size_t len = 6;
    err = nvs_get_blob(h, KEY_PARTNER, mac, &len);
    nvs_close(h);
    if (err != ESP_OK) return err;
    if (len != 6) return ESP_ERR_INVALID_SIZE;
    return ESP_OK;
}

esp_err_t config_set_partner_mac(const uint8_t mac[6])
{
    if (mac == NULL) return ESP_ERR_INVALID_ARG;
    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NS, NVS_READWRITE, &h);
    if (err != ESP_OK) return err;
    err = nvs_set_blob(h, KEY_PARTNER, mac, 6);
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    return err;
}

esp_err_t config_clear_pairing(void)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NS, NVS_READWRITE, &h);
    if (err != ESP_OK) return err;
    err = nvs_erase_key(h, KEY_PARTNER);
    if (err == ESP_ERR_NVS_NOT_FOUND) err = ESP_OK;
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    return err;
}
