/*
 * sleep_button.h — user-initiated deep-sleep / wake via an external
 * tactile button on D2 (GPIO2) of the XIAO ESP32-C6.
 *
 * Hardware: requires a SPST momentary button soldered between the D2
 * pad and a GND pad. The on-board BOOT button (GPIO9) cannot drive
 * this — ESP32-C6 deep-sleep GPIO wake is restricted to LP_IO pins
 * (GPIO0–GPIO7), and GPIO9 is also a strapping pin (would trap the
 * chip in download mode on wake). D2 is the only LP_IO Seeed breaks
 * out that isn't already taken by PPG INT (D0/GPIO0) or battery sense
 * (D1/GPIO1).
 *
 * Usage:
 *   sleep_button_init();      // call once from app_main, after BLE/PPG up
 *
 * Behaviour:
 *   - Hold the button for SLEEP_BUTTON_HOLD_MS (default 2 s) → device
 *     enters deep sleep. BLE advertising stops, PPG sampling stops, the
 *     MAX3010x is shut down by the driver's normal disconnect path, and
 *     the chip is brought down to ~5 µA.
 *   - Pressing the same button wakes the chip. Wake from deep sleep on
 *     ESP32-C6 = full reset, so app_main runs again from the top —
 *     paired-glasses MAC + persisted config survive in NVS.
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
