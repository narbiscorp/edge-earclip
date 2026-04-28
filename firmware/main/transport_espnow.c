#include "transport_espnow.h"

#include <stdatomic.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_now.h"
#include "esp_timer.h"
#include "esp_wifi.h"

#include "app_state.h"
#include "config_manager.h"
#include "narbis_protocol.h"

static const char *TAG = "transport_espnow";

/* Helper macro: log + return on first non-ESP_OK. Local to this file so we
 * don't pull in esp_check.h's macros (which require additional plumbing). */
#define ESP_RETURN_ON_FAILURE_(call) do {                                \
    esp_err_t _err_rc = (call);                                          \
    if (_err_rc != ESP_OK) {                                             \
        ESP_LOGE(TAG, #call " failed: %s", esp_err_to_name(_err_rc));    \
        return _err_rc;                                                  \
    }                                                                    \
} while (0)

/* Resolved partner. partner_known stays 0 until init succeeds. */
static uint8_t      partner_mac[6];
static const char  *partner_source = "unset";
static bool         partner_known  = false;
static bool         transport_up   = false;

/* Per-message-type sequence counters. Each counter has a single writer
 * task in Stage 05: the beat task (IBI), the 30 s timer (BATTERY), and a
 * future raw-PPG task (RAW_PPG). HEARTBEAT is reserved for Stage 07.
 * Plain uint16_t is race-free under that one-writer-per-counter model. */
static uint16_t seq_ibi;
static uint16_t seq_raw;
static uint16_t seq_battery;

/* Send-callback stats. Updated from the Wi-Fi task; read by diagnostics. */
static atomic_uint tx_ok;
static atomic_uint tx_fail;

static void on_send(const esp_now_send_info_t *tx_info, esp_now_send_status_t status)
{
    (void)tx_info;
    if (status == ESP_NOW_SEND_SUCCESS) {
        atomic_fetch_add(&tx_ok, 1);
    } else {
        atomic_fetch_add(&tx_fail, 1);
        ESP_LOGD(TAG, "send fail (status=%d)", (int)status);
    }
}

static int parse_mac_str(const char *s, uint8_t out[6])
{
    if (s == NULL) return -1;
    unsigned int b[6] = {0};
    int n = sscanf(s, "%x:%x:%x:%x:%x:%x",
                   &b[0], &b[1], &b[2], &b[3], &b[4], &b[5]);
    if (n != 6) return -1;
    for (int i = 0; i < 6; i++) {
        if (b[i] > 0xFF) return -1;
        out[i] = (uint8_t)b[i];
    }
    return 0;
}

static esp_err_t add_peer(const uint8_t mac[6])
{
    esp_now_peer_info_t peer = {0};
    memcpy(peer.peer_addr, mac, 6);
    peer.channel = TRANSPORT_ESPNOW_DEFAULT_CHANNEL;
    peer.ifidx   = WIFI_IF_STA;
    peer.encrypt = false;
    return esp_now_add_peer(&peer);
}

static esp_err_t resolve_partner(void)
{
    /* Prefer the NVS-stored MAC. */
    esp_err_t err = config_get_partner_mac(partner_mac);
    if (err == ESP_OK) {
        partner_source = "nvs";
        partner_known  = true;
        return ESP_OK;
    }

#if CONFIG_NARBIS_HARDCODED_PARTNER_MAC
    if (parse_mac_str(CONFIG_NARBIS_HARDCODED_PARTNER_MAC_VAL, partner_mac) == 0) {
        partner_source = "kconfig";
        partner_known  = true;
        return ESP_OK;
    }
    ESP_LOGE(TAG, "could not parse CONFIG_NARBIS_HARDCODED_PARTNER_MAC_VAL=\"%s\"",
             CONFIG_NARBIS_HARDCODED_PARTNER_MAC_VAL);
#endif

    partner_source = "unset";
    partner_known  = false;
    return ESP_ERR_NOT_FOUND;
}

static esp_err_t wifi_bring_up(void)
{
    /* esp_netif_init / default event loop are process-wide and may already
     * be up if some other component (e.g. a future BLE↔Wi-Fi bridge) ran
     * first. Treat ESP_ERR_INVALID_STATE as "already done". */
    esp_err_t err = esp_netif_init();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        return err;
    }
    err = esp_event_loop_create_default();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        return err;
    }

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_RETURN_ON_FAILURE_(esp_wifi_init(&cfg));
    ESP_RETURN_ON_FAILURE_(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    ESP_RETURN_ON_FAILURE_(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_RETURN_ON_FAILURE_(esp_wifi_start());
    /* MIN_MODEM keeps modem-sleep available for power saving while still
     * keeping ESP-NOW responsive. NONE disables sleep entirely (worse
     * battery). */
    (void)esp_wifi_set_ps(WIFI_PS_MIN_MODEM);
    ESP_RETURN_ON_FAILURE_(esp_wifi_set_channel(TRANSPORT_ESPNOW_DEFAULT_CHANNEL,
                                                WIFI_SECOND_CHAN_NONE));
    return ESP_OK;
}

esp_err_t transport_espnow_init(void)
{
    if (transport_up) {
        return ESP_OK;
    }

    esp_err_t err = wifi_bring_up();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "wifi bring-up failed: %s", esp_err_to_name(err));
        return err;
    }

    err = esp_now_init();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_now_init failed: %s", esp_err_to_name(err));
        return err;
    }
    err = esp_now_register_send_cb(on_send);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "register_send_cb failed: %s", esp_err_to_name(err));
        return err;
    }

    err = resolve_partner();
    if (err == ESP_OK) {
        err = add_peer(partner_mac);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "add_peer failed: %s", esp_err_to_name(err));
            return err;
        }
        ESP_LOGI(TAG,
                 "peer added %02x:%02x:%02x:%02x:%02x:%02x ch=%d src=%s",
                 partner_mac[0], partner_mac[1], partner_mac[2],
                 partner_mac[3], partner_mac[4], partner_mac[5],
                 TRANSPORT_ESPNOW_DEFAULT_CHANNEL, partner_source);
    } else {
        ESP_LOGW(TAG, "no partner MAC available — sends will be dropped until "
                      "transport_espnow_set_partner() is called");
    }

    transport_up = true;
    return ESP_OK;
}

esp_err_t transport_espnow_deinit(void)
{
    if (!transport_up) {
        return ESP_OK;
    }
    esp_now_deinit();
    esp_wifi_stop();
    esp_wifi_deinit();
    transport_up  = false;
    partner_known = false;
    return ESP_OK;
}

esp_err_t transport_espnow_set_partner(const uint8_t mac[6])
{
    if (mac == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!transport_up) {
        return ESP_ERR_INVALID_STATE;
    }
    if (partner_known) {
        (void)esp_now_del_peer(partner_mac);
    }
    esp_err_t err = add_peer(mac);
    if (err != ESP_OK) {
        return err;
    }
    memcpy(partner_mac, mac, 6);
    partner_source = "runtime";
    partner_known  = true;

    /* Persist so the new pairing survives reboot. NVS failure is logged
     * but does not invalidate the live peer entry. */
    esp_err_t nvs_err = config_set_partner_mac(mac);
    if (nvs_err != ESP_OK) {
        ESP_LOGW(TAG, "set_partner: NVS persist failed: %s",
                 esp_err_to_name(nvs_err));
    }
    return ESP_OK;
}

esp_err_t transport_espnow_get_partner_info(uint8_t mac[6], const char **source)
{
    if (mac == NULL || source == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!transport_up) {
        return ESP_ERR_INVALID_STATE;
    }
    if (!partner_known) {
        memset(mac, 0, 6);
        *source = partner_source;  /* "unset" */
        return ESP_ERR_NOT_FOUND;
    }
    memcpy(mac, partner_mac, 6);
    *source = partner_source;
    return ESP_OK;
}

/* Build header + serialize + send. Sequence counter is bumped before
 * serialize. Returns esp_now_send's status (ESP_OK = queued, async cb
 * reports actual delivery). */
static esp_err_t send_packet(narbis_packet_t *pkt, uint16_t *seq_ctr)
{
    if (!transport_up || !partner_known) {
        return ESP_ERR_INVALID_STATE;
    }
    /* Quiesce ESP-NOW during OTA. The radio still belongs to BLE during
     * a DFU session, but Wi-Fi/BLE coexistence is unfriendly to bursts
     * here — and there's no point sending stale beats while we're
     * mid-flash. app_state_current() is a single volatile read. */
    if (app_state_current() == APP_STATE_OTA_UPDATING) {
        return ESP_ERR_INVALID_STATE;
    }
    pkt->header.device_id        = 0;
    pkt->header.seq_num          = ++(*seq_ctr);
    pkt->header.timestamp_ms     = (uint32_t)(esp_timer_get_time() / 1000);
    pkt->header.payload_len      = 0;  /* auto-filled by serialize */
    pkt->header.protocol_version = 0;  /* auto-filled by serialize */
    pkt->header.reserved         = 0;

    uint8_t buf[NARBIS_MAX_FRAME_SIZE];
    size_t out_len = 0;
    int rc = narbis_packet_serialize(buf, sizeof(buf), pkt, &out_len);
    if (rc != 0) {
        ESP_LOGE(TAG, "serialize failed: %d (msg_type=0x%02x)", rc,
                 pkt->header.msg_type);
        return ESP_ERR_INVALID_SIZE;
    }
    return esp_now_send(partner_mac, buf, out_len);
}

esp_err_t transport_espnow_send_beat(const beat_event_t *beat)
{
    if (beat == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    narbis_packet_t pkt = {0};
    pkt.header.msg_type           = NARBIS_MSG_IBI;
    pkt.payload.ibi.ibi_ms          = beat->ibi_ms;
    pkt.payload.ibi.confidence_x100 = beat->confidence_x100;
    pkt.payload.ibi.flags           = beat->flags;
    return send_packet(&pkt, &seq_ibi);
}

esp_err_t transport_espnow_send_raw_sample(const narbis_raw_ppg_payload_t *batch)
{
    if (batch == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    if (batch->n_samples > NARBIS_RAW_PPG_MAX_SAMPLES) {
        return ESP_ERR_INVALID_SIZE;
    }
    narbis_packet_t pkt = {0};
    pkt.header.msg_type = NARBIS_MSG_RAW_PPG;
    memcpy(&pkt.payload.raw_ppg, batch, sizeof(*batch));
    return send_packet(&pkt, &seq_raw);
}

esp_err_t transport_espnow_send_battery(uint8_t soc_pct, uint16_t mv, uint8_t charging)
{
    narbis_packet_t pkt = {0};
    pkt.header.msg_type      = NARBIS_MSG_BATTERY;
    pkt.payload.battery.mv       = mv;
    pkt.payload.battery.soc_pct  = soc_pct;
    pkt.payload.battery.charging = charging;
    return send_packet(&pkt, &seq_battery);
}
