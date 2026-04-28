#include "ble_ota.h"

#include "esp_log.h"

static const char *TAG = "ble_ota";

// TODO(stage-08): Nordic-style DFU OTA, ported from existing Edge firmware.

esp_err_t ble_ota_init(void)
{
    ESP_LOGI(TAG, "init (stub)");
    return ESP_OK;
}

esp_err_t ble_ota_deinit(void)
{
    return ESP_OK;
}
