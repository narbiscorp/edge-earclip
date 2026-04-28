/*
 * ble_service_battery.c — standard Battery Service (0x180F).
 *
 * Exposes Battery Level (0x2A19) as a single uint8 (0..100) with read +
 * notify. The richer Narbis-side battery characteristic with mv/charging
 * lives in ble_service_narbis.c.
 */

#include "ble_service_battery.h"

#include <string.h>

#include "esp_log.h"

#include "host/ble_gatt.h"
#include "host/ble_uuid.h"
#include "os/os_mbuf.h"

#include "transport_ble.h"

static const char *TAG = "ble_service_battery";

static const ble_uuid16_t SVC_UUID = BLE_UUID16_INIT(0x180F);
static const ble_uuid16_t CHR_LEVEL_UUID = BLE_UUID16_INIT(0x2A19);

static uint8_t  g_soc_pct;
static uint16_t g_mv;
static uint8_t  g_charging;
static uint16_t g_level_val_handle;

static int level_access_cb(uint16_t conn_handle, uint16_t attr_handle,
                           struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn_handle; (void)attr_handle; (void)arg;
    if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        int rc = os_mbuf_append(ctxt->om, &g_soc_pct, sizeof(g_soc_pct));
        return rc == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    return BLE_ATT_ERR_REQ_NOT_SUPPORTED;
}

static const struct ble_gatt_chr_def BATTERY_CHRS[] = {
    {
        .uuid       = &CHR_LEVEL_UUID.u,
        .access_cb  = level_access_cb,
        .flags      = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_NOTIFY,
        .val_handle = &g_level_val_handle,
    },
    { 0 }
};

static const struct ble_gatt_svc_def BATTERY_SVC_DEFS[] = {
    {
        .type            = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid            = &SVC_UUID.u,
        .characteristics = BATTERY_CHRS,
    },
    { 0 }
};

esp_err_t ble_service_battery_init(void)
{
    g_soc_pct = 100;
    g_mv = 4200;
    g_charging = 0;
    return ESP_OK;
}

esp_err_t ble_service_battery_deinit(void)
{
    return ESP_OK;
}

const struct ble_gatt_svc_def *ble_service_battery_svc_defs(void)
{
    return BATTERY_SVC_DEFS;
}

void ble_service_battery_on_register(struct ble_gatt_register_ctxt *ctxt)
{
    if (ctxt->op != BLE_GATT_REGISTER_OP_CHR) return;
    if (ble_uuid_cmp(ctxt->chr.chr_def->uuid, &CHR_LEVEL_UUID.u) == 0) {
        transport_ble_set_val_handle(BLE_SUB_BATTERY_LEVEL,
                                     ctxt->chr.val_handle);
        ESP_LOGD(TAG, "battery level val_handle=%u", ctxt->chr.val_handle);
    }
}

void ble_service_battery_push(uint8_t soc_pct, uint16_t mv, uint8_t charging)
{
    if (soc_pct > 100) soc_pct = 100;
    g_soc_pct  = soc_pct;
    g_mv       = mv;
    g_charging = charging;

    (void)transport_ble_notify(BLE_SUB_BATTERY_LEVEL, &g_soc_pct, 1);
}

uint8_t ble_service_battery_get_soc(void)
{
    return g_soc_pct;
}
