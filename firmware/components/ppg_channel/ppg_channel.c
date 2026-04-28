#include "ppg_channel.h"

#include "esp_log.h"

static const char *TAG = "ppg_channel";

// TODO(stage-04): channel selection (red vs IR), DC removal, AGC controller.

esp_err_t ppg_channel_init(void)
{
    ESP_LOGI(TAG, "init (stub)");
    return ESP_OK;
}

esp_err_t ppg_channel_deinit(void)
{
    return ESP_OK;
}
