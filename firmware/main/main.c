#include "esp_err.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs_flash.h"

#include "narbis_protocol.h"

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

    while (1) {
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}
