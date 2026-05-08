/*
 * transport_ble.c — NimBLE host bring-up, GAP, advertising, and the
 * consolidated GATT service table.
 *
 * Multi-central: the earclip accepts up to NARBIS_BLE_MAX_CONNECTIONS
 * simultaneous centrals (dashboard + glasses, plus a debug slot).
 * Per-connection state (handle, subscriptions, role) lives in fixed-size
 * slot arrays indexed 0..NARBIS_BLE_MAX_CONNECTIONS-1.
 */

#include "transport_ble.h"

#include <stdbool.h>
#include <string.h>

#include "esp_err.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_hs.h"
#include "host/ble_hs_mbuf.h"
#include "host/ble_uuid.h"
#include "host/util/util.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

#include "ble_ota.h"
#include "ble_service_battery.h"
#include "ble_service_dis.h"
#include "ble_service_hrs.h"
#include "ble_service_narbis.h"
#include "power_mgmt.h"

static const char *TAG = "transport_ble";

#define BLE_TRANSPORT_PREF_MTU      247
#define BLE_TRANSPORT_INVALID_CONN  0xFFFF

/* Per-connection slot. handle == BLE_TRANSPORT_INVALID_CONN means free. */
typedef struct {
    uint16_t            handle;
    uint16_t            mtu;
    narbis_peer_role_t  role;
    bool                subscribed[BLE_SUB_COUNT];
} ble_slot_t;

static uint8_t g_own_addr_type;
static char    g_device_name[32];
static ble_slot_t g_slots[NARBIS_BLE_MAX_CONNECTIONS];

/* Value handles are global (one set per characteristic, populated when
 * the GATT services register). Subscriptions are per-slot. */
static uint16_t g_val_handles[BLE_SUB_COUNT];

static SemaphoreHandle_t g_first_connect_sem;
static bool              g_first_connect_seen;
static bool              g_advertising;

static int  gap_event_handler(struct ble_gap_event *event, void *arg);
static void start_advertising_if_room(void);

/* ============================================================================
 * Slot helpers
 * ========================================================================= */

static int find_slot_by_handle(uint16_t handle)
{
    if (handle == BLE_TRANSPORT_INVALID_CONN) return -1;
    for (int i = 0; i < NARBIS_BLE_MAX_CONNECTIONS; i++) {
        if (g_slots[i].handle == handle) return i;
    }
    return -1;
}

static int find_free_slot(void)
{
    for (int i = 0; i < NARBIS_BLE_MAX_CONNECTIONS; i++) {
        if (g_slots[i].handle == BLE_TRANSPORT_INVALID_CONN) return i;
    }
    return -1;
}

static int active_slot_count(void)
{
    int n = 0;
    for (int i = 0; i < NARBIS_BLE_MAX_CONNECTIONS; i++) {
        if (g_slots[i].handle != BLE_TRANSPORT_INVALID_CONN) n++;
    }
    return n;
}

static void clear_slot(int idx)
{
    g_slots[idx].handle = BLE_TRANSPORT_INVALID_CONN;
    g_slots[idx].mtu    = 0;
    g_slots[idx].role   = NARBIS_PEER_ROLE_UNKNOWN;
    memset(g_slots[idx].subscribed, 0, sizeof(g_slots[idx].subscribed));
}

/* ============================================================================
 * Subscription / handle bookkeeping
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
    if ((unsigned)which >= BLE_SUB_COUNT) return false;
    for (int i = 0; i < NARBIS_BLE_MAX_CONNECTIONS; i++) {
        if (g_slots[i].handle != BLE_TRANSPORT_INVALID_CONN &&
            g_slots[i].subscribed[which]) {
            return true;
        }
    }
    return false;
}

uint16_t transport_ble_get_mtu(void)
{
    uint16_t lowest = 0;
    for (int i = 0; i < NARBIS_BLE_MAX_CONNECTIONS; i++) {
        if (g_slots[i].handle == BLE_TRANSPORT_INVALID_CONN) continue;
        uint16_t m = g_slots[i].mtu ? g_slots[i].mtu : 23;
        if (lowest == 0 || m < lowest) lowest = m;
    }
    return lowest ? lowest : 23;
}

bool transport_ble_any_connected(void)
{
    return active_slot_count() > 0;
}

uint8_t transport_ble_active_peer_count(void)
{
    int n = active_slot_count();
    if (n < 0) n = 0;
    if (n > 255) n = 255;
    return (uint8_t)n;
}

uint16_t transport_ble_get_conn_handle(void)
{
    for (int i = 0; i < NARBIS_BLE_MAX_CONNECTIONS; i++) {
        if (g_slots[i].handle != BLE_TRANSPORT_INVALID_CONN) {
            return g_slots[i].handle;
        }
    }
    return BLE_TRANSPORT_INVALID_CONN;
}

/* ============================================================================
 * Profile application (connection params)
 * ========================================================================= */

static void params_for_profile(uint8_t ble_profile, struct ble_gap_upd_params *p)
{
    memset(p, 0, sizeof(*p));
    if (ble_profile == NARBIS_BLE_LOW_LATENCY) {
        p->itvl_min = 12;   /* 15 ms */
        p->itvl_max = 24;   /* 30 ms */
        p->latency  = 0;
        p->supervision_timeout = 200;
    } else {
        p->itvl_min = 40;   /* 50 ms */
        p->itvl_max = 80;   /* 100 ms */
        p->latency  = 4;
        p->supervision_timeout = 400;
    }
}

static esp_err_t apply_profile_to_handle(uint16_t handle, uint8_t ble_profile)
{
    struct ble_gap_upd_params params;
    params_for_profile(ble_profile, &params);
    int rc = ble_gap_update_params(handle, &params);
    if (rc != 0) {
        ESP_LOGW(TAG, "gap_update_params handle=%u rc=%d", handle, rc);
        return ESP_FAIL;
    }
    ESP_LOGI(TAG, "profile %s applied to handle=%u",
             ble_profile == NARBIS_BLE_LOW_LATENCY ? "LOW_LATENCY" : "BATCHED",
             handle);
    return ESP_OK;
}

esp_err_t transport_ble_set_profile(uint8_t ble_profile)
{
    if (active_slot_count() == 0) return ESP_OK;
    esp_err_t any_err = ESP_OK;
    for (int i = 0; i < NARBIS_BLE_MAX_CONNECTIONS; i++) {
        if (g_slots[i].handle == BLE_TRANSPORT_INVALID_CONN) continue;
        esp_err_t e = apply_profile_to_handle(g_slots[i].handle, ble_profile);
        if (e != ESP_OK) any_err = e;
    }
    return any_err;
}

esp_err_t transport_ble_set_peer_role(uint16_t conn_handle, narbis_peer_role_t role)
{
    int slot = find_slot_by_handle(conn_handle);
    if (slot < 0) return ESP_ERR_NOT_FOUND;
    g_slots[slot].role = role;
    ESP_LOGI(TAG, "peer slot=%d handle=%u role=%d", slot, conn_handle, (int)role);
    uint8_t profile = (role == NARBIS_PEER_ROLE_DASHBOARD)
                        ? NARBIS_BLE_LOW_LATENCY
                        : NARBIS_BLE_BATCHED;
    return apply_profile_to_handle(conn_handle, profile);
}

/* ============================================================================
 * Notify helper — fan out to every subscribed peer
 * ========================================================================= */

esp_err_t transport_ble_notify(ble_subscription_t which,
                               const uint8_t *data, uint16_t len)
{
    if ((unsigned)which >= BLE_SUB_COUNT) return ESP_ERR_INVALID_ARG;
    uint16_t val_handle = g_val_handles[which];
    if (val_handle == 0) return ESP_ERR_INVALID_STATE;

    esp_err_t any_err = ESP_OK;
    bool sent_any = false;
    for (int i = 0; i < NARBIS_BLE_MAX_CONNECTIONS; i++) {
        if (g_slots[i].handle == BLE_TRANSPORT_INVALID_CONN) continue;
        if (!g_slots[i].subscribed[which]) continue;

        struct os_mbuf *om = ble_hs_mbuf_from_flat(data, len);
        if (om == NULL) {
            any_err = ESP_ERR_NO_MEM;
            continue;
        }
        power_mgmt_acquire_ble_active();
        int rc = ble_gatts_notify_custom(g_slots[i].handle, val_handle, om);
        power_mgmt_release_ble_active();
        if (rc != 0) {
            ESP_LOGD(TAG, "notify handle=%u which=%d rc=%d", g_slots[i].handle, (int)which, rc);
            any_err = ESP_FAIL;
        }
        sent_any = true;
    }
    return sent_any ? any_err : ESP_OK;
}

/* ============================================================================
 * High-level sends — delegate to per-service push helpers
 * ========================================================================= */

esp_err_t transport_ble_send_beat(const beat_event_t *beat)
{
    if (beat == NULL) return ESP_ERR_INVALID_ARG;
    if (!transport_ble_any_connected()) return ESP_OK;

    ble_service_hrs_push_beat(beat);
    ble_service_narbis_push_ibi(beat);
    return ESP_OK;
}

esp_err_t transport_ble_send_raw_sample(const ppg_sample_t *sample,
                                        uint16_t sample_rate_hz,
                                        uint8_t data_format)
{
    if (sample == NULL) return ESP_ERR_INVALID_ARG;
    if (!transport_ble_any_connected()) return ESP_OK;
    if (data_format != NARBIS_DATA_RAW_PPG && data_format != NARBIS_DATA_IBI_PLUS_RAW) {
        return ESP_OK;
    }
    return ble_service_narbis_push_raw(sample, sample_rate_hz);
}

esp_err_t transport_ble_send_battery(uint8_t soc_pct, uint16_t mv, uint8_t charging)
{
    if (!transport_ble_any_connected()) return ESP_OK;
    ble_service_battery_push(soc_pct, mv, charging);
    return ESP_OK;
}

esp_err_t transport_ble_notify_config(void)
{
    return ble_service_narbis_notify_config();
}

esp_err_t transport_ble_wait_first_connect(uint32_t timeout_ms)
{
    if (g_first_connect_sem == NULL) return ESP_ERR_INVALID_STATE;
    if (g_first_connect_seen)        return ESP_OK;
    TickType_t ticks = (timeout_ms == UINT32_MAX) ? portMAX_DELAY
                                                  : pdMS_TO_TICKS(timeout_ms);
    if (xSemaphoreTake(g_first_connect_sem, ticks) == pdTRUE) {
        xSemaphoreGive(g_first_connect_sem);
        return ESP_OK;
    }
    return ESP_ERR_TIMEOUT;
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

static void start_advertising_if_room(void)
{
    if (active_slot_count() >= NARBIS_BLE_MAX_CONNECTIONS) {
        return;
    }
    if (g_advertising) {
        return;  /* NimBLE will resume after the next disconnect-triggered restart */
    }
    int rc;

    rc = ble_svc_gap_device_name_set(g_device_name);
    if (rc != 0) {
        ESP_LOGW(TAG, "gap_name_set rc=%d", rc);
    }

    static const ble_uuid128_t narbis_svc_uuid = {
        .u = { .type = BLE_UUID_TYPE_128 },
        .value = NARBIS_SVC_UUID_BYTES,
    };

    struct ble_hs_adv_fields fields = {0};
    fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    fields.uuids128 = (ble_uuid128_t *)&narbis_svc_uuid;
    fields.num_uuids128 = 1;
    fields.uuids128_is_complete = 1;

    rc = ble_gap_adv_set_fields(&fields);
    if (rc != 0) {
        ESP_LOGE(TAG, "adv_set_fields rc=%d", rc);
        return;
    }

    struct ble_hs_adv_fields rsp_fields = {0};
    rsp_fields.name = (uint8_t *)g_device_name;
    rsp_fields.name_len = strlen(g_device_name);
    rsp_fields.name_is_complete = 1;
    rsp_fields.tx_pwr_lvl_is_present = 1;
    rsp_fields.tx_pwr_lvl = BLE_HS_ADV_TX_PWR_LVL_AUTO;

    rc = ble_gap_adv_rsp_set_fields(&rsp_fields);
    if (rc != 0) {
        ESP_LOGE(TAG, "adv_rsp_set_fields rc=%d", rc);
        return;
    }

    struct ble_gap_adv_params adv_params = {0};
    adv_params.conn_mode = BLE_GAP_CONN_MODE_UND;
    adv_params.disc_mode = BLE_GAP_DISC_MODE_GEN;

    rc = ble_gap_adv_start(g_own_addr_type, NULL, BLE_HS_FOREVER,
                           &adv_params, gap_event_handler, NULL);
    if (rc != 0) {
        ESP_LOGE(TAG, "adv_start rc=%d", rc);
        return;
    }
    g_advertising = true;
    ESP_LOGI(TAG, "advertising as \"%s\" (slots used %d/%d)",
             g_device_name, active_slot_count(), NARBIS_BLE_MAX_CONNECTIONS);
}

static int gap_event_handler(struct ble_gap_event *event, void *arg)
{
    (void)arg;
    switch (event->type) {
    case BLE_GAP_EVENT_CONNECT:
        g_advertising = false;  /* NimBLE auto-stops adv on connect */
        if (event->connect.status == 0) {
            int slot = find_free_slot();
            if (slot < 0) {
                ESP_LOGW(TAG, "connect %u: no free slot, terminating",
                         event->connect.conn_handle);
                ble_gap_terminate(event->connect.conn_handle, BLE_ERR_REM_USER_CONN_TERM);
                start_advertising_if_room();
                break;
            }
            clear_slot(slot);
            g_slots[slot].handle = event->connect.conn_handle;

            struct ble_gap_conn_desc desc;
            int drc = ble_gap_conn_find(g_slots[slot].handle, &desc);
            if (drc == 0) {
                ESP_LOGI(TAG,
                         "connected slot=%d handle=%u itvl=%u (%u.%02u ms) latency=%u timeout=%u (%u ms)",
                         slot, g_slots[slot].handle, desc.conn_itvl,
                         (desc.conn_itvl * 125u) / 100u,
                         (desc.conn_itvl * 125u) % 100u,
                         desc.conn_latency, desc.supervision_timeout,
                         desc.supervision_timeout * 10u);
            } else {
                ESP_LOGI(TAG, "connected slot=%d handle=%u (conn_find rc=%d)",
                         slot, g_slots[slot].handle, drc);
            }

            if (!g_first_connect_seen && g_first_connect_sem) {
                g_first_connect_seen = true;
                xSemaphoreGive(g_first_connect_sem);
            }

            int rc = ble_gattc_exchange_mtu(g_slots[slot].handle, NULL, NULL);
            if (rc != 0) {
                ESP_LOGW(TAG, "exchange_mtu rc=%d", rc);
            }

            (void)apply_profile_to_handle(g_slots[slot].handle, NARBIS_BLE_BATCHED);
            start_advertising_if_room();
        } else {
            ESP_LOGW(TAG, "connect failed status=%d", event->connect.status);
            start_advertising_if_room();
        }
        break;

    case BLE_GAP_EVENT_DISCONNECT: {
        uint16_t handle = event->disconnect.conn.conn_handle;
        int slot = find_slot_by_handle(handle);
        ESP_LOGI(TAG, "disconnected slot=%d handle=%u reason=0x%02x",
                 slot, handle, event->disconnect.reason);
        if (slot >= 0) clear_slot(slot);
        start_advertising_if_room();
        break;
    }

    case BLE_GAP_EVENT_MTU: {
        int slot = find_slot_by_handle(event->mtu.conn_handle);
        if (slot >= 0) {
            g_slots[slot].mtu = event->mtu.value;
            ESP_LOGI(TAG, "MTU slot=%d handle=%u mtu=%u",
                     slot, event->mtu.conn_handle, event->mtu.value);
        }
        break;
    }

    case BLE_GAP_EVENT_SUBSCRIBE: {
        uint16_t handle = event->subscribe.conn_handle;
        int slot = find_slot_by_handle(handle);
        if (slot < 0) break;
        uint16_t attr = event->subscribe.attr_handle;
        bool subscribed = event->subscribe.cur_notify || event->subscribe.cur_indicate;
        for (int i = 0; i < BLE_SUB_COUNT; i++) {
            if (g_val_handles[i] == attr) {
                g_slots[slot].subscribed[i] = subscribed;
                ESP_LOGI(TAG, "subscribe slot=%d which=%d %s",
                         slot, i, subscribed ? "on" : "off");
                break;
            }
        }
        break;
    }

    case BLE_GAP_EVENT_CONN_UPDATE: {
        struct ble_gap_conn_desc desc;
        if (ble_gap_conn_find(event->conn_update.conn_handle, &desc) == 0) {
            ESP_LOGI(TAG,
                     "conn_update handle=%u status=%d itvl=%u (%u.%02u ms) latency=%u timeout=%u (%u ms)",
                     event->conn_update.conn_handle, event->conn_update.status,
                     desc.conn_itvl,
                     (desc.conn_itvl * 125u) / 100u,
                     (desc.conn_itvl * 125u) % 100u,
                     desc.conn_latency, desc.supervision_timeout,
                     desc.supervision_timeout * 10u);
        }
        break;
    }

    case BLE_GAP_EVENT_ADV_COMPLETE:
        g_advertising = false;
        start_advertising_if_room();
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

    (void)ble_att_set_preferred_mtu(BLE_TRANSPORT_PREF_MTU);

    start_advertising_if_room();
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

static void on_gatts_register(struct ble_gatt_register_ctxt *ctxt, void *arg)
{
    (void)arg;

    if (ctxt->op == BLE_GATT_REGISTER_OP_CHR) {
        ble_service_dis_on_register(ctxt);
        ble_service_battery_on_register(ctxt);
        ble_service_hrs_on_register(ctxt);
        ble_service_narbis_on_register(ctxt);
        ble_ota_on_register(ctxt);
    }
}

/* ============================================================================
 * Init
 * ========================================================================= */

esp_err_t transport_ble_init(void)
{
    for (int i = 0; i < NARBIS_BLE_MAX_CONNECTIONS; i++) {
        clear_slot(i);
    }
    memset(g_val_handles, 0, sizeof(g_val_handles));
    g_advertising = false;

    if (g_first_connect_sem == NULL) {
        g_first_connect_sem = xSemaphoreCreateBinary();
        if (g_first_connect_sem == NULL) {
            return ESP_ERR_NO_MEM;
        }
    }
    g_first_connect_seen = false;

    esp_err_t err = nimble_port_init();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nimble_port_init: %s", esp_err_to_name(err));
        return err;
    }

    ble_hs_cfg.sync_cb = on_sync;
    ble_hs_cfg.reset_cb = on_reset;
    ble_hs_cfg.gatts_register_cb = on_gatts_register;

    ble_svc_gap_init();
    ble_svc_gatt_init();

    int rc;
    rc = ble_gatts_count_cfg(ble_service_dis_svc_defs());
    if (rc != 0) { ESP_LOGE(TAG, "count_cfg dis rc=%d", rc); return ESP_FAIL; }
    rc = ble_gatts_count_cfg(ble_service_battery_svc_defs());
    if (rc != 0) { ESP_LOGE(TAG, "count_cfg bat rc=%d", rc); return ESP_FAIL; }
    rc = ble_gatts_count_cfg(ble_service_hrs_svc_defs());
    if (rc != 0) { ESP_LOGE(TAG, "count_cfg hrs rc=%d", rc); return ESP_FAIL; }
    rc = ble_gatts_count_cfg(ble_service_narbis_svc_defs());
    if (rc != 0) { ESP_LOGE(TAG, "count_cfg narbis rc=%d", rc); return ESP_FAIL; }
    rc = ble_gatts_count_cfg(ble_ota_svc_defs());
    if (rc != 0) { ESP_LOGE(TAG, "count_cfg ota rc=%d", rc); return ESP_FAIL; }

    rc = ble_gatts_add_svcs(ble_service_dis_svc_defs());
    if (rc != 0) { ESP_LOGE(TAG, "add_svcs dis rc=%d", rc); return ESP_FAIL; }
    rc = ble_gatts_add_svcs(ble_service_battery_svc_defs());
    if (rc != 0) { ESP_LOGE(TAG, "add_svcs bat rc=%d", rc); return ESP_FAIL; }
    rc = ble_gatts_add_svcs(ble_service_hrs_svc_defs());
    if (rc != 0) { ESP_LOGE(TAG, "add_svcs hrs rc=%d", rc); return ESP_FAIL; }
    rc = ble_gatts_add_svcs(ble_service_narbis_svc_defs());
    if (rc != 0) { ESP_LOGE(TAG, "add_svcs narbis rc=%d", rc); return ESP_FAIL; }
    rc = ble_gatts_add_svcs(ble_ota_svc_defs());
    if (rc != 0) { ESP_LOGE(TAG, "add_svcs ota rc=%d", rc); return ESP_FAIL; }

    nimble_port_freertos_init(host_task);

    ESP_LOGI(TAG, "init complete (max %d connections)", NARBIS_BLE_MAX_CONNECTIONS);
    return ESP_OK;
}

esp_err_t transport_ble_deinit(void)
{
    return ESP_OK;
}
