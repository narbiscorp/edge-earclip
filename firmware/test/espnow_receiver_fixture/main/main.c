/*
 * espnow_receiver_fixture — minimal ESP-NOW receiver for Stage-05 bring-up.
 *
 * Flash this onto any ESP32 (any variant). At boot it prints its Wi-Fi STA
 * MAC; configure the earclip's CONFIG_NARBIS_HARDCODED_PARTNER_MAC_VAL to
 * match. Each Narbis frame is deserialized through the shared protocol
 * helper and pretty-printed on the console.
 */

#include <stdio.h>
#include <string.h>

#include "esp_err.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_now.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs_flash.h"

#include "narbis_protocol.h"

#ifndef RX_CHANNEL
#define RX_CHANNEL 1  /* must match the earclip's CONFIG_NARBIS_ESPNOW_CHANNEL */
#endif

static const char *TAG = "rx";

static void on_recv(const esp_now_recv_info_t *info, const uint8_t *data, int len)
{
    if (info == NULL || data == NULL || len <= 0) {
        return;
    }

    narbis_packet_t pkt;
    int rc = narbis_packet_deserialize(data, (size_t)len, &pkt);
    if (rc != 0) {
        ESP_LOGW(TAG,
                 "deserialize failed rc=%d len=%d from %02x:%02x:%02x:%02x:%02x:%02x",
                 rc, len,
                 info->src_addr[0], info->src_addr[1], info->src_addr[2],
                 info->src_addr[3], info->src_addr[4], info->src_addr[5]);
        return;
    }

    switch ((narbis_msg_type_t)pkt.header.msg_type) {
    case NARBIS_MSG_IBI:
        ESP_LOGI(TAG,
                 "IBI       seq=%u ts=%lu  ibi=%u ms  conf=%u  flags=0x%02x",
                 pkt.header.seq_num,
                 (unsigned long)pkt.header.timestamp_ms,
                 pkt.payload.ibi.ibi_ms,
                 pkt.payload.ibi.confidence_x100,
                 pkt.payload.ibi.flags);
        break;
    case NARBIS_MSG_BATTERY:
        ESP_LOGI(TAG,
                 "BATTERY   seq=%u ts=%lu  mv=%u  soc=%u%%  charging=%u",
                 pkt.header.seq_num,
                 (unsigned long)pkt.header.timestamp_ms,
                 pkt.payload.battery.mv,
                 pkt.payload.battery.soc_pct,
                 pkt.payload.battery.charging);
        break;
    case NARBIS_MSG_RAW_PPG:
        ESP_LOGI(TAG,
                 "RAW_PPG   seq=%u ts=%lu  rate=%u Hz  n=%u",
                 pkt.header.seq_num,
                 (unsigned long)pkt.header.timestamp_ms,
                 pkt.payload.raw_ppg.sample_rate_hz,
                 pkt.payload.raw_ppg.n_samples);
        break;
    case NARBIS_MSG_SQI:
        ESP_LOGI(TAG, "SQI       seq=%u ts=%lu  sqi=%u/100",
                 pkt.header.seq_num,
                 (unsigned long)pkt.header.timestamp_ms,
                 pkt.payload.sqi.sqi_x100);
        break;
    case NARBIS_MSG_HEARTBEAT:
        ESP_LOGI(TAG, "HEARTBEAT seq=%u ts=%lu  uptime=%lu s",
                 pkt.header.seq_num,
                 (unsigned long)pkt.header.timestamp_ms,
                 (unsigned long)pkt.payload.heartbeat.uptime_s);
        break;
    case NARBIS_MSG_CONFIG_ACK:
        ESP_LOGI(TAG, "CFG_ACK   seq=%u ts=%lu  status=%u",
                 pkt.header.seq_num,
                 (unsigned long)pkt.header.timestamp_ms,
                 pkt.payload.config_ack.status);
        break;
    default:
        ESP_LOGW(TAG, "unknown msg_type=0x%02x seq=%u",
                 pkt.header.msg_type, pkt.header.seq_num);
        break;
    }
}

static void wifi_bring_up(void)
{
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_start());
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE));
    ESP_ERROR_CHECK(esp_wifi_set_channel(RX_CHANNEL, WIFI_SECOND_CHAN_NONE));
}

void app_main(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    }

    wifi_bring_up();

    uint8_t mac[6];
    ESP_ERROR_CHECK(esp_wifi_get_mac(WIFI_IF_STA, mac));
    ESP_LOGI(TAG, "ready  ch=%d  my MAC: %02x:%02x:%02x:%02x:%02x:%02x",
             RX_CHANNEL,
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);

    ESP_ERROR_CHECK(esp_now_init());
    ESP_ERROR_CHECK(esp_now_register_recv_cb(on_recv));

    while (1) {
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}
