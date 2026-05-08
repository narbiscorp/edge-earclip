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

/* Maximum simultaneous BLE centrals the earclip will accept. Path B
 * supports 2 (dashboard + glasses); 3 leaves headroom for a debug client.
 * Must match CONFIG_BT_NIMBLE_MAX_CONNECTIONS in sdkconfig.defaults. */
#define NARBIS_BLE_MAX_CONNECTIONS 3

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

/* Returns true if any currently-connected central has CCCD-enabled the
 * given characteristic. Used to gate notify work — it's wasteful to
 * compute a payload nobody's listening to. */
bool transport_ble_is_subscribed(ble_subscription_t which);

/* Returns the lowest MTU among active connections, or 23 if none. */
uint16_t transport_ble_get_mtu(void);

/* True iff at least one BLE central is currently connected. */
bool transport_ble_any_connected(void);

/* Count of currently-connected centrals (0..NARBIS_BLE_MAX_CONNECTIONS).
 * Used by the periodic status summary log. */
uint8_t transport_ble_active_peer_count(void);

/* Returns the connection handle of any currently-connected central, or
 * 0xFFFF if none. Used by ble_ota and diagnostics — best-effort, picks
 * the first active slot. Prefer transport_ble_notify() for per-peer
 * fan-out where possible. */
uint16_t transport_ble_get_conn_handle(void);

/* Apply a BLE profile (connection-interval + slave-latency change) to
 * all currently-connected centrals. Called by config_manager when the
 * runtime ble_profile changes. Per-peer role-based profiles set via
 * transport_ble_set_peer_role() override this on the next role write. */
esp_err_t transport_ble_set_profile(uint8_t ble_profile);

/* Set the role for the given connection and apply the matching default
 * profile (DASHBOARD → LOW_LATENCY, GLASSES → BATCHED). Called by
 * ble_service_narbis when the central writes CHR_PEER_ROLE. */
esp_err_t transport_ble_set_peer_role(uint16_t conn_handle, narbis_peer_role_t role);

/* Per-characteristic value handles, looked up after gatts_register_cb runs.
 * Returns 0 if the characteristic is not yet registered. */
uint16_t transport_ble_val_handle(ble_subscription_t which);

void transport_ble_set_val_handle(ble_subscription_t which, uint16_t val_handle);

/* Convenience notify helper: emits `data[0..len)` as a single notification
 * to every subscribed peer on the given characteristic. */
esp_err_t transport_ble_notify(ble_subscription_t which,
                               const uint8_t *data, uint16_t len);

esp_err_t transport_ble_send_beat(const beat_event_t *beat);
esp_err_t transport_ble_send_raw_sample(const ppg_sample_t *sample,
                                        uint16_t sample_rate_hz,
                                        uint8_t data_format);
esp_err_t transport_ble_send_battery(uint8_t soc_pct, uint16_t mv, uint8_t charging);

esp_err_t transport_ble_notify_config(void);

/* Block until the first BLE central connects after boot, or `timeout_ms`
 * elapses. One-shot per boot — used by the OTA validity self-test. */
esp_err_t transport_ble_wait_first_connect(uint32_t timeout_ms);

#ifdef __cplusplus
}
#endif

#endif /* NARBIS_TRANSPORT_BLE_H */
