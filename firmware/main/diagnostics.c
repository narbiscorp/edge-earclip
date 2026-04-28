#include "diagnostics.h"

#include "esp_log.h"

static const char *TAG = "diagnostics";

// TODO(stage-07): emit NARBIS_CHR_DIAGNOSTICS notifications (uptime, free
// heap, RSSI, mode byte) and HEARTBEAT ESP-NOW packets.

esp_err_t diagnostics_init(void)
{
    ESP_LOGI(TAG, "init (stub)");
    return ESP_OK;
}

esp_err_t diagnostics_deinit(void)
{
    return ESP_OK;
}
