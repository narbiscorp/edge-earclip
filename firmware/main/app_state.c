#include "app_state.h"

#include "esp_log.h"

static const char *TAG = "app_state";

// TODO(stage-07): mode state machine (transport / ble_profile / data_format).

esp_err_t app_state_init(void)
{
    ESP_LOGI(TAG, "init (stub)");
    return ESP_OK;
}

esp_err_t app_state_deinit(void)
{
    return ESP_OK;
}
