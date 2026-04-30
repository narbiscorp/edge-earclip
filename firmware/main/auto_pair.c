/*
 * auto_pair.c — discover the Edge glasses' STA MAC over ESP-NOW broadcast.
 *
 * State machine:
 *   IDLE → DISCOVERING → PAIRED       (success path)
 *   IDLE → DISCOVERING → FAILED       (timeout)
 *   PAIRED → DISCOVERING (via auto_pair_request_repair)
 *
 * The discovery task is a one-shot — it returns and self-deletes once
 * pairing succeeds or the retry budget is exhausted. The receive handler
 * stays registered for the life of the process so a future re-pair just
 * spawns a fresh task.
 */

#include "auto_pair.h"

#include <string.h>

#include "esp_err.h"
#include "esp_log.h"
#include "esp_now.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "config_manager.h"
#include "narbis_protocol.h"
#include "transport_espnow.h"

static const char *TAG = "auto_pair";

#define DISCOVER_INTERVAL_MS 1000u
#define DISCOVER_RETRIES     30u    /* ~30 s budget at 1 Hz */
#define FW_MAJOR             0
#define FW_MINOR             1

#define NOTIFY_BIT_OFFER     (1u << 0)

static const uint8_t BCAST_MAC[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

static volatile uint8_t s_state = AUTO_PAIR_STATE_IDLE;
static TaskHandle_t     s_disc_task;

/* Single in-flight nonce. Written by the discovery task, read by the
 * recv handler. Volatile is sufficient (no read-modify-write race). */
static volatile uint16_t s_pending_nonce;
static volatile uint8_t  s_offer_status;
static uint8_t           s_offer_src[6];

static void set_state(auto_pair_state_t s)
{
    auto_pair_state_t prev = (auto_pair_state_t)s_state;
    if (prev == s) return;
    s_state = (uint8_t)s;
    ESP_LOGI(TAG, "%d -> %d", (int)prev, (int)s);
}

/* Read partner_mac directly from NVS (config_get_partner_mac is cheap and
 * doesn't pull in the rest of config_manager's locking). */
static bool nvs_has_valid_partner(void)
{
    uint8_t mac[6];
    if (config_get_partner_mac(mac) != ESP_OK) return false;
    bool all_zero = true, all_ff = true;
    for (int i = 0; i < 6; i++) {
        if (mac[i] != 0x00) all_zero = false;
        if (mac[i] != 0xFF) all_ff = false;
    }
    return !(all_zero || all_ff);
}

/* ============================================================================
 * Receive path — invoked by transport_espnow on every successfully
 * deserialized frame. We only care about PAIR_OFFER while DISCOVERING.
 * ========================================================================= */

static void on_espnow_recv(const uint8_t src[6],
                           const narbis_packet_t *pkt,
                           void *ctx)
{
    (void)ctx;
    if (s_state != AUTO_PAIR_STATE_DISCOVERING) return;
    if (pkt->header.msg_type != NARBIS_MSG_PAIR_OFFER) return;
    if (pkt->payload.pair_offer.nonce != s_pending_nonce) {
        ESP_LOGD(TAG, "PAIR_OFFER nonce mismatch (got 0x%04x, expected 0x%04x)",
                 pkt->payload.pair_offer.nonce, s_pending_nonce);
        return;
    }

    s_offer_status = pkt->payload.pair_offer.status;
    memcpy(s_offer_src, src, 6);

    /* The ESP-NOW receive callback runs in the Wi-Fi task (not an ISR), so
     * the regular xTaskNotify is correct. */
    if (s_disc_task != NULL) {
        xTaskNotify(s_disc_task, NOTIFY_BIT_OFFER, eSetBits);
    }
}

/* ============================================================================
 * Discovery task
 * ========================================================================= */

static esp_err_t send_pair_discover(uint16_t nonce)
{
    uint8_t earclip_mac[6] = {0};
    (void)esp_wifi_get_mac(WIFI_IF_STA, earclip_mac);

    narbis_packet_t pkt = {0};
    pkt.header.msg_type     = NARBIS_MSG_PAIR_DISCOVER;
    pkt.header.device_id    = 0;
    pkt.header.timestamp_ms = (uint32_t)(esp_timer_get_time() / 1000);
    /* Bare seq numbering for pair frames — single sender, single receiver,
     * idempotent on the wire. Use the nonce so log lines correlate. */
    pkt.header.seq_num      = nonce;
    memcpy(pkt.payload.pair_discover.earclip_mac, earclip_mac, 6);
    pkt.payload.pair_discover.nonce    = nonce;
    pkt.payload.pair_discover.fw_major = FW_MAJOR;
    pkt.payload.pair_discover.fw_minor = FW_MINOR;

    uint8_t buf[NARBIS_MAX_FRAME_SIZE];
    size_t  out_len = 0;
    if (narbis_packet_serialize(buf, sizeof(buf), &pkt, &out_len) != 0) {
        return ESP_FAIL;
    }
    return esp_now_send(BCAST_MAC, buf, out_len);
}

static void discovery_task(void *arg)
{
    (void)arg;

    set_state(AUTO_PAIR_STATE_DISCOVERING);
    esp_err_t err = transport_espnow_add_peer(BCAST_MAC);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "add broadcast peer failed: %s", esp_err_to_name(err));
        set_state(AUTO_PAIR_STATE_FAILED);
        s_disc_task = NULL;
        vTaskDelete(NULL);
        return;
    }

    bool paired = false;
    for (uint32_t attempt = 0; attempt < DISCOVER_RETRIES; attempt++) {
        uint16_t nonce = (uint16_t)(esp_random() & 0xFFFFu);
        if (nonce == 0) nonce = 1;  /* keep 0 as sentinel (no pending) */
        s_pending_nonce = nonce;

        esp_err_t serr = send_pair_discover(nonce);
        if (serr != ESP_OK) {
            ESP_LOGW(TAG, "PAIR_DISCOVER send failed: %s",
                     esp_err_to_name(serr));
        } else {
            ESP_LOGI(TAG, "PAIR_DISCOVER #%lu nonce=0x%04x",
                     (unsigned long)attempt + 1, nonce);
        }

        uint32_t notify = 0;
        BaseType_t got = xTaskNotifyWait(0, NOTIFY_BIT_OFFER, &notify,
                                         pdMS_TO_TICKS(DISCOVER_INTERVAL_MS));
        if (got == pdPASS && (notify & NOTIFY_BIT_OFFER)) {
            uint8_t status = s_offer_status;
            uint8_t edge[6];
            memcpy(edge, s_offer_src, 6);

            if (status == NARBIS_PAIR_OFFER_OK) {
                ESP_LOGI(TAG,
                         "PAIR_OFFER ok from %02x:%02x:%02x:%02x:%02x:%02x",
                         edge[0], edge[1], edge[2], edge[3], edge[4], edge[5]);
                /* config_apply_partner_mac persists NVS, hot-swaps the live
                 * peer, and notifies the BLE CONFIG characteristic so the
                 * dashboard updates without polling. */
                err = config_apply_partner_mac(edge);
                if (err == ESP_OK) {
                    paired = true;
                    break;
                }
                ESP_LOGE(TAG, "config_apply_partner_mac failed: %s",
                         esp_err_to_name(err));
                /* Fall through to retry */
            } else {
                ESP_LOGW(TAG, "PAIR_OFFER status=%u — ignoring", status);
            }
        }
    }

    /* Cleanup: drop the broadcast peer so future sends only touch the
     * paired partner. Idempotent if not present. */
    s_pending_nonce = 0;
    (void)transport_espnow_remove_peer(BCAST_MAC);

    set_state(paired ? AUTO_PAIR_STATE_PAIRED : AUTO_PAIR_STATE_FAILED);
    s_disc_task = NULL;
    vTaskDelete(NULL);
}

/* ============================================================================
 * Public API
 * ========================================================================= */

esp_err_t auto_pair_init(void)
{
    /* Always register the recv handler — even if we're already paired,
     * a future auto_pair_request_repair() will need it without further
     * setup. transport_espnow_init must have run first. */
    transport_espnow_register_recv_handler(on_espnow_recv, NULL);

    if (nvs_has_valid_partner()) {
        set_state(AUTO_PAIR_STATE_PAIRED);
        ESP_LOGI(TAG, "partner already in NVS — skipping discovery");
        return ESP_OK;
    }

    if (s_disc_task != NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    BaseType_t ok = xTaskCreate(discovery_task, "auto_pair",
                                4096, NULL, 4, &s_disc_task);
    if (ok != pdPASS) {
        s_disc_task = NULL;
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

auto_pair_state_t auto_pair_current_state(void)
{
    return (auto_pair_state_t)s_state;
}

esp_err_t auto_pair_request_repair(void)
{
    if (s_disc_task != NULL) return ESP_ERR_INVALID_STATE;

    esp_err_t err = config_clear_pairing();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "clear_pairing: %s", esp_err_to_name(err));
        /* keep going — worst case we re-pair on top of the old MAC */
    }

    BaseType_t ok = xTaskCreate(discovery_task, "auto_pair",
                                4096, NULL, 4, &s_disc_task);
    if (ok != pdPASS) {
        s_disc_task = NULL;
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}
