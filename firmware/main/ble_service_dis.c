/*
 * ble_service_dis.c — Device Information Service (0x180A).
 *
 * Read-only static strings. No writes, no notifies. Manufacturer/model/
 * hardware are compile-time constants; firmware version comes from the
 * application descriptor; serial is the BLE MAC.
 */

#include "ble_service_dis.h"

#include <stdio.h>
#include <string.h>

#include "esp_app_desc.h"
#include "esp_log.h"
#include "esp_mac.h"

#include "host/ble_gatt.h"
#include "host/ble_uuid.h"
#include "os/os_mbuf.h"

static const char *TAG = "ble_service_dis";

static const char DIS_MANUFACTURER[] = "Narbis Inc.";
static const char DIS_MODEL[]        = "Earclip-001";
static const char DIS_HARDWARE[]     = "C6_proto_rev1";
static char       g_dis_firmware[24] = "0.1.0";
static char       g_dis_serial[18]   = "000000000000";

static int dis_access_cb(uint16_t conn_handle, uint16_t attr_handle,
                         struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn_handle; (void)attr_handle;
    const char *s = (const char *)arg;
    int rc = os_mbuf_append(ctxt->om, s, strlen(s));
    return rc == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
}

static const ble_uuid16_t SVC_UUID = BLE_UUID16_INIT(0x180A);
static const ble_uuid16_t CHR_MFR  = BLE_UUID16_INIT(0x2A29);
static const ble_uuid16_t CHR_MODEL_NUM = BLE_UUID16_INIT(0x2A24);
static const ble_uuid16_t CHR_HW_REV    = BLE_UUID16_INIT(0x2A27);
static const ble_uuid16_t CHR_FW_REV    = BLE_UUID16_INIT(0x2A26);
static const ble_uuid16_t CHR_SERIAL    = BLE_UUID16_INIT(0x2A25);

static const struct ble_gatt_chr_def DIS_CHARACTERISTICS[] = {
    {
        .uuid       = &CHR_MFR.u,
        .access_cb  = dis_access_cb,
        .arg        = (void *)DIS_MANUFACTURER,
        .flags      = BLE_GATT_CHR_F_READ,
    },
    {
        .uuid       = &CHR_MODEL_NUM.u,
        .access_cb  = dis_access_cb,
        .arg        = (void *)DIS_MODEL,
        .flags      = BLE_GATT_CHR_F_READ,
    },
    {
        .uuid       = &CHR_HW_REV.u,
        .access_cb  = dis_access_cb,
        .arg        = (void *)DIS_HARDWARE,
        .flags      = BLE_GATT_CHR_F_READ,
    },
    {
        .uuid       = &CHR_FW_REV.u,
        .access_cb  = dis_access_cb,
        .arg        = g_dis_firmware,
        .flags      = BLE_GATT_CHR_F_READ,
    },
    {
        .uuid       = &CHR_SERIAL.u,
        .access_cb  = dis_access_cb,
        .arg        = g_dis_serial,
        .flags      = BLE_GATT_CHR_F_READ,
    },
    { 0 }
};

static const struct ble_gatt_svc_def DIS_SVC_DEFS[] = {
    {
        .type            = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid            = &SVC_UUID.u,
        .characteristics = DIS_CHARACTERISTICS,
    },
    { 0 }
};

esp_err_t ble_service_dis_init(void)
{
    const esp_app_desc_t *desc = esp_app_get_description();
    if (desc != NULL && desc->version[0] != '\0') {
        strncpy(g_dis_firmware, desc->version, sizeof(g_dis_firmware) - 1);
        g_dis_firmware[sizeof(g_dis_firmware) - 1] = '\0';
    }
    uint8_t mac[6] = {0};
    if (esp_read_mac(mac, ESP_MAC_BT) == ESP_OK) {
        snprintf(g_dis_serial, sizeof(g_dis_serial),
                 "%02X%02X%02X%02X%02X%02X",
                 mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    }
    ESP_LOGI(TAG, "DIS fw=%s serial=%s", g_dis_firmware, g_dis_serial);
    return ESP_OK;
}

esp_err_t ble_service_dis_deinit(void)
{
    return ESP_OK;
}

const struct ble_gatt_svc_def *ble_service_dis_svc_defs(void)
{
    return DIS_SVC_DEFS;
}

void ble_service_dis_on_register(struct ble_gatt_register_ctxt *ctxt)
{
    (void)ctxt;
}
