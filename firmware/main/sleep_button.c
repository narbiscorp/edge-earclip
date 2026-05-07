/*
 * sleep_button.c — see sleep_button.h for behaviour.
 *
 * Implementation: a low-priority polling task (50 Hz) reads GPIO9 with
 * an internal pull-up. The XIAO ESP32-C6's BOOT button shorts GPIO9 to
 * GND when pressed, so a press reads as level 0.
 *
 * Wake source on ESP32-C6: esp_deep_sleep_enable_gpio_wakeup() with
 * ESP_GPIO_WAKEUP_GPIO_LOW — same pin, woken when held LOW (button
 * pressed). The chip resets out of deep sleep, so app_main runs from
 * the top again.
 *
 * Startup grace period: after boot we wait WAKE_GRACE_MS before arming,
 * giving the user time to release the wake-press without immediately
 * counting it as a sleep-press.
 */

#include "sleep_button.h"

#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_sleep.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "sleep_button";

#define SLEEP_BUTTON_GPIO       GPIO_NUM_9    /* XIAO ESP32-C6 BOOT button */
#define SLEEP_BUTTON_HOLD_MS    2000          /* hold ≥ 2 s to enter sleep */
#define POLL_PERIOD_MS          50
#define WAKE_GRACE_MS           1500          /* don't arm until user releases wake-press */

static void enter_deep_sleep(void) {
    ESP_LOGW(TAG, "entering deep sleep — wake by pressing GPIO%d", SLEEP_BUTTON_GPIO);

    /* Arm the same pin as wake source. ESP_GPIO_WAKEUP_GPIO_LOW means
     * the chip wakes when the pin is LOW (button pressed). The button
     * has an internal pull-up; pressing connects to GND. */
    esp_err_t err = esp_deep_sleep_enable_gpio_wakeup(
        1ULL << SLEEP_BUTTON_GPIO,
        ESP_GPIO_WAKEUP_GPIO_LOW);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "gpio_wakeup setup failed: %s — aborting sleep",
                 esp_err_to_name(err));
        return;
    }

    /* Brief delay so the log line + any in-flight BLE notify drain
     * before the radio shuts down. */
    vTaskDelay(pdMS_TO_TICKS(150));

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

    ESP_LOGI(TAG, "armed on GPIO%d (hold %d ms to sleep)",
             SLEEP_BUTTON_GPIO, SLEEP_BUTTON_HOLD_MS);

    uint32_t held_ms = 0;
    while (1) {
        bool pressed = (gpio_get_level(SLEEP_BUTTON_GPIO) == 0);
        if (pressed) {
            held_ms += POLL_PERIOD_MS;
            if (held_ms >= SLEEP_BUTTON_HOLD_MS) {
                enter_deep_sleep();
                /* Unreachable. */
            }
        } else {
            held_ms = 0;
        }
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
