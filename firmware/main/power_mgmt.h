#ifndef NARBIS_POWER_MGMT_H
#define NARBIS_POWER_MGMT_H

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Configures esp_pm light sleep, creates pm_locks, and (when the battery
 * divider hardware mod is present) starts the ADC sampler + LUT. Owns the
 * 30 s tick that pushes battery state to ESP-NOW and BLE. */
esp_err_t power_mgmt_init(void);
esp_err_t power_mgmt_deinit(void);

/* Snapshot read of the cached battery state. Never blocks on the ADC.
 * When NARBIS_BATT_DIVIDER_PRESENT=n, returns 4000 mV / 80% / not-charging
 * with a rate-limited STUB warning. */
esp_err_t power_mgmt_get_battery(uint16_t *mv, uint8_t *soc_pct, uint8_t *charging);

/* Live-toggle light sleep. Calls esp_pm_configure() with the new policy. */
esp_err_t power_mgmt_set_light_sleep_enabled(bool enabled);

/* True if SoC is high enough to allow OTA (≥ 30%). Stage 08 uses this. */
bool power_mgmt_can_ota(void);

/* Take/release the BLE-active pm_lock. Held by transport_ble.c during
 * notification bursts so light sleep can't fire mid-notification. */
void power_mgmt_acquire_ble_active(void);
void power_mgmt_release_ble_active(void);

/* Dump everything we know about the current power state to the log:
 * esp_pm config, who's holding pm_locks, Wi-Fi PS mode, current CPU
 * frequency, MAX3010x LED currents, free heap. Cheap (one-shot) — call
 * at boot and from periodic ticks while debugging high-current draw. */
void power_mgmt_log_diagnostics(const char *reason);

#ifdef __cplusplus
}
#endif

#endif /* NARBIS_POWER_MGMT_H */
