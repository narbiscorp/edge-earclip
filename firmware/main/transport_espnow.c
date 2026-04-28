#include "transport_espnow.h"

#include "esp_log.h"

static const char *TAG = "transport_espnow";

// TODO(stage-05): low-latency ESP-NOW transport to Edge glasses.

esp_err_t transport_espnow_init(void)
{
    ESP_LOGI(TAG, "init (stub)");
    return ESP_OK;
}

esp_err_t transport_espnow_deinit(void)
{
    return ESP_OK;
}
