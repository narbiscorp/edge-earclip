#include "ble_service_battery.h"

#include "esp_log.h"

static const char *TAG = "ble_service_battery";

// TODO(stage-06): standard Battery Service (0x180F) plus custom rich battery
// characteristic (NARBIS_CHR_BATTERY_UUID).

esp_err_t ble_service_battery_init(void)
{
    ESP_LOGI(TAG, "init (stub)");
    return ESP_OK;
}

esp_err_t ble_service_battery_deinit(void)
{
    return ESP_OK;
}
