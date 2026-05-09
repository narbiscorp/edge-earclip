/*
 * led_status.c — see led_status.h.
 *
 * Architecture:
 *   - LEDC peripheral, low-speed mode, channel 0, 8-bit duty, 5 kHz PWM.
 *   - flags.output_invert = 1 handles active-low in hardware: write
 *     brightness 0..255 directly, where 0 = off, 255 = full bright.
 *   - One esp_timer periodic callback at 50 Hz (20 ms). Computes
 *     brightness from (state, time_in_state) and writes LEDC duty.
 *   - State + entry timestamp guarded by portMUX. Renderers run on the
 *     timer task — single-reader from there.
 *   - Gamma 2.2 correction at the LEDC write step so pulses look smooth
 *     (linear duty looks "plateau-y" because human brightness perception
 *     is logarithmic).
 */

#include "led_status.h"

#include "driver/ledc.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/portmacro.h"

#include <math.h>
#include <stdbool.h>
#include <stdint.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846f
#endif

static const char *TAG = "led_status";

#define LED_GPIO            15
#define LED_LEDC_TIMER      LEDC_TIMER_0
#define LED_LEDC_MODE       LEDC_LOW_SPEED_MODE
#define LED_LEDC_CHANNEL    LEDC_CHANNEL_0
#define LED_LEDC_FREQ_HZ    5000
#define LED_LEDC_RES        LEDC_TIMER_8_BIT
#define LED_TICK_PERIOD_US  (20 * 1000)   /* 50 Hz */

static portMUX_TYPE       s_lock = portMUX_INITIALIZER_UNLOCKED;
static led_state_t        s_state = LED_STATE_OFF;
static int64_t            s_state_entered_us = 0;
static esp_timer_handle_t s_tick_timer = NULL;

/* Pre-computed gamma 2.2 LUT — beats calling powf() 50 times/s. Generated
 * lazily on first init so we don't pay the cost when LED is disabled. */
static uint8_t s_gamma_lut[256];
static bool    s_gamma_ready = false;

static void build_gamma_lut(void)
{
    for (int i = 0; i < 256; i++) {
        float n = (float)i / 255.0f;
        s_gamma_lut[i] = (uint8_t)(255.0f * powf(n, 2.2f) + 0.5f);
    }
    s_gamma_ready = true;
}

static inline float seconds_in_state(int64_t now_us, int64_t entered_us)
{
    return (float)(now_us - entered_us) / 1.0e6f;
}

/* === Renderers ===========================================================
 * All return brightness in [0, 255]. `t` is seconds since state entry.
 * Boot and battery_crit self-transition to OFF when their animation ends.
 */

static uint8_t render_boot(float t)
{
    if (t < 0.5f) {
        return (uint8_t)(255.0f * sinf(M_PI / 2.0f * (t / 0.5f)));
    } else if (t < 0.7f) {
        return 255;
    } else if (t < 1.5f) {
        return (uint8_t)(255.0f * cosf(M_PI / 2.0f * ((t - 0.7f) / 0.8f)));
    }
    led_status_set_state(LED_STATE_OFF);
    return 0;
}

static uint8_t render_pairing(float t)
{
    /* Full sine at 60% peak, 1 Hz, phase-shifted so first breath rises in
     * from 0 rather than starting mid-amplitude. */
    return (uint8_t)(76.5f * (1.0f + sinf(2.0f * M_PI * t - M_PI / 2.0f)));
}

static uint8_t render_streaming(float t)
{
    /* 3 fast half-sine pulses (100 ms on / 100 ms off, 60% peak) at the
     * start of every 3 s window, then dark for the remaining 2.4 s.
     * Tells user "device is streaming PPG data normally" — distinct from
     * the sparser BATTERY_LOW double-pulse and the urgent SLEEP_ENTRY /
     * BATTERY_CRIT full-brightness rapid pulses. */
    float c = fmodf(t, 3.0f);
    if (c >= 0.6f) return 0;            /* dark portion of cycle */
    float p = fmodf(c, 0.2f);           /* 200 ms cycle: 100 ms pulse + 100 ms gap */
    if (p < 0.1f) {
        return (uint8_t)(153.0f * sinf(M_PI * p / 0.1f));
    }
    return 0;
}

static uint8_t render_battery_low(float t)
{
    /* Two 250 ms half-sine pulses, 200 ms gap, then ~4.3 s dark.
     * Peak 50%. Repeats every 5 s. */
    float c = fmodf(t, 5.0f);
    if (c < 0.25f)        return (uint8_t)(128.0f * sinf(M_PI * c / 0.25f));
    else if (c < 0.45f)   return 0;
    else if (c < 0.70f)   return (uint8_t)(128.0f * sinf(M_PI * (c - 0.45f) / 0.25f));
    return 0;
}

static uint8_t render_battery_crit(float t)
{
    /* 2 Hz cadence: 200 ms half-sine pulse, 300 ms gap, full brightness.
     * Auto-clears to OFF after 10 s — caller is expected to be initiating
     * shutdown around the same point. */
    if (t > 10.0f) {
        led_status_set_state(LED_STATE_OFF);
        return 0;
    }
    float c = fmodf(t, 0.5f);
    if (c < 0.2f) {
        return (uint8_t)(255.0f * sinf(M_PI * c / 0.2f));
    }
    return 0;
}

static uint8_t render_sleep_entry(float t)
{
    /* 3 fast half-sine pulses, 100 ms on / 100 ms off, full brightness.
     * Total 600 ms. Tells the user "you've held long enough — sleep is
     * engaging now." Auto-clears to OFF after the third pulse so the
     * subsequent deep_sleep_start hits a quiet LED. */
    if (t >= 0.6f) {
        led_status_set_state(LED_STATE_OFF);
        return 0;
    }
    /* 200 ms cycle: 100 ms pulse + 100 ms gap. */
    float c = fmodf(t, 0.2f);
    if (c < 0.1f) {
        return (uint8_t)(255.0f * sinf(M_PI * c / 0.1f));
    }
    return 0;
}

/* === Tick callback ======================================================= */

static void tick_cb(void *arg)
{
    (void)arg;

    led_state_t st;
    int64_t     entered;

    portENTER_CRITICAL(&s_lock);
    st      = s_state;
    entered = s_state_entered_us;
    portEXIT_CRITICAL(&s_lock);

    int64_t now = esp_timer_get_time();
    float   t   = seconds_in_state(now, entered);

    uint8_t b = 0;
    switch (st) {
    case LED_STATE_OFF:           b = 0;                        break;
    case LED_STATE_BOOT:          b = render_boot(t);           break;
    case LED_STATE_PAIRING:       b = render_pairing(t);        break;
    case LED_STATE_STREAMING:     b = render_streaming(t);      break;
    case LED_STATE_BATTERY_LOW:   b = render_battery_low(t);    break;
    case LED_STATE_BATTERY_CRIT:  b = render_battery_crit(t);   break;
    case LED_STATE_SLEEP_ENTRY:   b = render_sleep_entry(t);    break;
    }

    uint8_t corrected = s_gamma_ready ? s_gamma_lut[b] : b;
    (void)ledc_set_duty(LED_LEDC_MODE, LED_LEDC_CHANNEL, corrected);
    (void)ledc_update_duty(LED_LEDC_MODE, LED_LEDC_CHANNEL);
}

/* === Public API ========================================================== */

esp_err_t led_status_init(void)
{
    build_gamma_lut();

    ledc_timer_config_t timer_cfg = {
        .speed_mode      = LED_LEDC_MODE,
        .duty_resolution = LED_LEDC_RES,
        .timer_num       = LED_LEDC_TIMER,
        .freq_hz         = LED_LEDC_FREQ_HZ,
        .clk_cfg         = LEDC_AUTO_CLK,
    };
    esp_err_t err = ledc_timer_config(&timer_cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "ledc_timer_config: %s", esp_err_to_name(err));
        return err;
    }

    ledc_channel_config_t chan_cfg = {
        .gpio_num            = LED_GPIO,
        .speed_mode          = LED_LEDC_MODE,
        .channel             = LED_LEDC_CHANNEL,
        .intr_type           = LEDC_INTR_DISABLE,
        .timer_sel           = LED_LEDC_TIMER,
        .duty                = 0,
        .hpoint              = 0,
        .flags.output_invert = 1,   /* active-low handled in hardware */
    };
    err = ledc_channel_config(&chan_cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "ledc_channel_config: %s", esp_err_to_name(err));
        return err;
    }

    const esp_timer_create_args_t targs = {
        .callback        = &tick_cb,
        .name            = "led_status",
        .dispatch_method = ESP_TIMER_TASK,
    };
    err = esp_timer_create(&targs, &s_tick_timer);
    if (err != ESP_OK) return err;
    err = esp_timer_start_periodic(s_tick_timer, LED_TICK_PERIOD_US);
    if (err != ESP_OK) return err;

    led_status_set_state(LED_STATE_OFF);
    ESP_LOGI(TAG, "led_status ready on GPIO%d (LEDC ch%d @ %d Hz, gamma 2.2)",
             LED_GPIO, LED_LEDC_CHANNEL, LED_LEDC_FREQ_HZ);
    return ESP_OK;
}

void led_status_set_state(led_state_t state)
{
    /* Priority table: explicit clear to OFF is always allowed (renderers
     * use it to self-transition; callers use it as a "clear and re-set"
     * primitive when they really do need to downgrade priority). */
    static const uint8_t priority[] = {
        [LED_STATE_OFF]          = 0,
        [LED_STATE_BOOT]         = 1,
        [LED_STATE_STREAMING]    = 2,
        [LED_STATE_PAIRING]      = 3,
        [LED_STATE_BATTERY_LOW]  = 4,
        [LED_STATE_BATTERY_CRIT] = 5,
        [LED_STATE_SLEEP_ENTRY]  = 6,   /* user-initiated: overrides everything */
    };

    portENTER_CRITICAL(&s_lock);
    bool allow = (state == LED_STATE_OFF) || (priority[state] >= priority[s_state]);
    if (allow) {
        s_state = state;
        s_state_entered_us = esp_timer_get_time();
    }
    portEXIT_CRITICAL(&s_lock);
}

led_state_t led_status_get_state(void)
{
    portENTER_CRITICAL(&s_lock);
    led_state_t s = s_state;
    portEXIT_CRITICAL(&s_lock);
    return s;
}

void led_status_request_base_state(led_state_t state)
{
    /* Read current state inside the same critical section as the writes
     * below — otherwise a battery alert could fire between our read and
     * our writes, and we'd clobber it. Implemented as a single critical
     * section because the writes are short (just two assignments). */
    portENTER_CRITICAL(&s_lock);
    if (s_state != LED_STATE_BATTERY_LOW && s_state != LED_STATE_BATTERY_CRIT) {
        s_state = state;
        s_state_entered_us = esp_timer_get_time();
    }
    portEXIT_CRITICAL(&s_lock);
}
