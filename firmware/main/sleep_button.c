/*
 * sleep_button.c — see sleep_button.h for behaviour.
 *
 * Implementation: a low-priority polling task (50 Hz) reads
 * SLEEP_BUTTON_GPIO with an internal pull-up. An external tactile
 * button between the pin and GND shorts it to GND when pressed, so a
 * press reads as level 0.
 *
 * Wake source on ESP32-C6: esp_deep_sleep_enable_gpio_wakeup() with
 * ESP_GPIO_WAKEUP_GPIO_LOW — same pin, woken when held LOW (button
 * pressed). Requires the pin to be in the LP_IO domain (GPIO0–GPIO7
 * on C6); HP-domain pins are powered down in deep sleep and will be
 * rejected with ESP_ERR_INVALID_ARG. The chip resets out of deep
 * sleep, so app_main runs from the top again.
 *
 * Startup grace period: after boot we wait WAKE_GRACE_MS before arming,
 * giving the user time to release the wake-press without immediately
 * counting it as a sleep-press.
 */

#include "sleep_button.h"

#include "driver/gpio.h"
#include "driver/rtc_io.h"
#include "esp_log.h"
#include "esp_sleep.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "sdkconfig.h"

#include "led_status.h"
#include "ppg_driver_max3010x.h"
#include "transport_ble.h"

static const char *TAG = "sleep_button";

#define SLEEP_BUTTON_GPIO       GPIO_NUM_2    /* D2 on XIAO ESP32-C6 (LP_IO; external tactile button to GND) */
#define SLEEP_BUTTON_HOLD_MS    5000          /* hold ≥ 5 s to enter sleep */
#define POLL_PERIOD_MS          50
#define WAKE_GRACE_MS           1500          /* don't arm until user releases wake-press */

static void enter_deep_sleep(void) {
    ESP_LOGW(TAG, "sleep requested — release the button to enter deep sleep");
    /* Trigger the 3-fast-pulse sleep-entry indicator so the user sees a
     * positive confirmation that the 5 s hold registered. The animation
     * runs concurrently with the wait-for-release loop below and auto-
     * clears to OFF after 600 ms. SLEEP_ENTRY has the highest priority
     * (above BATTERY_CRIT) so it overrides whatever was on the LED. */
    led_status_set_state(LED_STATE_SLEEP_ENTRY);

    /* CRITICAL: ESP_GPIO_WAKEUP_GPIO_LOW is *level*-triggered, not edge.
     * If we call esp_deep_sleep_start() while the user is still holding
     * the button (pin LOW), the wake fires immediately and the chip
     * resets right back up — looking like sleep never happened. Wait
     * here until the button is released, then arm wake and sleep. */
    while (gpio_get_level(SLEEP_BUTTON_GPIO) == 0) {
        vTaskDelay(pdMS_TO_TICKS(POLL_PERIOD_MS));
    }

    ESP_LOGW(TAG, "entering deep sleep — wake by pressing GPIO%d", SLEEP_BUTTON_GPIO);

    /* 1. Tear down peripherals BEFORE arming wake. Mirrors Edge's
     * pre-sleep sequence (EDGE/EDGE FIRMWARE/main/main.c:4374-4378
     * + v4.11.1 changelog: "full teardown via bluedroid_disable/deinit
     * + bt_controller_disable/deinit. Radio is completely off; no
     * RF activity of any kind"). Earclip adds MAX3010x SHDN which
     * Edge doesn't need.
     *
     *   - ppg_driver_deinit() writes MAX3010X_MODE_SHDN, deletes the
     *     I2C master bus + GPIO ISR. Sensor drops to <0.7 µA standby.
     *     Single biggest power win on the earclip — without this the
     *     sensor keeps pulsing red+IR LEDs at idle.
     *   - transport_ble_deinit() runs ble_gap_adv_stop, terminates
     *     active peers cleanly, then nimble_port_stop +
     *     nimble_port_deinit. Brings the BLE controller fully cold —
     *     also releases its timer wake source so step 2 mostly catches
     *     anything leftover. */
    ESP_LOGI(TAG, "shutting down PPG sensor (MAX3010x SHDN)…");
    esp_err_t perr = ppg_driver_deinit();
    if (perr != ESP_OK) {
        ESP_LOGW(TAG, "ppg_driver_deinit rc=%s — proceeding anyway",
                 esp_err_to_name(perr));
    }
    ESP_LOGI(TAG, "shutting down BLE radio…");
    esp_err_t berr = transport_ble_deinit();
    if (berr != ESP_OK) {
        ESP_LOGW(TAG, "transport_ble_deinit rc=%s — proceeding anyway",
                 esp_err_to_name(berr));
    }

    /* 2. Switch the pin into LP_IO / RTC mode and configure the pull-up
     * there. Calling rtc_gpio_pullup_en() alone on a pin that is still
     * routed to the HP GPIO matrix can silently no-op — the pin needs
     * to be claimed by the LP_IO peripheral first via rtc_gpio_init().
     * Without this, the pin floats in deep sleep and false-wakes. */
    rtc_gpio_init(SLEEP_BUTTON_GPIO);
    rtc_gpio_set_direction(SLEEP_BUTTON_GPIO, RTC_GPIO_MODE_INPUT_ONLY);
    rtc_gpio_pullup_en(SLEEP_BUTTON_GPIO);
    rtc_gpio_pulldown_dis(SLEEP_BUTTON_GPIO);

    /* 3. CRITICAL ORDER: disable-all + enable-gpio-wake must be the
     * very LAST things before esp_deep_sleep_start, with NO blocking
     * call (vTaskDelay etc.) in between. Otherwise esp_pm's tickless
     * light sleep slips into the gap and re-arms a timer wake source
     * for its own scheduling — which then fires immediately after
     * deep sleep starts, giving wake_cause=TIMER on the next boot.
     *
     * The previous version had a disable_all earlier in this function
     * plus a 150 ms vTaskDelay before sleep — confirmed via boot diag
     * that the delay was long enough for esp_pm to undo the disable.
     * Drop the delay (radio is already off after the fast BT-controller
     * disable, nothing to drain) and do disable_all right here. */
    esp_sleep_disable_wakeup_source(ESP_SLEEP_WAKEUP_ALL);
    esp_err_t err = esp_deep_sleep_enable_gpio_wakeup(
        1ULL << SLEEP_BUTTON_GPIO,
        ESP_GPIO_WAKEUP_GPIO_LOW);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "gpio_wakeup setup failed: %s — aborting sleep",
                 esp_err_to_name(err));
        return;
    }

    /* Final pre-sleep diagnostic. If level=0 here, the pull-up did not
     * hold and the chip will false-wake immediately. If level=1, sleep
     * should hold until the user actually presses. */
    ESP_LOGW(TAG, "pre-sleep: rtc_gpio%d=%d (expect 1 = pulled up)",
             SLEEP_BUTTON_GPIO, rtc_gpio_get_level(SLEEP_BUTTON_GPIO));

    esp_deep_sleep_start();
    /* Never returns; chip resets on wake. */
}

static void sleep_button_task(void *arg) {
    (void)arg;

    gpio_config_t io = {
        .pin_bit_mask = 1ULL << SLEEP_BUTTON_GPIO,
        .mode         = GPIO_MODE_INPUT,
        .pull_up_en   = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type    = GPIO_INTR_DISABLE,
    };
    esp_err_t err = gpio_config(&io);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "gpio_config failed: %s", esp_err_to_name(err));
        vTaskDelete(NULL);
        return;
    }

    /* Wait for the wake-button to be released before arming, so a
     * lingering press doesn't immediately re-sleep. */
    vTaskDelay(pdMS_TO_TICKS(WAKE_GRACE_MS));
    while (gpio_get_level(SLEEP_BUTTON_GPIO) == 0) {
        vTaskDelay(pdMS_TO_TICKS(POLL_PERIOD_MS));
    }

#if CONFIG_NARBIS_IDLE_SLEEP_TIMEOUT_S > 0
    const int64_t idle_timeout_us =
        (int64_t)CONFIG_NARBIS_IDLE_SLEEP_TIMEOUT_S * 1000LL * 1000LL;
    ESP_LOGI(TAG, "armed on GPIO%d (hold %d ms = manual sleep, idle timeout %ds)",
             SLEEP_BUTTON_GPIO, SLEEP_BUTTON_HOLD_MS,
             CONFIG_NARBIS_IDLE_SLEEP_TIMEOUT_S);
#else
    ESP_LOGI(TAG, "armed on GPIO%d (hold %d ms to sleep, idle timeout disabled)",
             SLEEP_BUTTON_GPIO, SLEEP_BUTTON_HOLD_MS);
#endif

    uint32_t held_ms = 0;
    /* Idle-sleep timer. Counts elapsed time during which zero BLE peers
     * are connected. Reset to "now" on any poll where a peer is present.
     * Initialized to "now" at task entry so a device that never gets a
     * peer after boot still falls asleep on schedule. */
    int64_t idle_since_us = esp_timer_get_time();
    while (1) {
        bool pressed = (gpio_get_level(SLEEP_BUTTON_GPIO) == 0);
        if (pressed) {
            held_ms += POLL_PERIOD_MS;
            if (held_ms >= SLEEP_BUTTON_HOLD_MS) {
                enter_deep_sleep();   /* normally never returns; only on failure */
                held_ms = 0;          /* defensive: require fresh hold to retry */
                idle_since_us = esp_timer_get_time();
            }
        } else {
            held_ms = 0;
        }

#if CONFIG_NARBIS_IDLE_SLEEP_TIMEOUT_S > 0
        /* Idle-driven deep sleep: same destination as the button hold,
         * just triggered by "no central for a while" instead of a
         * physical press. enter_deep_sleep waits for any held button
         * to be released first — when arriving from the idle path the
         * button is up, so that wait falls through immediately. */
        if (transport_ble_any_connected()) {
            idle_since_us = esp_timer_get_time();
        } else if ((esp_timer_get_time() - idle_since_us) >= idle_timeout_us) {
            ESP_LOGW(TAG, "idle for %ds with no BLE peer — entering deep sleep",
                     CONFIG_NARBIS_IDLE_SLEEP_TIMEOUT_S);
            enter_deep_sleep();
            idle_since_us = esp_timer_get_time();   /* defensive: only reached on failure */
        }
#endif

        vTaskDelay(pdMS_TO_TICKS(POLL_PERIOD_MS));
    }
}

esp_err_t sleep_button_init(void) {
    /* Light task — 2 KB stack is plenty for a polling loop + a few
     * gpio + log calls. Priority 2 keeps it above the idle task but
     * well below ppg sampling and BLE host tasks. */
    BaseType_t r = xTaskCreate(sleep_button_task, "sleep_btn",
                               2048, NULL, 2, NULL);
    return (r == pdPASS) ? ESP_OK : ESP_FAIL;
}
