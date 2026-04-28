#include "elgendi.h"

#include "esp_log.h"

static const char *TAG = "elgendi";

// TODO(stage-04): bandpass filter (configurable cutoffs) + Elgendi systolic
// peak detection (W1, W2, beta from narbis_runtime_config_t).

esp_err_t elgendi_init(void)
{
    ESP_LOGI(TAG, "init (stub)");
    return ESP_OK;
}

esp_err_t elgendi_deinit(void)
{
    return ESP_OK;
}
