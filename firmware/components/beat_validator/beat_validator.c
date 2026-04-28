#include "beat_validator.h"

#include "esp_log.h"

static const char *TAG = "beat_validator";

// TODO(stage-04): IBI plausibility + continuity checks. Flag artifacts via
// NARBIS_BEAT_FLAG_*; never silently drop beats (CLAUDE.md).

esp_err_t beat_validator_init(void)
{
    ESP_LOGI(TAG, "init (stub)");
    return ESP_OK;
}

esp_err_t beat_validator_deinit(void)
{
    return ESP_OK;
}
