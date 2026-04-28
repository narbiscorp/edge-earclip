#ifndef NARBIS_TRANSPORT_BLE_H
#define NARBIS_TRANSPORT_BLE_H

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#include "narbis_protocol.h"
#include "ppg_driver_max3010x.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    BLE_SUB_HRS_HR_MEASUREMENT = 0,
    BLE_SUB_BATTERY_LEVEL,
    BLE_SUB_NARBIS_IBI,
    BLE_SUB_NARBIS_SQI,
    BLE_SUB_NARBIS_RAW_PPG,
    BLE_SUB_NARBIS_BATTERY,
    BLE_SUB_NARBIS_CONFIG,
    BLE_SUB_NARBIS_DIAGNOSTICS,
    BLE_SUB_COUNT,
} ble_subscription_t;

esp_err_t transport_ble_init(void);
esp_err_t transport_ble_deinit(void);

/* Returns true if a central is connected and has CCCD-enabled the given
 * characteristic. Used by main.c and the per-service push helpers to gate
 * notify work. */
bool transport_ble_is_subscribed(ble_subscription_t which);

/* Returns the negotiated ATT MTU for the active connection, or 23 if no
 * exchange has happened yet. 0 if no connection. */
uint16_t transport_ble_get_mtu(void);

/* Returns active conn handle (or BLE_HS_CONN_HANDLE_NONE-equivalent 0xFFFF). */
uint16_t transport_ble_get_conn_handle(void);

/* Apply BLE profile (connection-interval + slave-latency change). Called
 * by ble_service_narbis when the central writes MODE / CONFIG. */
esp_err_t transport_ble_set_profile(uint8_t ble_profile);

/* Per-characteristic value handles, looked up after gatts_register_cb runs.
 * Returns 0 if the characteristic is not yet registered. */
uint16_t transport_ble_val_handle(ble_subscription_t which);

/* Cache the value handle for `which` once NimBLE assigns it (called from
 * each service module's gatts_register_cb after a CHR is registered). */
void transport_ble_set_val_handle(ble_subscription_t which, uint16_t val_handle);

/* Convenience notify helper: emits `data[0..len)` as a single notification
 * on the given characteristic. Caller is responsible for upper-layer gating
 * (data_format, profile) — this only checks subscription. */
esp_err_t transport_ble_notify(ble_subscription_t which,
                               const uint8_t *data, uint16_t len);

/* High-level sends used by main.c — internally gated by subscription, profile,
 * and data_format. Cheap no-ops when nothing should go out. */
esp_err_t transport_ble_send_beat(const beat_event_t *beat);
esp_err_t transport_ble_send_raw_sample(const ppg_sample_t *sample,
                                        uint16_t sample_rate_hz,
                                        uint8_t data_format);
esp_err_t transport_ble_send_battery(uint8_t soc_pct, uint16_t mv, uint8_t charging);

/* Re-emit the current runtime config snapshot to subscribed clients. */
esp_err_t transport_ble_notify_config(void);

#ifdef __cplusplus
}
#endif

#endif /* NARBIS_TRANSPORT_BLE_H */
