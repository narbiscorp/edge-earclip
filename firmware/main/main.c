#include "esp_err.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs_flash.h"

#include "narbis_protocol.h"
#include "ppg_driver_max3010x.h"

#include "app_state.h"
#include "ble_ota.h"
#include "ble_service_battery.h"
#include "ble_service_dis.h"
#include "ble_service_hrs.h"
#include "ble_service_narbis.h"
#include "config_manager.h"
#include "diagnostics.h"
#include "power_mgmt.h"
#include "transport_ble.h"
#include "transport_espnow.h"

static const char *TAG = "narbis";

/* Stage 03 sample probe — logs the first 10 samples and unregisters itself.
 * Replaced in Stage 04 by the ppg_channel hand-off. */
static void ppg_probe_cb(const ppg_sample_t *sample, void *user_ctx)
{
    (void)user_ctx;
    static int count = 0;
    static int64_t prev_ts = 0;
    if (count >= 10) return;
    int64_t dt = (count == 0) ? 0 : (sample->timestamp_us - prev_ts);
    ESP_LOGI(TAG, "ppg[%d] ts=%lld red=%lu ir=%lu green=%lu dt=%lld us",
             count, (long long)sample->timestamp_us,
             (unsigned long)sample->red, (unsigned long)sample->ir,
             (unsigned long)sample->green, (long long)dt);
    prev_ts = sample->timestamp_us;
    if (++count >= 10) {
        ppg_driver_unregister_sample_callback();
        ESP_LOGI(TAG, "ppg probe done — callback unregistered");
    }
}

static esp_err_t nvs_init_with_recovery(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    return err;
}

void app_main(void)
{
    ESP_ERROR_CHECK(nvs_init_with_recovery());

    ESP_LOGI(TAG, "Narbis earclip booting v0.1.0, protocol version %d",
             NARBIS_PROTOCOL_VERSION);

    ESP_ERROR_CHECK(app_state_init());
    ESP_ERROR_CHECK(config_manager_init());
    ESP_ERROR_CHECK(power_mgmt_init());
    ESP_ERROR_CHECK(transport_espnow_init());
    ESP_ERROR_CHECK(transport_ble_init());
    ESP_ERROR_CHECK(ble_service_dis_init());
    ESP_ERROR_CHECK(ble_service_battery_init());
    ESP_ERROR_CHECK(ble_service_hrs_init());
    ESP_ERROR_CHECK(ble_service_narbis_init());
    ESP_ERROR_CHECK(ble_ota_init());
    ESP_ERROR_CHECK(diagnostics_init());

    ppg_driver_config_t ppg_cfg = ppg_driver_default_config();
    ESP_ERROR_CHECK(ppg_driver_init(&ppg_cfg));
    ESP_ERROR_CHECK(ppg_driver_register_sample_callback(ppg_probe_cb, NULL));

    while (1) {
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}
