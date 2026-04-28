#include "transport_ble.h"

#include "esp_log.h"

static const char *TAG = "transport_ble";

// TODO(stage-06): NimBLE GATT server lifecycle (init, advertising, GAP).

esp_err_t transport_ble_init(void)
{
    ESP_LOGI(TAG, "init (stub)");
    return ESP_OK;
}

esp_err_t transport_ble_deinit(void)
{
    return ESP_OK;
}
