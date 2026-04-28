#include "power_mgmt.h"

#include "esp_log.h"

static const char *TAG = "power_mgmt";

// TODO(stage-07): light-sleep policy, battery monitoring (no deep sleep —
// incompatible with continuous PPG sampling per CLAUDE.md).

esp_err_t power_mgmt_init(void)
{
    ESP_LOGI(TAG, "init (stub)");
    return ESP_OK;
}

esp_err_t power_mgmt_deinit(void)
{
    return ESP_OK;
}
