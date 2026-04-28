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

esp_err_t power_mgmt_get_battery(uint16_t *mv, uint8_t *soc_pct, uint8_t *charging)
{
    if (mv == NULL || soc_pct == NULL || charging == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    /* TODO(stage-06): replace with real ADC read of the XIAO battery sense
     * pin and a SoC LUT. Fixed plausible values keep the ESP-NOW battery
     * frame meaningful for transport/coex testing. */
    *mv       = 4000;
    *soc_pct  = 80;
    *charging = 0;
    return ESP_OK;
}
