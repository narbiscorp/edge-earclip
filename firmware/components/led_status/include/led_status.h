/*
 * led_status.h — onboard user-LED status indicator for the Narbis earclip.
 *
 * Renders smooth sine-driven brightness on the XIAO ESP32-C6's onboard
 * orange user LED (GPIO15, active-low handled in hardware via LEDC's
 * output_invert flag — callers think in terms of 0..255 brightness, not
 * GPIO level).
 *
 * Usage:
 *   1. Call led_status_init() once at boot.
 *   2. Call led_status_set_state(LED_STATE_BOOT) to play the boot
 *      animation (auto-returns to OFF after ~1.5 s).
 *   3. Other modules (BLE, battery monitor, sleep) drive the state via
 *      led_status_set_state() — this component knows nothing about the
 *      callers and does not include their headers.
 *
 * Priority enforcement (high → low):
 *     BATTERY_CRIT > BATTERY_LOW > PAIRING > STREAMING > BOOT > OFF
 * Setting a lower-priority state from a higher one is rejected so a
 * battery alert can't be silenced by a routine BLE event. Explicit clear
 * to OFF is always allowed (call OFF then set the new state when you
 * really do need to downgrade — e.g. on battery recovery).
 */

#pragma once

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    LED_STATE_OFF = 0,
    LED_STATE_BOOT,             /* one-shot ~1.5 s, auto-returns to OFF */
    LED_STATE_PAIRING,          /* continuous breathing, 1 Hz, 60% peak */
    LED_STATE_STREAMING,        /* single soft pulse every 5 s, 30% peak */
    LED_STATE_BATTERY_LOW,      /* double pulse every 5 s, 50% peak */
    LED_STATE_BATTERY_CRIT,     /* rapid pulse 2 Hz, 10 s timeout, full bright */
} led_state_t;

/* Bring up LEDC + the 50 Hz tick timer. Initial state is OFF. */
esp_err_t led_status_init(void);

/* Request a state change. Non-blocking; reflected within ≤20 ms (one tick).
 * Subject to priority — see header comment. */
void led_status_set_state(led_state_t state);

led_state_t led_status_get_state(void);

/* Convenience wrapper for BLE-state callers: request a "base" state
 * (PAIRING or STREAMING) without silencing an active battery alert.
 *
 * Background: priority enforcement in led_status_set_state() blocks the
 * PAIRING → STREAMING transition because PAIRING (3) > STREAMING (2).
 * The handoff spec's §8 note acknowledges this: "If callers need to
 * force-downgrade, they should call OFF first, then set the new state.
 * Or add a `led_status_force_state()` variant if cleaner." Doing the
 * OFF/set dance unguarded would also clear an active BATTERY_LOW /
 * BATTERY_CRIT — which is exactly the wrong behavior. This helper does
 * the dance only when the current state is one of OFF/BOOT/PAIRING/
 * STREAMING, leaving battery alerts intact. */
void led_status_request_base_state(led_state_t state);

#ifdef __cplusplus
}
#endif
