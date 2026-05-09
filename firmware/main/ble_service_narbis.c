/*
 * ble_service_narbis.c — custom Narbis service.
 *
 * Characteristics (UUIDs from protocol/narbis_protocol.h):
 *   IBI            notify   beat_validator → narbis_ibi_payload_t
 *   SQI            notify   narbis_sqi_payload_t
 *   RAW_PPG        notify   narbis_raw_ppg_payload_t (29-sample batches)
 *   BATTERY        notify   narbis_battery_payload_t (richer than 0x2A19)
 *   CONFIG         read+notify  serialised narbis_runtime_config_t + CRC16
 *   CONFIG_WRITE   write        full config struct + CRC16
 *   MODE           write        2 bytes (post Path B): ble_profile, data_format
 *                              (still accepts 3 for legacy clients; first byte
 *                              ignored)
 *   PEER_ROLE      write        1 byte: NARBIS_PEER_ROLE_DASHBOARD/GLASSES.
 *                              Routes the slot to the right BLE conn-update
 *                              profile. Not persisted; central re-announces
 *                              on every connect.
 *   FACTORY_RESET  write        4-byte magic 'NUKE'
 *   DIAGNOSTICS    notify       Stage 07 owns emission; chr is registered now
 *
 * OTA lives in its own GATT service (ble_ota.c, UUID 0x00FF) — see
 * narbis_protocol.h "OTA service".
 */

#include "ble_service_narbis.h"

#include <string.h>

#include "esp_log.h"

#include "freertos/FreeRTOS.h"
#include "freertos/portmacro.h"

#include "host/ble_gatt.h"
#include "host/ble_hs_mbuf.h"
#include "host/ble_uuid.h"
#include "os/os_mbuf.h"

#include "ble_service_hrs.h"
#include "config_manager.h"
#include "narbis_protocol.h"
#include "transport_ble.h"

static const char *TAG = "ble_service_narbis";

/* ============================================================================
 * UUIDs
 *
 * The protocol header defines NARBIS_*_UUID_BYTES as braced byte arrays
 * (e.g. `{0xB2,0x80,...}`), suitable for `value = NARBIS_..._BYTES` direct
 * aggregate-initialization of ble_uuid128_t::value. NimBLE's
 * `BLE_UUID128_INIT` macro takes a flat (un-braced) list, so we don't use it
 * here and instead init the struct fields explicitly.
 * ========================================================================= */

#define NARBIS_UUID128(BYTES) { .u = { .type = BLE_UUID_TYPE_128 }, .value = BYTES }

static const ble_uuid128_t SVC_UUID              = NARBIS_UUID128(NARBIS_SVC_UUID_BYTES);
static const ble_uuid128_t CHR_IBI_UUID          = NARBIS_UUID128(NARBIS_CHR_IBI_UUID_BYTES);
static const ble_uuid128_t CHR_SQI_UUID          = NARBIS_UUID128(NARBIS_CHR_SQI_UUID_BYTES);
static const ble_uuid128_t CHR_RAW_PPG_UUID      = NARBIS_UUID128(NARBIS_CHR_RAW_PPG_UUID_BYTES);
static const ble_uuid128_t CHR_BATTERY_UUID      = NARBIS_UUID128(NARBIS_CHR_BATTERY_UUID_BYTES);
static const ble_uuid128_t CHR_CONFIG_UUID       = NARBIS_UUID128(NARBIS_CHR_CONFIG_UUID_BYTES);
static const ble_uuid128_t CHR_CONFIG_WRITE_UUID = NARBIS_UUID128(NARBIS_CHR_CONFIG_WRITE_UUID_BYTES);
static const ble_uuid128_t CHR_MODE_UUID         = NARBIS_UUID128(NARBIS_CHR_MODE_UUID_BYTES);
static const ble_uuid128_t CHR_PEER_ROLE_UUID    = NARBIS_UUID128(NARBIS_CHR_PEER_ROLE_UUID_BYTES);
static const ble_uuid128_t CHR_DIAGNOSTICS_UUID  = NARBIS_UUID128(NARBIS_CHR_DIAGNOSTICS_UUID_BYTES);

/* Factory-reset characteristic — write the 4-byte magic 'NUKE' to wipe
 * NVS and force defaults on the next boot. Firmware-internal control. */
static const ble_uuid128_t CHR_FACTORY_RESET_UUID = {
    .u = { .type = BLE_UUID_TYPE_128 },
    .value = { 0x11, 0xC4, 0xD9, 0xA8, 0x47, 0x7E, 0x4A, 0x36,
               0x9D, 0x0F, 0x33, 0x16, 0xB1, 0x21, 0xE2, 0xC0 },
};

/* ============================================================================
 * State
 *
 * The runtime config now lives in config_manager — this module just routes
 * BLE characteristic writes to the right config_apply* function and reads
 * the live snapshot via config_get().
 * ========================================================================= */

static uint16_t g_h_ibi, g_h_sqi, g_h_raw, g_h_battery, g_h_config, g_h_diag;

static portMUX_TYPE g_raw_mux = portMUX_INITIALIZER_UNLOCKED;
static narbis_raw_ppg_payload_t g_raw_buf;

static const uint32_t FACTORY_RESET_MAGIC = 0x454B554Eu;  /* 'NUKE' */

/* ============================================================================
 * Config accessor — delegates to config_manager.
 * ========================================================================= */

const narbis_runtime_config_t *ble_service_narbis_config(void)
{
    return config_get();
}

/* ============================================================================
 * Access callbacks
 * ========================================================================= */

static int read_om_to_bytes(struct os_mbuf *om, uint8_t *out, size_t max_len, uint16_t *out_len)
{
    uint16_t len = OS_MBUF_PKTLEN(om);
    if (len > max_len) return -1;
    int rc = ble_hs_mbuf_to_flat(om, out, max_len, &len);
    if (rc != 0) return -1;
    *out_len = len;
    return 0;
}

static int access_ibi_sqi_raw_battery_diag(uint16_t conn_handle, uint16_t attr_handle,
                                           struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    /* Notify-only characteristics. Reads return empty; writes denied. */
    (void)conn_handle; (void)attr_handle; (void)ctxt; (void)arg;
    if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        return 0;
    }
    return BLE_ATT_ERR_REQ_NOT_SUPPORTED;
}

static int access_config(uint16_t conn_handle, uint16_t attr_handle,
                         struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn_handle; (void)attr_handle; (void)arg;
    if (ctxt->op != BLE_GATT_ACCESS_OP_READ_CHR) {
        return BLE_ATT_ERR_REQ_NOT_SUPPORTED;
    }
    uint8_t buf[NARBIS_CONFIG_WIRE_SIZE];
    size_t out_len = 0;
    if (narbis_config_serialize(buf, sizeof(buf), config_get(), &out_len) != 0) {
        return BLE_ATT_ERR_UNLIKELY;
    }
    int rc = os_mbuf_append(ctxt->om, buf, out_len);
    return rc == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
}

static int access_config_write(uint16_t conn_handle, uint16_t attr_handle,
                               struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn_handle; (void)attr_handle; (void)arg;
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) {
        return BLE_ATT_ERR_REQ_NOT_SUPPORTED;
    }
    uint8_t buf[NARBIS_CONFIG_WIRE_SIZE];
    uint16_t len = 0;
    if (read_om_to_bytes(ctxt->om, buf, sizeof(buf), &len) != 0) {
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }
    if (len != NARBIS_CONFIG_WIRE_SIZE) {
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }
    narbis_runtime_config_t new_cfg;
    if (narbis_config_deserialize(buf, len, &new_cfg) != 0) {
        return BLE_ATT_ERR_VALUE_NOT_ALLOWED;
    }
    esp_err_t err = config_apply(&new_cfg);
    if (err == ESP_ERR_INVALID_ARG)   return BLE_ATT_ERR_VALUE_NOT_ALLOWED;
    if (err == ESP_ERR_INVALID_STATE) return BLE_ATT_ERR_UNLIKELY;
    if (err != ESP_OK)                return BLE_ATT_ERR_UNLIKELY;
    return 0;
}

static int access_mode(uint16_t conn_handle, uint16_t attr_handle,
                       struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn_handle; (void)attr_handle; (void)arg;
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) {
        return BLE_ATT_ERR_REQ_NOT_SUPPORTED;
    }
    uint8_t buf[3];
    uint16_t len = 0;
    /* Accept 2 or 3 bytes. Pre-Path-B clients send [transport, ble_profile,
     * data_format]; we ignore the leading transport byte. New clients send
     * [ble_profile, data_format]. */
    if (read_om_to_bytes(ctxt->om, buf, sizeof(buf), &len) != 0 ||
        (len != 2 && len != 3)) {
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }
    uint8_t ble_profile  = (len == 3) ? buf[1] : buf[0];
    uint8_t data_format  = (len == 3) ? buf[2] : buf[1];
    esp_err_t err = config_apply_mode(ble_profile, data_format);
    if (err == ESP_ERR_INVALID_ARG)   return BLE_ATT_ERR_VALUE_NOT_ALLOWED;
    if (err == ESP_ERR_INVALID_STATE) return BLE_ATT_ERR_UNLIKELY;
    if (err != ESP_OK)                return BLE_ATT_ERR_UNLIKELY;
    return 0;
}

static int access_peer_role(uint16_t conn_handle, uint16_t attr_handle,
                            struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)attr_handle; (void)arg;
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) {
        return BLE_ATT_ERR_REQ_NOT_SUPPORTED;
    }
    uint8_t buf[1];
    uint16_t len = 0;
    if (read_om_to_bytes(ctxt->om, buf, sizeof(buf), &len) != 0 || len != 1) {
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }
    if (buf[0] > NARBIS_PEER_ROLE_GLASSES) {
        return BLE_ATT_ERR_VALUE_NOT_ALLOWED;
    }
    esp_err_t err = transport_ble_set_peer_role(conn_handle,
                                                (narbis_peer_role_t)buf[0]);
    if (err == ESP_ERR_NOT_FOUND) return BLE_ATT_ERR_UNLIKELY;
    return err == ESP_OK ? 0 : BLE_ATT_ERR_UNLIKELY;
}

static int access_factory_reset(uint16_t conn_handle, uint16_t attr_handle,
                                struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn_handle; (void)attr_handle; (void)arg;
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) {
        return BLE_ATT_ERR_REQ_NOT_SUPPORTED;
    }
    uint8_t buf[4];
    uint16_t len = 0;
    if (read_om_to_bytes(ctxt->om, buf, sizeof(buf), &len) != 0 || len != 4) {
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }
    uint32_t magic = (uint32_t)buf[0] |
                     ((uint32_t)buf[1] << 8) |
                     ((uint32_t)buf[2] << 16) |
                     ((uint32_t)buf[3] << 24);
    if (magic != FACTORY_RESET_MAGIC) {
        return BLE_ATT_ERR_VALUE_NOT_ALLOWED;
    }
    esp_err_t err = config_factory_reset();
    ESP_LOGW(TAG, "factory reset: %s", esp_err_to_name(err));
    return err == ESP_OK ? 0 : BLE_ATT_ERR_UNLIKELY;
}

/* ============================================================================
 * GATT table
 * ========================================================================= */

static const struct ble_gatt_chr_def NARBIS_CHRS[] = {
    {
        .uuid       = &CHR_IBI_UUID.u,
        .access_cb  = access_ibi_sqi_raw_battery_diag,
        .flags      = BLE_GATT_CHR_F_NOTIFY | BLE_GATT_CHR_F_READ,
        .val_handle = &g_h_ibi,
    },
    {
        .uuid       = &CHR_SQI_UUID.u,
        .access_cb  = access_ibi_sqi_raw_battery_diag,
        .flags      = BLE_GATT_CHR_F_NOTIFY | BLE_GATT_CHR_F_READ,
        .val_handle = &g_h_sqi,
    },
    {
        .uuid       = &CHR_RAW_PPG_UUID.u,
        .access_cb  = access_ibi_sqi_raw_battery_diag,
        .flags      = BLE_GATT_CHR_F_NOTIFY | BLE_GATT_CHR_F_READ,
        .val_handle = &g_h_raw,
    },
    {
        .uuid       = &CHR_BATTERY_UUID.u,
        .access_cb  = access_ibi_sqi_raw_battery_diag,
        .flags      = BLE_GATT_CHR_F_NOTIFY | BLE_GATT_CHR_F_READ,
        .val_handle = &g_h_battery,
    },
    {
        .uuid       = &CHR_CONFIG_UUID.u,
        .access_cb  = access_config,
        .flags      = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_NOTIFY,
        .val_handle = &g_h_config,
    },
    {
        .uuid       = &CHR_CONFIG_WRITE_UUID.u,
        .access_cb  = access_config_write,
        .flags      = BLE_GATT_CHR_F_WRITE,
    },
    {
        .uuid       = &CHR_MODE_UUID.u,
        .access_cb  = access_mode,
        .flags      = BLE_GATT_CHR_F_WRITE,
    },
    {
        .uuid       = &CHR_PEER_ROLE_UUID.u,
        .access_cb  = access_peer_role,
        .flags      = BLE_GATT_CHR_F_WRITE,
    },
    {
        .uuid       = &CHR_FACTORY_RESET_UUID.u,
        .access_cb  = access_factory_reset,
        .flags      = BLE_GATT_CHR_F_WRITE,
    },
    {
        .uuid       = &CHR_DIAGNOSTICS_UUID.u,
        .access_cb  = access_ibi_sqi_raw_battery_diag,
        .flags      = BLE_GATT_CHR_F_NOTIFY | BLE_GATT_CHR_F_READ,
        .val_handle = &g_h_diag,
    },
    { 0 }
};

static const struct ble_gatt_svc_def NARBIS_SVC_DEFS[] = {
    {
        .type            = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid            = &SVC_UUID.u,
        .characteristics = NARBIS_CHRS,
    },
    { 0 }
};

const struct ble_gatt_svc_def *ble_service_narbis_svc_defs(void)
{
    return NARBIS_SVC_DEFS;
}

void ble_service_narbis_on_register(struct ble_gatt_register_ctxt *ctxt)
{
    if (ctxt->op != BLE_GATT_REGISTER_OP_CHR) return;
    const ble_uuid_t *u = ctxt->chr.chr_def->uuid;
    uint16_t h = ctxt->chr.val_handle;

    if (ble_uuid_cmp(u, &CHR_IBI_UUID.u) == 0) {
        transport_ble_set_val_handle(BLE_SUB_NARBIS_IBI, h);
    } else if (ble_uuid_cmp(u, &CHR_SQI_UUID.u) == 0) {
        transport_ble_set_val_handle(BLE_SUB_NARBIS_SQI, h);
    } else if (ble_uuid_cmp(u, &CHR_RAW_PPG_UUID.u) == 0) {
        transport_ble_set_val_handle(BLE_SUB_NARBIS_RAW_PPG, h);
    } else if (ble_uuid_cmp(u, &CHR_BATTERY_UUID.u) == 0) {
        transport_ble_set_val_handle(BLE_SUB_NARBIS_BATTERY, h);
    } else if (ble_uuid_cmp(u, &CHR_CONFIG_UUID.u) == 0) {
        transport_ble_set_val_handle(BLE_SUB_NARBIS_CONFIG, h);
    } else if (ble_uuid_cmp(u, &CHR_DIAGNOSTICS_UUID.u) == 0) {
        transport_ble_set_val_handle(BLE_SUB_NARBIS_DIAGNOSTICS, h);
    }
}

/* ============================================================================
 * Push helpers (called from main / transport_ble)
 * ========================================================================= */

esp_err_t ble_service_narbis_push_ibi(const beat_event_t *beat)
{
    if (beat == NULL) return ESP_ERR_INVALID_ARG;
    narbis_ibi_payload_t p;
    p.ibi_ms = beat->ibi_ms;
    p.confidence_x100 = beat->confidence_x100;
    p.flags = beat->flags;
    return transport_ble_notify(BLE_SUB_NARBIS_IBI,
                                (const uint8_t *)&p, sizeof(p));
}

static void flush_raw_locked_copy(narbis_raw_ppg_payload_t *out)
{
    portENTER_CRITICAL(&g_raw_mux);
    memcpy(out, &g_raw_buf, sizeof(*out));
    g_raw_buf.n_samples = 0;
    portEXIT_CRITICAL(&g_raw_mux);
}

esp_err_t ble_service_narbis_push_raw(const ppg_sample_t *sample,
                                      uint16_t sample_rate_hz)
{
    if (sample == NULL) return ESP_ERR_INVALID_ARG;
    if (!transport_ble_is_subscribed(BLE_SUB_NARBIS_RAW_PPG)) {
        portENTER_CRITICAL(&g_raw_mux);
        g_raw_buf.n_samples = 0;
        portEXIT_CRITICAL(&g_raw_mux);
        return ESP_OK;
    }

    bool flush_now = false;
    portENTER_CRITICAL(&g_raw_mux);
    if (g_raw_buf.n_samples == 0) {
        g_raw_buf.sample_rate_hz = sample_rate_hz;
    }
    if (g_raw_buf.n_samples < NARBIS_RAW_PPG_MAX_SAMPLES) {
        g_raw_buf.samples[g_raw_buf.n_samples].red = sample->red;
        g_raw_buf.samples[g_raw_buf.n_samples].ir  = sample->ir;
        g_raw_buf.n_samples++;
    }
    if (g_raw_buf.n_samples >= NARBIS_RAW_PPG_MAX_SAMPLES) {
        flush_now = true;
    }
    portEXIT_CRITICAL(&g_raw_mux);

    if (!flush_now) return ESP_OK;

    narbis_raw_ppg_payload_t local;
    flush_raw_locked_copy(&local);
    /* Wire size: 4 + n*8 */
    uint16_t wire = (uint16_t)(4u + (uint32_t)local.n_samples * 8u);
    return transport_ble_notify(BLE_SUB_NARBIS_RAW_PPG,
                                (const uint8_t *)&local, wire);
}

esp_err_t ble_service_narbis_push_sqi(const narbis_sqi_payload_t *sqi)
{
    if (sqi == NULL) return ESP_ERR_INVALID_ARG;
    return transport_ble_notify(BLE_SUB_NARBIS_SQI,
                                (const uint8_t *)sqi, sizeof(*sqi));
}

esp_err_t ble_service_narbis_push_battery(uint8_t soc_pct, uint16_t mv, uint8_t charging)
{
    narbis_battery_payload_t p = {
        .mv = mv,
        .soc_pct = soc_pct,
        .charging = charging,
    };
    return transport_ble_notify(BLE_SUB_NARBIS_BATTERY,
                                (const uint8_t *)&p, sizeof(p));
}

esp_err_t ble_service_narbis_notify_config(void)
{
    uint8_t buf[NARBIS_CONFIG_WIRE_SIZE];
    size_t out_len = 0;
    if (narbis_config_serialize(buf, sizeof(buf), config_get(), &out_len) != 0) {
        ESP_LOGW(TAG, "notify_config: serialize failed");
        return ESP_FAIL;
    }
    /* Diagnostic — was the notify actually queued, and how many subscribers
     * received it? cfg=0 on the central side means either this never fired
     * (compile-out / wrong path) or fired but transport_ble_notify saw zero
     * subscribed peers (subscribed[CONFIG] race). The post-call log answers
     * both. Bump to ESP_LOGW so it survives any later log-level lowering. */
    bool subbed = transport_ble_is_subscribed(BLE_SUB_NARBIS_CONFIG);
    uint16_t hdl = transport_ble_val_handle(BLE_SUB_NARBIS_CONFIG);
    esp_err_t rc = transport_ble_notify(BLE_SUB_NARBIS_CONFIG, buf, (uint16_t)out_len);
    ESP_LOGW(TAG, "notify_config: %u B hdl=%u any_subbed=%d rc=%s",
             (unsigned)out_len, hdl, (int)subbed, esp_err_to_name(rc));
    return rc;
}

/* ============================================================================
 * Init
 * ========================================================================= */

esp_err_t ble_service_narbis_init(void)
{
    /* config_manager owns the runtime config; we just initialise the
     * raw-PPG batch state here. */
    g_raw_buf.n_samples = 0;
    return ESP_OK;
}

esp_err_t ble_service_narbis_deinit(void)
{
    return ESP_OK;
}
