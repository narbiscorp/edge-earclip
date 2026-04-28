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
 *   MODE           write        3 bytes: transport, ble_profile, data_format
 *   ESPNOW_PAIR    write        6 bytes: new partner MAC
 *   FACTORY_RESET  write        4-byte magic 'NUKE'
 *   OTA_CONTROL    write        Stage 08 — stub returns NOT_PERMITTED
 *   DIAGNOSTICS    notify       Stage 07 owns emission; chr is registered now
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
#include "transport_espnow.h"

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
static const ble_uuid128_t CHR_OTA_UUID          = NARBIS_UUID128(NARBIS_CHR_OTA_CONTROL_UUID_BYTES);
static const ble_uuid128_t CHR_DIAGNOSTICS_UUID  = NARBIS_UUID128(NARBIS_CHR_DIAGNOSTICS_UUID_BYTES);

/* Custom UUIDs invented here (write-only) for ESP-NOW pairing and factory
 * reset — these are firmware-internal control surfaces, not used by the
 * dashboard yet. */
static const ble_uuid128_t CHR_PAIR_UUID = {
    .u = { .type = BLE_UUID_TYPE_128 },
    .value = { 0x10, 0xC4, 0xD9, 0xA8, 0x47, 0x7E, 0x4A, 0x36,
               0x9D, 0x0F, 0x33, 0x16, 0xB1, 0x21, 0xE2, 0xC0 },
};
static const ble_uuid128_t CHR_FACTORY_RESET_UUID = {
    .u = { .type = BLE_UUID_TYPE_128 },
    .value = { 0x11, 0xC4, 0xD9, 0xA8, 0x47, 0x7E, 0x4A, 0x36,
               0x9D, 0x0F, 0x33, 0x16, 0xB1, 0x21, 0xE2, 0xC0 },
};

/* ============================================================================
 * State
 * ========================================================================= */

static narbis_runtime_config_t g_config;

static uint16_t g_h_ibi, g_h_sqi, g_h_raw, g_h_battery, g_h_config, g_h_diag;

static portMUX_TYPE g_raw_mux = portMUX_INITIALIZER_UNLOCKED;
static narbis_raw_ppg_payload_t g_raw_buf;

static const uint32_t FACTORY_RESET_MAGIC = 0x454B554Eu;  /* 'NUKE' */

/* ============================================================================
 * Default config (Stage 07 will load from NVS)
 * ========================================================================= */

static void load_default_config(narbis_runtime_config_t *c)
{
    memset(c, 0, sizeof(*c));
    c->config_version = 1;
    c->sample_rate_hz = 200;
    c->led_red_ma_x10 = 70;
    c->led_ir_ma_x10  = 70;
    c->agc_enabled = 1;
    c->agc_update_period_ms = 200;
    c->agc_target_dc_min = 30000;
    c->agc_target_dc_max = 100000;
    c->agc_step_ma_x10 = 5;
    c->bandpass_low_hz_x100 = 50;
    c->bandpass_high_hz_x100 = 800;
    c->elgendi_w1_ms = 111;
    c->elgendi_w2_ms = 667;
    c->elgendi_beta_x1000 = 20;
    c->sqi_threshold_x100 = 50;
    c->ibi_min_ms = 300;
    c->ibi_max_ms = 2000;
    c->ibi_max_delta_pct = 30;
    c->transport_mode = NARBIS_TRANSPORT_HYBRID;
    c->ble_profile = NARBIS_BLE_BATCHED;
    c->data_format = NARBIS_DATA_IBI_ONLY;
    c->ble_batch_period_ms = 500;
    c->espnow_channel = 1;
    c->diagnostics_enabled = 1;
    c->light_sleep_enabled = 1;
    c->battery_low_mv = 3300;
}

narbis_runtime_config_t *ble_service_narbis_config(void)
{
    return &g_config;
}

/* ============================================================================
 * Live-apply paths for config writes
 * ========================================================================= */

static void apply_mode(uint8_t transport_mode, uint8_t ble_profile, uint8_t data_format)
{
    if (transport_mode > NARBIS_TRANSPORT_HYBRID) return;
    if (ble_profile > NARBIS_BLE_LOW_LATENCY)     return;
    if (data_format > NARBIS_DATA_IBI_PLUS_RAW)   return;

    bool profile_changed = (g_config.ble_profile != ble_profile);
    g_config.transport_mode = transport_mode;
    g_config.ble_profile    = ble_profile;
    g_config.data_format    = data_format;

    if (profile_changed) {
        ble_service_hrs_set_profile(ble_profile);
        (void)transport_ble_set_profile(ble_profile);
    }
    ESP_LOGI(TAG, "mode applied transport=%u profile=%u format=%u",
             transport_mode, ble_profile, data_format);
}

static void apply_partner_mac(const uint8_t mac[6])
{
    bool all_zero = true, all_ff = true;
    for (int i = 0; i < 6; i++) {
        if (mac[i] != 0x00) all_zero = false;
        if (mac[i] != 0xFF) all_ff = false;
    }
    if (all_zero || all_ff) {
        ESP_LOGW(TAG, "partner MAC reject (all-zero or all-ff)");
        return;
    }
    memcpy(g_config.partner_mac, mac, 6);
    esp_err_t err = transport_espnow_set_partner(mac);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "set_partner: %s", esp_err_to_name(err));
    }
}

/* Apply only the fields we know how to apply live. The rest land in
 * g_config and Stage 07 will wire NVS persistence + the missing apply
 * paths (DSP, AGC, sample rate). */
static void apply_config(const narbis_runtime_config_t *new_cfg)
{
    apply_mode(new_cfg->transport_mode, new_cfg->ble_profile, new_cfg->data_format);
    g_config.ble_batch_period_ms = new_cfg->ble_batch_period_ms;

    if (memcmp(new_cfg->partner_mac, g_config.partner_mac, 6) != 0) {
        bool nonzero = false;
        for (int i = 0; i < 6; i++) {
            if (new_cfg->partner_mac[i] != 0) { nonzero = true; break; }
        }
        if (nonzero) {
            apply_partner_mac(new_cfg->partner_mac);
        }
    }

    /* Stash the rest. apply paths land in Stage 07. */
    g_config.led_red_ma_x10        = new_cfg->led_red_ma_x10;
    g_config.led_ir_ma_x10         = new_cfg->led_ir_ma_x10;
    g_config.agc_enabled           = new_cfg->agc_enabled;
    g_config.agc_update_period_ms  = new_cfg->agc_update_period_ms;
    g_config.agc_target_dc_min     = new_cfg->agc_target_dc_min;
    g_config.agc_target_dc_max     = new_cfg->agc_target_dc_max;
    g_config.agc_step_ma_x10       = new_cfg->agc_step_ma_x10;
    g_config.bandpass_low_hz_x100  = new_cfg->bandpass_low_hz_x100;
    g_config.bandpass_high_hz_x100 = new_cfg->bandpass_high_hz_x100;
    g_config.elgendi_w1_ms         = new_cfg->elgendi_w1_ms;
    g_config.elgendi_w2_ms         = new_cfg->elgendi_w2_ms;
    g_config.elgendi_beta_x1000    = new_cfg->elgendi_beta_x1000;
    g_config.sqi_threshold_x100    = new_cfg->sqi_threshold_x100;
    g_config.ibi_min_ms            = new_cfg->ibi_min_ms;
    g_config.ibi_max_ms            = new_cfg->ibi_max_ms;
    g_config.ibi_max_delta_pct     = new_cfg->ibi_max_delta_pct;
    g_config.espnow_channel        = new_cfg->espnow_channel;
    g_config.diagnostics_enabled   = new_cfg->diagnostics_enabled;
    g_config.light_sleep_enabled   = new_cfg->light_sleep_enabled;
    g_config.battery_low_mv        = new_cfg->battery_low_mv;
    g_config.sample_rate_hz        = new_cfg->sample_rate_hz;  /* takes effect on reboot */

    (void)ble_service_narbis_notify_config();
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
    if (narbis_config_serialize(buf, sizeof(buf), &g_config, &out_len) != 0) {
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
    apply_config(&new_cfg);
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
    if (read_om_to_bytes(ctxt->om, buf, sizeof(buf), &len) != 0 || len != 3) {
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }
    if (buf[0] > NARBIS_TRANSPORT_HYBRID ||
        buf[1] > NARBIS_BLE_LOW_LATENCY  ||
        buf[2] > NARBIS_DATA_IBI_PLUS_RAW) {
        return BLE_ATT_ERR_VALUE_NOT_ALLOWED;
    }
    apply_mode(buf[0], buf[1], buf[2]);
    return 0;
}

static int access_pair(uint16_t conn_handle, uint16_t attr_handle,
                       struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn_handle; (void)attr_handle; (void)arg;
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) {
        return BLE_ATT_ERR_REQ_NOT_SUPPORTED;
    }
    uint8_t mac[6];
    uint16_t len = 0;
    if (read_om_to_bytes(ctxt->om, mac, sizeof(mac), &len) != 0 || len != 6) {
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }
    apply_partner_mac(mac);
    return 0;
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
    esp_err_t err = config_clear_pairing();
    ESP_LOGW(TAG, "factory reset: %s", esp_err_to_name(err));
    return err == ESP_OK ? 0 : BLE_ATT_ERR_UNLIKELY;
}

static int access_ota(uint16_t conn_handle, uint16_t attr_handle,
                      struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    /* Stage 08 fills this in. Until then, refuse writes politely. */
    (void)conn_handle; (void)attr_handle; (void)ctxt; (void)arg;
    return BLE_ATT_ERR_WRITE_NOT_PERMITTED;
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
        .uuid       = &CHR_PAIR_UUID.u,
        .access_cb  = access_pair,
        .flags      = BLE_GATT_CHR_F_WRITE,
    },
    {
        .uuid       = &CHR_FACTORY_RESET_UUID.u,
        .access_cb  = access_factory_reset,
        .flags      = BLE_GATT_CHR_F_WRITE,
    },
    {
        .uuid       = &CHR_OTA_UUID.u,
        .access_cb  = access_ota,
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
    if (narbis_config_serialize(buf, sizeof(buf), &g_config, &out_len) != 0) {
        return ESP_FAIL;
    }
    return transport_ble_notify(BLE_SUB_NARBIS_CONFIG, buf, (uint16_t)out_len);
}

/* ============================================================================
 * Init
 * ========================================================================= */

esp_err_t ble_service_narbis_init(void)
{
    load_default_config(&g_config);
    g_raw_buf.n_samples = 0;
    return ESP_OK;
}

esp_err_t ble_service_narbis_deinit(void)
{
    return ESP_OK;
}
