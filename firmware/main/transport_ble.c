/*
 * transport_ble.c — NimBLE host bring-up, GAP, advertising, and the
 * consolidated GATT service table.
 *
 * Stage 06 wires up the four services (DIS, HRS, Battery, custom Narbis)
 * and exposes a small notify/subscribe helper to the rest of the firmware.
 * Each service module owns its characteristic definitions; this file
 * stitches them into a single ble_gatts_add_svcs() call.
 */

#include "transport_ble.h"

#include <stdbool.h>
#include <string.h>

#include "esp_err.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_hs.h"
#include "host/ble_hs_mbuf.h"
#include "host/ble_uuid.h"
#include "host/util/util.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

#include "ble_service_battery.h"
#include "ble_service_dis.h"
#include "ble_service_hrs.h"
#include "ble_service_narbis.h"

static const char *TAG = "transport_ble";

#define BLE_TRANSPORT_PREF_MTU      247
#define BLE_TRANSPORT_INVALID_CONN  0xFFFF

static uint8_t g_own_addr_type;
static uint16_t g_conn_handle = BLE_TRANSPORT_INVALID_CONN;
static uint16_t g_mtu;
static char g_device_name[32];

/* Subscription state per characteristic. Indexed by ble_subscription_t. */
static bool g_subscribed[BLE_SUB_COUNT];
static uint16_t g_val_handles[BLE_SUB_COUNT];

static int gap_event_handler(struct ble_gap_event *event, void *arg);
static void start_advertising(void);

/* ============================================================================
 * Subscription / handle bookkeeping (called from service modules during
 * gatts_register_cb)
 * ========================================================================= */

void transport_ble_set_val_handle(ble_subscription_t which, uint16_t val_handle)
{
    if ((unsigned)which < BLE_SUB_COUNT) {
        g_val_handles[which] = val_handle;
    }
}

uint16_t transport_ble_val_handle(ble_subscription_t which)
{
    if ((unsigned)which < BLE_SUB_COUNT) {
        return g_val_handles[which];
    }
    return 0;
}

bool transport_ble_is_subscribed(ble_subscription_t which)
{
    if ((unsigned)which >= BLE_SUB_COUNT) {
        return false;
    }
    return g_conn_handle != BLE_TRANSPORT_INVALID_CONN && g_subscribed[which];
}

uint16_t transport_ble_get_mtu(void)
{
    return g_mtu ? g_mtu : 23;
}

uint16_t transport_ble_get_conn_handle(void)
{
    return g_conn_handle;
}

/* ============================================================================
 * Profile application (connection params)
 * ========================================================================= */

esp_err_t transport_ble_set_profile(uint8_t ble_profile)
{
    if (g_conn_handle == BLE_TRANSPORT_INVALID_CONN) {
        return ESP_OK;  /* applies on next connect */
    }

    struct ble_gap_upd_params params = {0};
    if (ble_profile == NARBIS_BLE_LOW_LATENCY) {
        /* 12 * 1.25ms = 15ms .. 24 * 1.25ms = 30ms */
        params.itvl_min = 12;
        params.itvl_max = 24;
        params.latency  = 0;
        params.supervision_timeout = 200;  /* 2 s */
    } else {
        /* 40 * 1.25ms = 50ms .. 80 * 1.25ms = 100ms */
        params.itvl_min = 40;
        params.itvl_max = 80;
        params.latency  = 4;
        params.supervision_timeout = 400;  /* 4 s */
    }
    int rc = ble_gap_update_params(g_conn_handle, &params);
    if (rc != 0) {
        ESP_LOGW(TAG, "gap_update_params: rc=%d", rc);
        return ESP_FAIL;
    }
    ESP_LOGI(TAG, "profile %s applied (itvl=%u..%u lat=%u)",
             ble_profile == NARBIS_BLE_LOW_LATENCY ? "LOW_LATENCY" : "BATCHED",
             params.itvl_min, params.itvl_max, params.latency);
    return ESP_OK;
}

/* ============================================================================
 * Notify helper
 * ========================================================================= */

esp_err_t transport_ble_notify(ble_subscription_t which,
                               const uint8_t *data, uint16_t len)
{
    if (g_conn_handle == BLE_TRANSPORT_INVALID_CONN) return ESP_ERR_INVALID_STATE;
    if (!transport_ble_is_subscribed(which))         return ESP_OK;

    uint16_t val_handle = transport_ble_val_handle(which);
    if (val_handle == 0) return ESP_ERR_INVALID_STATE;

    struct os_mbuf *om = ble_hs_mbuf_from_flat(data, len);
    if (om == NULL) return ESP_ERR_NO_MEM;

    int rc = ble_gatts_notify_custom(g_conn_handle, val_handle, om);
    if (rc != 0) {
        ESP_LOGD(TAG, "notify rc=%d which=%d len=%u", rc, (int)which, len);
        return ESP_FAIL;
    }
    return ESP_OK;
}

/* ============================================================================
 * High-level sends — delegate to per-service push helpers
 * ========================================================================= */

esp_err_t transport_ble_send_beat(const beat_event_t *beat)
{
    if (beat == NULL) return ESP_ERR_INVALID_ARG;
    if (g_conn_handle == BLE_TRANSPORT_INVALID_CONN) return ESP_OK;

    ble_service_hrs_push_beat(beat);
    ble_service_narbis_push_ibi(beat);
    return ESP_OK;
}

esp_err_t transport_ble_send_raw_sample(const ppg_sample_t *sample,
                                        uint16_t sample_rate_hz,
                                        uint8_t data_format)
{
    if (sample == NULL) return ESP_ERR_INVALID_ARG;
    if (g_conn_handle == BLE_TRANSPORT_INVALID_CONN) return ESP_OK;
    if (data_format != NARBIS_DATA_RAW_PPG && data_format != NARBIS_DATA_IBI_PLUS_RAW) {
        return ESP_OK;
    }
    return ble_service_narbis_push_raw(sample, sample_rate_hz);
}

esp_err_t transport_ble_send_battery(uint8_t soc_pct, uint16_t mv, uint8_t charging)
{
    if (g_conn_handle == BLE_TRANSPORT_INVALID_CONN) return ESP_OK;
    ble_service_battery_push(soc_pct, mv, charging);
    return ESP_OK;
}

esp_err_t transport_ble_notify_config(void)
{
    return ble_service_narbis_notify_config();
}

/* ============================================================================
 * GAP / advertising
 * ========================================================================= */

static void format_device_name(void)
{
    uint8_t mac[6] = {0};
    (void)esp_read_mac(mac, ESP_MAC_BT);
    snprintf(g_device_name, sizeof(g_device_name),
             "Narbis Earclip %02X%02X%02X", mac[3], mac[4], mac[5]);
}

static void start_advertising(void)
{
    int rc;

    rc = ble_svc_gap_device_name_set(g_device_name);
    if (rc != 0) {
        ESP_LOGW(TAG, "gap_name_set rc=%d", rc);
    }

    struct ble_hs_adv_fields fields = {0};
    fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    fields.tx_pwr_lvl_is_present = 1;
    fields.tx_pwr_lvl = BLE_HS_ADV_TX_PWR_LVL_AUTO;
    fields.name = (uint8_t *)g_device_name;
    fields.name_len = strlen(g_device_name);
    fields.name_is_complete = 1;
    /* Advertise the Narbis primary service UUID so dashboard scan filters can match.
     * NARBIS_SVC_UUID_BYTES is a braced list, suitable for direct
     * .value aggregate-init of ble_uuid128_t. */
    static const ble_uuid128_t narbis_svc_uuid = {
        .u = { .type = BLE_UUID_TYPE_128 },
        .value = NARBIS_SVC_UUID_BYTES,
    };
    fields.uuids128 = (ble_uuid128_t *)&narbis_svc_uuid;
    fields.num_uuids128 = 1;
    fields.uuids128_is_complete = 0;  /* primary svc only; not the full list */

    rc = ble_gap_adv_set_fields(&fields);
    if (rc != 0) {
        ESP_LOGE(TAG, "adv_set_fields rc=%d", rc);
        return;
    }

    struct ble_gap_adv_params adv_params = {0};
    adv_params.conn_mode = BLE_GAP_CONN_MODE_UND;
    adv_params.disc_mode = BLE_GAP_DISC_MODE_GEN;
    /* Default interval (~1.28 s). Connection establishment is the
     * dominant cost; faster adv burns battery without much benefit. */

    rc = ble_gap_adv_start(g_own_addr_type, NULL, BLE_HS_FOREVER,
                           &adv_params, gap_event_handler, NULL);
    if (rc != 0) {
        ESP_LOGE(TAG, "adv_start rc=%d", rc);
        return;
    }
    ESP_LOGI(TAG, "advertising as \"%s\"", g_device_name);
}

static int gap_event_handler(struct ble_gap_event *event, void *arg)
{
    (void)arg;
    switch (event->type) {
    case BLE_GAP_EVENT_CONNECT:
        if (event->connect.status == 0) {
            g_conn_handle = event->connect.conn_handle;
            ESP_LOGI(TAG, "connected handle=%u", g_conn_handle);

            /* Negotiate higher MTU. */
            int rc = ble_gattc_exchange_mtu(g_conn_handle, NULL, NULL);
            if (rc != 0) {
                ESP_LOGW(TAG, "exchange_mtu rc=%d", rc);
            }

            /* Apply default profile params. The Narbis service updates this
             * later if the central writes MODE. */
            (void)transport_ble_set_profile(NARBIS_BLE_BATCHED);
        } else {
            ESP_LOGW(TAG, "connect failed status=%d", event->connect.status);
            start_advertising();
        }
        break;

    case BLE_GAP_EVENT_DISCONNECT:
        ESP_LOGI(TAG, "disconnected reason=0x%02x",
                 event->disconnect.reason);
        g_conn_handle = BLE_TRANSPORT_INVALID_CONN;
        g_mtu = 0;
        memset(g_subscribed, 0, sizeof(g_subscribed));
        start_advertising();
        break;

    case BLE_GAP_EVENT_MTU:
        g_mtu = event->mtu.value;
        ESP_LOGI(TAG, "MTU=%u", g_mtu);
        break;

    case BLE_GAP_EVENT_SUBSCRIBE: {
        uint16_t handle = event->subscribe.attr_handle;
        bool subscribed = event->subscribe.cur_notify || event->subscribe.cur_indicate;
        for (int i = 0; i < BLE_SUB_COUNT; i++) {
            if (g_val_handles[i] == handle) {
                g_subscribed[i] = subscribed;
                ESP_LOGI(TAG, "subscribe which=%d %s", i,
                         subscribed ? "on" : "off");
                break;
            }
        }
        break;
    }

    case BLE_GAP_EVENT_CONN_UPDATE:
        ESP_LOGI(TAG, "conn_update status=%d", event->conn_update.status);
        break;

    default:
        break;
    }
    return 0;
}

/* ============================================================================
 * Host sync / register callbacks
 * ========================================================================= */

static void on_sync(void)
{
    int rc = ble_hs_util_ensure_addr(0);
    if (rc != 0) {
        ESP_LOGE(TAG, "ensure_addr rc=%d", rc);
        return;
    }
    rc = ble_hs_id_infer_auto(0, &g_own_addr_type);
    if (rc != 0) {
        ESP_LOGE(TAG, "infer_auto rc=%d", rc);
        return;
    }

    format_device_name();

    /* Default ATT MTU we prefer when negotiating with the central. */
    (void)ble_att_set_preferred_mtu(BLE_TRANSPORT_PREF_MTU);

    start_advertising();
}

static void on_reset(int reason)
{
    ESP_LOGW(TAG, "host reset reason=%d", reason);
}

static void host_task(void *param)
{
    (void)param;
    nimble_port_run();
    nimble_port_freertos_deinit();
}

/* gatts_register_cb — service modules cache their value handles here via
 * transport_ble_set_val_handle when a characteristic with the matching UUID
 * is registered. */
static void on_gatts_register(struct ble_gatt_register_ctxt *ctxt, void *arg)
{
    (void)arg;

    if (ctxt->op == BLE_GATT_REGISTER_OP_CHR) {
        ble_service_dis_on_register(ctxt);
        ble_service_battery_on_register(ctxt);
        ble_service_hrs_on_register(ctxt);
        ble_service_narbis_on_register(ctxt);
    }
}

/* ============================================================================
 * Init
 * ========================================================================= */

esp_err_t transport_ble_init(void)
{
    g_conn_handle = BLE_TRANSPORT_INVALID_CONN;
    g_mtu = 0;
    memset(g_subscribed, 0, sizeof(g_subscribed));
    memset(g_val_handles, 0, sizeof(g_val_handles));

    esp_err_t err = nimble_port_init();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nimble_port_init: %s", esp_err_to_name(err));
        return err;
    }

    ble_hs_cfg.sync_cb = on_sync;
    ble_hs_cfg.reset_cb = on_reset;
    ble_hs_cfg.gatts_register_cb = on_gatts_register;

    /* Register standard GAP/GATT supporting services first. */
    ble_svc_gap_init();
    ble_svc_gatt_init();

    /* Now register Narbis services. Each module returns a service-def array;
     * we count them all into NimBLE's GATT table. */
    int rc;
    rc = ble_gatts_count_cfg(ble_service_dis_svc_defs());
    if (rc != 0) { ESP_LOGE(TAG, "count_cfg dis rc=%d", rc); return ESP_FAIL; }
    rc = ble_gatts_count_cfg(ble_service_battery_svc_defs());
    if (rc != 0) { ESP_LOGE(TAG, "count_cfg bat rc=%d", rc); return ESP_FAIL; }
    rc = ble_gatts_count_cfg(ble_service_hrs_svc_defs());
    if (rc != 0) { ESP_LOGE(TAG, "count_cfg hrs rc=%d", rc); return ESP_FAIL; }
    rc = ble_gatts_count_cfg(ble_service_narbis_svc_defs());
    if (rc != 0) { ESP_LOGE(TAG, "count_cfg narbis rc=%d", rc); return ESP_FAIL; }

    rc = ble_gatts_add_svcs(ble_service_dis_svc_defs());
    if (rc != 0) { ESP_LOGE(TAG, "add_svcs dis rc=%d", rc); return ESP_FAIL; }
    rc = ble_gatts_add_svcs(ble_service_battery_svc_defs());
    if (rc != 0) { ESP_LOGE(TAG, "add_svcs bat rc=%d", rc); return ESP_FAIL; }
    rc = ble_gatts_add_svcs(ble_service_hrs_svc_defs());
    if (rc != 0) { ESP_LOGE(TAG, "add_svcs hrs rc=%d", rc); return ESP_FAIL; }
    rc = ble_gatts_add_svcs(ble_service_narbis_svc_defs());
    if (rc != 0) { ESP_LOGE(TAG, "add_svcs narbis rc=%d", rc); return ESP_FAIL; }

    nimble_port_freertos_init(host_task);

    ESP_LOGI(TAG, "init complete");
    return ESP_OK;
}

esp_err_t transport_ble_deinit(void)
{
    return ESP_OK;
}
