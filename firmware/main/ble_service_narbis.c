#include "ble_service_narbis.h"

#include "esp_log.h"

static const char *TAG = "ble_service_narbis";

// TODO(stage-06): custom Narbis service (IBI, SQI, raw PPG, config, mode,
// diagnostics). UUIDs in protocol/narbis_protocol.h.

esp_err_t ble_service_narbis_init(void)
{
    ESP_LOGI(TAG, "init (stub)");
    return ESP_OK;
}

esp_err_t ble_service_narbis_deinit(void)
{
    return ESP_OK;
}
