#include "ble_service_dis.h"

#include "esp_log.h"

static const char *TAG = "ble_service_dis";

// TODO(stage-06): standard Device Information Service (0x180A).

esp_err_t ble_service_dis_init(void)
{
    ESP_LOGI(TAG, "init (stub)");
    return ESP_OK;
}

esp_err_t ble_service_dis_deinit(void)
{
    return ESP_OK;
}
