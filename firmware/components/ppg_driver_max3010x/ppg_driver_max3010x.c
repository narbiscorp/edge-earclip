#include "ppg_driver_max3010x.h"

#include "esp_log.h"

static const char *TAG = "ppg_driver";

// TODO(stage-03): MAX30102/MAX30101 auto-detect driver, FIFO-IRQ sampling
// at 50/100/200/400 Hz, AGC hooks. Pinout per CLAUDE.md (SDA=GPIO22,
// SCL=GPIO23, INT=GPIO0, VIN=3.3V).

esp_err_t ppg_driver_max3010x_init(void)
{
    ESP_LOGI(TAG, "init (stub)");
    return ESP_OK;
}

esp_err_t ppg_driver_max3010x_deinit(void)
{
    return ESP_OK;
}
