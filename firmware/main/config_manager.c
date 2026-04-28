#include "config_manager.h"

#include "esp_log.h"

static const char *TAG = "config_manager";

// TODO(stage-07): NVS-backed narbis_runtime_config_t persistence and runtime
// apply paths.

esp_err_t config_manager_init(void)
{
    ESP_LOGI(TAG, "init (stub)");
    return ESP_OK;
}

esp_err_t config_manager_deinit(void)
{
    return ESP_OK;
}
