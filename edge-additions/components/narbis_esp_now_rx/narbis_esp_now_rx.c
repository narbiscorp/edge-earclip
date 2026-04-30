/*
 * narbis_esp_now_rx.c — ESP-NOW receiver for the Edge firmware.
 *
 * Productionizes the bring-up fixture in
 *   firmware/test/espnow_receiver_fixture/main/main.c
 * with: peer-MAC filtering, NVS-with-Kconfig-fallback partner resolution,
 * a queue-decoupled worker so the ESP-NOW callback returns quickly, a
 * user beat callback, and stats counters.
 *
 * Wire format / NVS layout / Kconfig flag names match the earclip exactly
 * — see narbis_protocol.h, the earclip's config_manager.c, and the
 * earclip's Kconfig.projbuild. Do not diverge.
 */

#include "narbis_esp_now_rx.h"

#include <string.h>

#include "esp_err.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_now.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "sdkconfig.h"

#include "narbis_protocol.h"

#define NVS_NS_PAIR     "narbis_pair"
#define NVS_KEY_PARTNER "partner_mac"

#ifndef NARBIS_RX_CHANNEL
#define NARBIS_RX_CHANNEL 1  /* must match the earclip's CONFIG_NARBIS_ESPNOW_CHANNEL */
#endif

#define RX_QUEUE_DEPTH    16
#define WORKER_STACK_SIZE 4096
#define WORKER_PRIORITY   5

static const char *TAG = "narbis_rx";

typedef struct {
    uint8_t src_addr[6];
    size_t  len;
    uint8_t buf[NARBIS_MAX_FRAME_SIZE];
} rx_item_t;

static narbis_beat_cb_t s_beat_cb;
static void            *s_beat_ctx;

static uint8_t  s_partner_mac[6];
static uint8_t  s_partner_known;   /* 0/1 */
static const char *s_partner_source = "unset";

static QueueHandle_t s_rx_queue;
static TaskHandle_t  s_worker_task;

static narbis_esp_now_rx_stats_t s_stats;

/* Sequence counter for PAIR_OFFER replies. Single writer (worker task). */
static uint16_t s_seq_pair_offer;

/* ------------------------------------------------------------------- */
/* Helpers                                                              */
/* ------------------------------------------------------------------- */

static int hex_nibble(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static int parse_mac_str(const char *s, uint8_t out[6])
{
    if (s == NULL) return -1;
    /* Accept "AA:BB:CC:DD:EE:FF" — six octets separated by ':'. */
    for (int i = 0; i < 6; i++) {
        int hi = hex_nibble(s[i * 3 + 0]);
        int lo = hex_nibble(s[i * 3 + 1]);
        if (hi < 0 || lo < 0) return -1;
        if (i < 5 && s[i * 3 + 2] != ':') return -1;
        out[i] = (uint8_t)((hi << 4) | lo);
    }
    if (s[17] != '\0') return -1;
    return 0;
}

static int mac_is_zero(const uint8_t mac[6])
{
    for (int i = 0; i < 6; i++) {
        if (mac[i] != 0) return 0;
    }
    return 1;
}

static esp_err_t nvs_read_partner(uint8_t out[6])
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NS_PAIR, NVS_READONLY, &h);
    if (err != ESP_OK) return err;

    size_t sz = 6;
    err = nvs_get_blob(h, NVS_KEY_PARTNER, out, &sz);
    nvs_close(h);
    if (err != ESP_OK) return err;
    if (sz != 6 || mac_is_zero(out)) return ESP_ERR_NOT_FOUND;
    return ESP_OK;
}

static esp_err_t nvs_write_partner(const uint8_t mac[6])
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NS_PAIR, NVS_READWRITE, &h);
    if (err != ESP_OK) return err;
    err = nvs_set_blob(h, NVS_KEY_PARTNER, mac, 6);
    if (err == ESP_OK) {
        err = nvs_commit(h);
    }
    nvs_close(h);
    return err;
}

static esp_err_t nvs_erase_partner(void)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NS_PAIR, NVS_READWRITE, &h);
    if (err != ESP_OK) return err;
    err = nvs_erase_key(h, NVS_KEY_PARTNER);
    if (err == ESP_OK || err == ESP_ERR_NVS_NOT_FOUND) {
        (void)nvs_commit(h);
        err = ESP_OK;
    }
    nvs_close(h);
    return err;
}

static esp_err_t resolve_partner(void)
{
    if (nvs_read_partner(s_partner_mac) == ESP_OK) {
        s_partner_source = "nvs";
        s_partner_known  = 1;
        return ESP_OK;
    }

#if CONFIG_NARBIS_HARDCODED_PARTNER_MAC
    if (parse_mac_str(CONFIG_NARBIS_HARDCODED_PARTNER_MAC_VAL, s_partner_mac) == 0
        && !mac_is_zero(s_partner_mac)) {
        s_partner_source = "kconfig";
        s_partner_known  = 1;
        return ESP_OK;
    }
    ESP_LOGE(TAG, "could not parse CONFIG_NARBIS_HARDCODED_PARTNER_MAC_VAL=\"%s\"",
             CONFIG_NARBIS_HARDCODED_PARTNER_MAC_VAL);
#endif

    s_partner_source = "unset";
    s_partner_known  = 0;
    return ESP_ERR_NOT_FOUND;
}

static esp_err_t add_peer(const uint8_t mac[6])
{
    esp_now_peer_info_t peer = {0};
    memcpy(peer.peer_addr, mac, 6);
    peer.channel = NARBIS_RX_CHANNEL;
    peer.ifidx   = WIFI_IF_STA;
    peer.encrypt = false;
    return esp_now_add_peer(&peer);
}

static esp_err_t wifi_bring_up(void)
{
    /* Edge may already have netif / event loop up. Tolerate that. */
    esp_err_t err = esp_netif_init();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return err;

    err = esp_event_loop_create_default();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return err;

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    err = esp_wifi_init(&cfg);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return err;

    err = esp_wifi_set_storage(WIFI_STORAGE_RAM);
    if (err != ESP_OK) return err;

    err = esp_wifi_set_mode(WIFI_MODE_STA);
    if (err != ESP_OK) return err;

    err = esp_wifi_start();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return err;

    /* Edge runs on glasses with a larger battery than the earclip — keep
     * the radio fully awake so RX latency is minimised. */
    (void)esp_wifi_set_ps(WIFI_PS_NONE);

    err = esp_wifi_set_channel(NARBIS_RX_CHANNEL, WIFI_SECOND_CHAN_NONE);
    if (err != ESP_OK) return err;

    return ESP_OK;
}

/* ------------------------------------------------------------------- */
/* ESP-NOW callback (short context — copy + enqueue only)               */
/* ------------------------------------------------------------------- */

static void on_recv(const esp_now_recv_info_t *info, const uint8_t *data, int len)
{
    if (info == NULL || data == NULL || len <= 0 || (size_t)len > NARBIS_MAX_FRAME_SIZE) {
        return;
    }

    s_stats.rx_total++;

    /* Auto-pair bypass: PAIR_DISCOVER frames may arrive from a sender we
     * don't (yet) know, so skip the partner-MAC filter for that one
     * msg_type. The worker task does the full validation (CRC + length)
     * and the policy decision (accept new pairing vs. ignore stranger).
     * Header byte 0 is msg_type — see narbis_header_t in narbis_protocol.h. */
    bool is_pair_discover = ((size_t)len >= NARBIS_HEADER_SIZE)
        && (data[0] == NARBIS_MSG_PAIR_DISCOVER);

    if (!is_pair_discover) {
        if (!s_partner_known || memcmp(info->src_addr, s_partner_mac, 6) != 0) {
            s_stats.rx_wrong_peer++;
            return;
        }
    }

    rx_item_t item;
    memcpy(item.src_addr, info->src_addr, 6);
    item.len = (size_t)len;
    memcpy(item.buf, data, item.len);

    /* ESP-NOW recv callback runs in the Wi-Fi task, not in ISR context, so
     * xQueueSend is correct here. We pass timeout 0 — dropping a frame is
     * preferable to blocking the Wi-Fi task. */
    if (xQueueSend(s_rx_queue, &item, 0) != pdPASS) {
        s_stats.rx_queue_full++;
    }
}

/* ------------------------------------------------------------------- */
/* Auto-pair: reply to PAIR_DISCOVER with PAIR_OFFER                    */
/* ------------------------------------------------------------------- */

static esp_err_t send_pair_offer(const uint8_t dst[6], uint16_t nonce, uint8_t status)
{
    narbis_packet_t pkt = {0};
    pkt.header.msg_type     = NARBIS_MSG_PAIR_OFFER;
    pkt.header.device_id    = 0;
    pkt.header.seq_num      = ++s_seq_pair_offer;
    pkt.header.timestamp_ms = (uint32_t)(esp_timer_get_time() / 1000);
    pkt.payload.pair_offer.nonce    = nonce;
    pkt.payload.pair_offer.status   = status;
    pkt.payload.pair_offer.reserved = 0;

    uint8_t buf[NARBIS_MAX_FRAME_SIZE];
    size_t  out_len = 0;
    if (narbis_packet_serialize(buf, sizeof(buf), &pkt, &out_len) != 0) {
        return ESP_FAIL;
    }
    return esp_now_send(dst, buf, out_len);
}

/* Decide whether to accept this PAIR_DISCOVER. Sticky-pair policy in v1:
 * accept iff unpaired or sender == current partner (idempotent re-pair).
 * A foreign PAIR_DISCOVER while paired is silently dropped — we don't
 * even reply BUSY, to avoid leaking pairing state. */
static void handle_pair_discover(const uint8_t src_addr[6],
                                 const narbis_pair_discover_payload_t *p)
{
    if (s_partner_known && memcmp(src_addr, s_partner_mac, 6) != 0) {
        s_stats.rx_pair_rejected++;
        ESP_LOGW(TAG,
                 "PAIR_DISCOVER from %02x:%02x:%02x:%02x:%02x:%02x rejected "
                 "(already paired with %02x:%02x:%02x:%02x:%02x:%02x)",
                 src_addr[0], src_addr[1], src_addr[2],
                 src_addr[3], src_addr[4], src_addr[5],
                 s_partner_mac[0], s_partner_mac[1], s_partner_mac[2],
                 s_partner_mac[3], s_partner_mac[4], s_partner_mac[5]);
        return;
    }

    /* Persist + add as ESP-NOW peer (idempotent if same MAC). */
    esp_err_t err = narbis_esp_now_rx_set_partner(src_addr);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "set_partner from PAIR_DISCOVER failed: %s",
                 esp_err_to_name(err));
        return;
    }

    s_stats.rx_pair_discover++;
    ESP_LOGI(TAG,
             "PAIR_DISCOVER nonce=0x%04x fw=%u.%u from %02x:%02x:%02x:%02x:%02x:%02x — paired",
             p->nonce, p->fw_major, p->fw_minor,
             src_addr[0], src_addr[1], src_addr[2],
             src_addr[3], src_addr[4], src_addr[5]);

    err = send_pair_offer(src_addr, p->nonce, NARBIS_PAIR_OFFER_OK);
    if (err == ESP_OK) {
        s_stats.tx_pair_offer++;
    } else {
        s_stats.tx_pair_offer_err++;
        ESP_LOGW(TAG, "send PAIR_OFFER failed: %s", esp_err_to_name(err));
    }
}

/* ------------------------------------------------------------------- */
/* Worker task                                                          */
/* ------------------------------------------------------------------- */

static void worker_task(void *arg)
{
    (void)arg;
    rx_item_t item;
    narbis_packet_t pkt;

    while (1) {
        if (xQueueReceive(s_rx_queue, &item, portMAX_DELAY) != pdPASS) continue;

        int rc = narbis_packet_deserialize(item.buf, item.len, &pkt);
        if (rc != 0) {
            s_stats.rx_bad_frame++;
            ESP_LOGW(TAG, "deserialize failed rc=%d len=%u", rc, (unsigned)item.len);
            continue;
        }

        switch ((narbis_msg_type_t)pkt.header.msg_type) {
        case NARBIS_MSG_PAIR_DISCOVER:
            handle_pair_discover(item.src_addr, &pkt.payload.pair_discover);
            break;
        case NARBIS_MSG_IBI: {
            s_stats.rx_ibi++;
            ESP_LOGI(TAG,
                     "IBI       seq=%u ts=%lu  ibi=%u ms  conf=%u  flags=0x%02x",
                     pkt.header.seq_num,
                     (unsigned long)pkt.header.timestamp_ms,
                     pkt.payload.ibi.ibi_ms,
                     pkt.payload.ibi.confidence_x100,
                     pkt.payload.ibi.flags);
            if (s_beat_cb != NULL) {
                narbis_beat_event_t evt = {
                    .ibi_ms          = pkt.payload.ibi.ibi_ms,
                    .confidence_x100 = pkt.payload.ibi.confidence_x100,
                    .flags           = pkt.payload.ibi.flags,
                    .seq_num         = pkt.header.seq_num,
                    .timestamp_ms    = pkt.header.timestamp_ms,
                };
                s_beat_cb(&evt, s_beat_ctx);
            }
            break;
        }
        case NARBIS_MSG_BATTERY:
            s_stats.rx_other++;
            ESP_LOGI(TAG,
                     "BATTERY   seq=%u ts=%lu  mv=%u  soc=%u%%  charging=%u",
                     pkt.header.seq_num,
                     (unsigned long)pkt.header.timestamp_ms,
                     pkt.payload.battery.mv,
                     pkt.payload.battery.soc_pct,
                     pkt.payload.battery.charging);
            break;
        case NARBIS_MSG_RAW_PPG:
            s_stats.rx_other++;
            ESP_LOGI(TAG,
                     "RAW_PPG   seq=%u ts=%lu  rate=%u Hz  n=%u",
                     pkt.header.seq_num,
                     (unsigned long)pkt.header.timestamp_ms,
                     pkt.payload.raw_ppg.sample_rate_hz,
                     pkt.payload.raw_ppg.n_samples);
            break;
        case NARBIS_MSG_SQI:
            s_stats.rx_other++;
            ESP_LOGI(TAG, "SQI       seq=%u ts=%lu  sqi=%u/100",
                     pkt.header.seq_num,
                     (unsigned long)pkt.header.timestamp_ms,
                     pkt.payload.sqi.sqi_x100);
            break;
        case NARBIS_MSG_HEARTBEAT:
            s_stats.rx_other++;
            ESP_LOGI(TAG, "HEARTBEAT seq=%u ts=%lu  uptime=%lu s",
                     pkt.header.seq_num,
                     (unsigned long)pkt.header.timestamp_ms,
                     (unsigned long)pkt.payload.heartbeat.uptime_s);
            break;
        case NARBIS_MSG_CONFIG_ACK:
            s_stats.rx_other++;
            ESP_LOGI(TAG, "CFG_ACK   seq=%u ts=%lu  status=%u",
                     pkt.header.seq_num,
                     (unsigned long)pkt.header.timestamp_ms,
                     pkt.payload.config_ack.status);
            break;
        default:
            s_stats.rx_other++;
            ESP_LOGW(TAG, "unknown msg_type=0x%02x seq=%u",
                     pkt.header.msg_type, pkt.header.seq_num);
            break;
        }
    }
}

/* ------------------------------------------------------------------- */
/* Public API                                                           */
/* ------------------------------------------------------------------- */

esp_err_t narbis_esp_now_rx_init(narbis_beat_cb_t cb, void *ctx)
{
    s_beat_cb  = cb;
    s_beat_ctx = ctx;

    esp_err_t err = wifi_bring_up();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "wifi bring-up failed: %s", esp_err_to_name(err));
        return err;
    }

    uint8_t wifi_mac[6] = {0};
    if (esp_wifi_get_mac(WIFI_IF_STA, wifi_mac) == ESP_OK) {
        ESP_LOGI(TAG, "WIFI_STA_MAC: %02x:%02x:%02x:%02x:%02x:%02x",
                 wifi_mac[0], wifi_mac[1], wifi_mac[2],
                 wifi_mac[3], wifi_mac[4], wifi_mac[5]);
    }
    uint8_t ble_mac[6] = {0};
    if (esp_read_mac(ble_mac, ESP_MAC_BT) == ESP_OK) {
        ESP_LOGI(TAG, "BLE_MAC:      %02x:%02x:%02x:%02x:%02x:%02x",
                 ble_mac[0], ble_mac[1], ble_mac[2],
                 ble_mac[3], ble_mac[4], ble_mac[5]);
    }

    err = esp_now_init();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGE(TAG, "esp_now_init failed: %s", esp_err_to_name(err));
        return err;
    }

    err = esp_now_register_recv_cb(on_recv);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_now_register_recv_cb failed: %s", esp_err_to_name(err));
        return err;
    }

    s_rx_queue = xQueueCreate(RX_QUEUE_DEPTH, sizeof(rx_item_t));
    if (s_rx_queue == NULL) return ESP_ERR_NO_MEM;

    BaseType_t ok = xTaskCreate(worker_task, "narbis_rx_wk",
                                WORKER_STACK_SIZE, NULL,
                                WORKER_PRIORITY, &s_worker_task);
    if (ok != pdPASS) return ESP_ERR_NO_MEM;

    err = resolve_partner();
    if (err == ESP_OK) {
        esp_err_t add_err = add_peer(s_partner_mac);
        if (add_err != ESP_OK && add_err != ESP_ERR_ESPNOW_EXIST) {
            ESP_LOGE(TAG, "add_peer failed: %s", esp_err_to_name(add_err));
            return add_err;
        }
        ESP_LOGI(TAG, "partner (%s) %02x:%02x:%02x:%02x:%02x:%02x  ch=%d",
                 s_partner_source,
                 s_partner_mac[0], s_partner_mac[1], s_partner_mac[2],
                 s_partner_mac[3], s_partner_mac[4], s_partner_mac[5],
                 NARBIS_RX_CHANNEL);
    } else {
        ESP_LOGW(TAG, "no partner MAC configured — receiver inert until set_partner()");
    }

    return ESP_OK;
}

esp_err_t narbis_esp_now_rx_set_partner(const uint8_t mac[6])
{
    if (mac == NULL || mac_is_zero(mac)) return ESP_ERR_INVALID_ARG;

    esp_err_t err = nvs_write_partner(mac);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nvs write partner failed: %s", esp_err_to_name(err));
        return err;
    }

    if (s_partner_known) {
        (void)esp_now_del_peer(s_partner_mac);
    }
    memcpy(s_partner_mac, mac, 6);
    s_partner_known  = 1;
    s_partner_source = "nvs";

    err = add_peer(s_partner_mac);
    if (err != ESP_OK && err != ESP_ERR_ESPNOW_EXIST) return err;

    ESP_LOGI(TAG, "partner updated (nvs) %02x:%02x:%02x:%02x:%02x:%02x",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    return ESP_OK;
}

esp_err_t narbis_esp_now_rx_clear_partner(void)
{
    esp_err_t err = nvs_erase_partner();
    if (err != ESP_OK) return err;

    if (s_partner_known) {
        (void)esp_now_del_peer(s_partner_mac);
    }
    memset(s_partner_mac, 0, 6);
    s_partner_known  = 0;
    s_partner_source = "unset";
    ESP_LOGW(TAG, "partner cleared — receiver inert");
    return ESP_OK;
}

esp_err_t narbis_esp_now_rx_get_partner(uint8_t out_mac[6])
{
    if (out_mac == NULL) return ESP_ERR_INVALID_ARG;
    if (!s_partner_known) return ESP_ERR_NOT_FOUND;
    memcpy(out_mac, s_partner_mac, 6);
    return ESP_OK;
}

void narbis_esp_now_rx_get_stats(narbis_esp_now_rx_stats_t *out)
{
    if (out == NULL) return;
    *out = s_stats;
}
