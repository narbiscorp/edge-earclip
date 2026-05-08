#ifndef NARBIS_BLE_OTA_H
#define NARBIS_BLE_OTA_H

#include "esp_err.h"
#include "host/ble_gatt.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Initialise OTA module state (queue, mutex, task). The GATT service
 * itself is registered through the transport_ble.c svc_defs path; call
 * this once at boot AFTER transport_ble_init(). */
esp_err_t ble_ota_init(void);
esp_err_t ble_ota_deinit(void);

/* GATT plumbing — consumed by transport_ble.c. Same shape as the other
 * service modules (dis / battery / hrs / narbis). */
const struct ble_gatt_svc_def *ble_ota_svc_defs(void);
void ble_ota_on_register(struct ble_gatt_register_ctxt *ctxt);

/* Notify the OTA module that a BLE central just disconnected. If an OTA
 * session is currently active, this queues a cancel — preventing the
 * next reconnect from being rejected with NARBIS_OTA_ERR_ALREADY_IN_OTA
 * because the previous attempt died mid-flight without sending CANCEL.
 *
 * Safe to call before/after init; it no-ops when the module is down.
 * Idempotent — calling again while a cancel is already queued is fine. */
void ble_ota_on_disconnect(uint16_t conn_handle);

/* First-connect rollback validity self-test.
 *
 * On boot, if the running partition is an OTA slot in
 * ESP_OTA_IMG_PENDING_VERIFY state, spawn a one-shot task that waits up
 * to CONFIG_NARBIS_OTA_VALIDITY_TIMEOUT_S for the first BLE client
 * connection. On connect, calls esp_ota_mark_app_valid_cancel_rollback()
 * so the new image is committed. On timeout, exits without marking —
 * the bootloader will roll back to the previous slot on the next reset.
 *
 * No-op when running from the factory partition. Idempotent. */
esp_err_t ble_ota_validity_selftest_kickoff(void);

#ifdef __cplusplus
}
#endif

#endif /* NARBIS_BLE_OTA_H */
