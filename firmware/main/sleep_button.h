/*
 * sleep_button.h — user-initiated deep-sleep / wake via the XIAO
 * ESP32-C6 BOOT button (GPIO9).
 *
 * Usage:
 *   sleep_button_init();      // call once from app_main, after BLE/PPG up
 *
 * Behaviour:
 *   - Hold the button for SLEEP_BUTTON_HOLD_MS (default 2 s) → device
 *     enters deep sleep. BLE advertising stops, PPG sampling stops, the
 *     MAX3010x is shut down by the driver's normal disconnect path, and
 *     the chip is brought down to ~5 µA.
 *   - Pressing the same button (rising edge of the wake signal) wakes
 *     the chip. Wake from deep sleep on ESP32-C6 = full reset, so app_main
 *     runs again from the top — paired-glasses MAC + persisted config
 *     survive in NVS.
 *
 * Note: CLAUDE.md says "never use deep sleep on the earclip" — that rule
 * is about the *idle path during continuous sampling* (use light sleep
 * via esp_pm there). User-initiated sleep is a different regime — it's
 * an explicit "off" gesture, not a battery-saving trick during operation.
 */

#ifndef NARBIS_SLEEP_BUTTON_H
#define NARBIS_SLEEP_BUTTON_H

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

esp_err_t sleep_button_init(void);

#ifdef __cplusplus
}
#endif

#endif /* NARBIS_SLEEP_BUTTON_H */
