/*
 * ble_service_hrs.c — standard Heart Rate Service (0x180D).
 *
 * Implements:
 *   - Heart Rate Measurement (0x2A37) with notify; flags + uint8 BPM +
 *     R-R intervals in 1/1024 sec units.
 *   - Body Sensor Location (0x2A38) read = 0x05 (Ear).
 *
 * Profile-aware: LOW_LATENCY notifies on every beat with one R-R interval,
 * BATCHED accumulates up to 9 R-R intervals before flushing.
 */

#include "ble_service_hrs.h"

#include <string.h>

#include "esp_log.h"

#include "freertos/FreeRTOS.h"
#include "freertos/portmacro.h"

#include "host/ble_gatt.h"
#include "host/ble_uuid.h"
#include "os/os_mbuf.h"

#include "transport_ble.h"

static const char *TAG = "ble_service_hrs";

#define HR_FLAG_VALUE_FORMAT_UINT16 0x01u
#define HR_FLAG_RR_PRESENT          0x10u

#define HRS_BATCH_MAX_RR 9

static const ble_uuid16_t SVC_UUID = BLE_UUID16_INIT(0x180D);
static const ble_uuid16_t CHR_HR_MEASUREMENT_UUID = BLE_UUID16_INIT(0x2A37);
static const ble_uuid16_t CHR_BODY_SENSOR_LOC_UUID = BLE_UUID16_INIT(0x2A38);

static uint16_t g_hrm_val_handle;
static uint8_t  g_profile = NARBIS_BLE_BATCHED;

/* BATCHED mode accumulator. Protected by a critical section since
 * ble_service_hrs_push_beat is called from the beat-validator task and
 * ble_service_hrs_flush from the BLE host task / a future batch timer. */
static portMUX_TYPE g_mux = portMUX_INITIALIZER_UNLOCKED;
static uint16_t g_rr_buf[HRS_BATCH_MAX_RR];
static uint8_t  g_rr_count;
static uint8_t  g_last_bpm;

static int body_sensor_loc_access_cb(uint16_t conn_handle, uint16_t attr_handle,
                                     struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn_handle; (void)attr_handle; (void)arg;
    static const uint8_t LOC_EAR = 0x05;
    if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        int rc = os_mbuf_append(ctxt->om, &LOC_EAR, 1);
        return rc == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    return BLE_ATT_ERR_REQ_NOT_SUPPORTED;
}

static int hrm_access_cb(uint16_t conn_handle, uint16_t attr_handle,
                        struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    /* Heart Rate Measurement is notify-only; reads return last BPM. */
    (void)conn_handle; (void)attr_handle; (void)arg;
    if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        uint8_t buf[2] = { 0x00, g_last_bpm };
        int rc = os_mbuf_append(ctxt->om, buf, sizeof(buf));
        return rc == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    return BLE_ATT_ERR_REQ_NOT_SUPPORTED;
}

static const struct ble_gatt_chr_def HRS_CHRS[] = {
    {
        .uuid       = &CHR_HR_MEASUREMENT_UUID.u,
        .access_cb  = hrm_access_cb,
        .flags      = BLE_GATT_CHR_F_NOTIFY | BLE_GATT_CHR_F_READ,
        .val_handle = &g_hrm_val_handle,
    },
    {
        .uuid       = &CHR_BODY_SENSOR_LOC_UUID.u,
        .access_cb  = body_sensor_loc_access_cb,
        .flags      = BLE_GATT_CHR_F_READ,
    },
    { 0 }
};

static const struct ble_gatt_svc_def HRS_SVC_DEFS[] = {
    {
        .type            = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid            = &SVC_UUID.u,
        .characteristics = HRS_CHRS,
    },
    { 0 }
};

esp_err_t ble_service_hrs_init(void)
{
    g_rr_count = 0;
    g_last_bpm = 0;
    g_profile = NARBIS_BLE_BATCHED;
    return ESP_OK;
}

esp_err_t ble_service_hrs_deinit(void)
{
    return ESP_OK;
}

const struct ble_gatt_svc_def *ble_service_hrs_svc_defs(void)
{
    return HRS_SVC_DEFS;
}

void ble_service_hrs_on_register(struct ble_gatt_register_ctxt *ctxt)
{
    if (ctxt->op != BLE_GATT_REGISTER_OP_CHR) return;
    if (ble_uuid_cmp(ctxt->chr.chr_def->uuid, &CHR_HR_MEASUREMENT_UUID.u) == 0) {
        transport_ble_set_val_handle(BLE_SUB_HRS_HR_MEASUREMENT,
                                     ctxt->chr.val_handle);
        ESP_LOGD(TAG, "hrm val_handle=%u", ctxt->chr.val_handle);
    }
}

/* Build a HR Measurement notification: flags(1) + bpm(1) + n*rr(2 each). */
static void emit_notify_locked(uint8_t bpm, const uint16_t *rr_list, uint8_t n_rr)
{
    uint8_t buf[1 + 1 + HRS_BATCH_MAX_RR * 2];
    size_t off = 0;
    buf[off++] = (n_rr > 0) ? HR_FLAG_RR_PRESENT : 0;
    buf[off++] = bpm;
    for (uint8_t i = 0; i < n_rr; i++) {
        buf[off++] = (uint8_t)(rr_list[i] & 0xFF);
        buf[off++] = (uint8_t)((rr_list[i] >> 8) & 0xFF);
    }
    (void)transport_ble_notify(BLE_SUB_HRS_HR_MEASUREMENT, buf, (uint16_t)off);
}

void ble_service_hrs_push_beat(const beat_event_t *beat)
{
    if (beat == NULL || beat->ibi_ms == 0) return;

    uint16_t bpm = (uint16_t)((60000u + beat->ibi_ms / 2u) / beat->ibi_ms);
    if (bpm > 220) bpm = 220;
    if (bpm < 30)  bpm = 30;
    /* Convert ms → 1/1024 s units. ibi_ms <= 2000 fits in uint32. */
    uint32_t rr_q = ((uint32_t)beat->ibi_ms * 1024u + 500u) / 1000u;
    if (rr_q > 0xFFFFu) rr_q = 0xFFFFu;

    g_last_bpm = (uint8_t)bpm;

    if (!transport_ble_is_subscribed(BLE_SUB_HRS_HR_MEASUREMENT)) {
        return;
    }

    if (g_profile == NARBIS_BLE_LOW_LATENCY) {
        uint16_t one = (uint16_t)rr_q;
        emit_notify_locked(g_last_bpm, &one, 1);
        return;
    }

    /* BATCHED: accumulate, flush when full. */
    bool flush_now = false;
    portENTER_CRITICAL(&g_mux);
    if (g_rr_count < HRS_BATCH_MAX_RR) {
        g_rr_buf[g_rr_count++] = (uint16_t)rr_q;
    }
    if (g_rr_count >= HRS_BATCH_MAX_RR) {
        flush_now = true;
    }
    portEXIT_CRITICAL(&g_mux);

    if (flush_now) {
        ble_service_hrs_flush();
    }
}

void ble_service_hrs_flush(void)
{
    uint16_t local_buf[HRS_BATCH_MAX_RR];
    uint8_t  n;
    uint8_t  bpm;

    portENTER_CRITICAL(&g_mux);
    n = g_rr_count;
    bpm = g_last_bpm;
    if (n > 0) {
        memcpy(local_buf, g_rr_buf, sizeof(uint16_t) * n);
    }
    g_rr_count = 0;
    portEXIT_CRITICAL(&g_mux);

    if (n == 0) return;
    if (!transport_ble_is_subscribed(BLE_SUB_HRS_HR_MEASUREMENT)) return;
    emit_notify_locked(bpm, local_buf, n);
}

void ble_service_hrs_set_profile(uint8_t ble_profile)
{
    if (ble_profile == NARBIS_BLE_LOW_LATENCY && g_profile != NARBIS_BLE_LOW_LATENCY) {
        ble_service_hrs_flush();
    }
    g_profile = ble_profile;
}
