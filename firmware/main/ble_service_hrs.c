#include "ble_service_hrs.h"

#include "esp_log.h"

static const char *TAG = "ble_service_hrs";

// TODO(stage-06): standard Heart Rate Service (0x180D).

esp_err_t ble_service_hrs_init(void)
{
    ESP_LOGI(TAG, "init (stub)");
    return ESP_OK;
}

esp_err_t ble_service_hrs_deinit(void)
{
    return ESP_OK;
}
