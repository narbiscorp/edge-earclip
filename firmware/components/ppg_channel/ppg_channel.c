/*
 * ppg_channel.c — DC removal, saturation detect, AGC.
 *
 * Fixed-point conventions:
 *   - Raw ADC samples: 18-bit unsigned, 0..0x3FFFF (262143).
 *   - DC baseline tracked internally as Q24.8 in int64_t to avoid
 *     quantization lock-up at small step sizes; exposed externally as
 *     uint32_t (ADC counts).
 *   - DC IIR: dc8 += (raw8 - dc8) >> SHIFT, SHIFT = 10 → τ ≈ 1024/fs.
 *     At fs=200 Hz this is ~5.12 s. Pure integer math.
 *   - AC component: int32_t (raw - dc_baseline), well within range.
 *
 * AGC supersedes the staged-prompt's "max 1 adjustment per 2 seconds"
 * rule with the runtime-config field agc_update_period_ms (default 200).
 * Saturation triggers an immediate decrease that bypasses the rate limit
 * — recovery from clipping must be fast.
 *
 * Active channel is hardcoded to IR. AUTO mode + dashboard-controlled
 * channel selection arrive in stage 07 along with a protocol_version bump.
 */

#include "ppg_channel.h"

#include <stdatomic.h>
#include <string.h>

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/portmacro.h"

#include "sdkconfig.h"

static const char *TAG = "ppg_channel";

#define PPG_ADC_MAX_18BIT       0x3FFFFu        /* 262143 */
#define PPG_ADC_NEAR_MAX        ((PPG_ADC_MAX_18BIT * 99u) / 100u)
#define PPG_NEAR_MAX_HOLD_N     3
#define PPG_DC_IIR_SHIFT        10              /* τ ≈ 1024 / fs samples */
#define PPG_DC_FRAC_BITS        8               /* internal Q24.8 */

/* TODO(stage-07): expose AUTO + per-channel selection via runtime config. */
static const ppg_active_channel_t k_active = PPG_ACTIVE_IR;

typedef struct {
    bool     inited;
    bool     dc_seeded;
    int64_t  dc_q8;                 /* Q24.8 DC baseline */
    uint8_t  near_max_run;          /* consecutive samples near-max */
    uint8_t  pending_reset_flag;    /* set on reset, cleared on next emit */
    uint32_t sample_index;

    /* AGC state */
    bool     agc_enabled;
    uint16_t agc_update_period_ms;
    uint32_t agc_target_dc_min;
    uint32_t agc_target_dc_max;
    uint16_t agc_step_ma_x10;
    int64_t  agc_last_step_us;      /* esp_timer_get_time() of last AGC LED write */
    uint16_t agc_last_known_x10;    /* tracker for active-channel LED current */
    bool     agc_cap_warned;        /* one-shot rail-cap warning flag */

    portMUX_TYPE cb_lock;
    ppg_channel_output_cb_t out_cb;
    void *out_ctx;
} ppg_channel_state_t;

static ppg_channel_state_t s_state = {
    .cb_lock = portMUX_INITIALIZER_UNLOCKED,
};

static inline uint32_t pick_raw_for_active(const ppg_sample_t *raw)
{
    switch (k_active) {
        case PPG_ACTIVE_RED:   return raw->red;
        case PPG_ACTIVE_GREEN: return raw->green;
        case PPG_ACTIVE_IR:
        default:               return raw->ir;
    }
}

static inline ppg_led_t active_to_led(void)
{
    switch (k_active) {
        case PPG_ACTIVE_RED:   return PPG_LED_RED;
        case PPG_ACTIVE_GREEN: return PPG_LED_GREEN;
        case PPG_ACTIVE_IR:
        default:               return PPG_LED_IR;
    }
}

static void apply_default_agc(ppg_channel_state_t *st)
{
    /* Mirrors the runtime-config defaults. The real values arrive via
     * ppg_channel_apply_config() once config_manager is wired up. */
    st->agc_enabled         = true;
    st->agc_update_period_ms = 200;
    /* Target DC band: ~25%..75% of 18-bit full scale. Keeps signal away
     * from saturation while preserving headroom for AC swing. */
    st->agc_target_dc_min   = (uint32_t)PPG_ADC_MAX_18BIT / 4u;
    st->agc_target_dc_max   = ((uint32_t)PPG_ADC_MAX_18BIT * 3u) / 4u;
    st->agc_step_ma_x10     = 5;
    st->agc_last_known_x10  = 70;   /* matches default 7.0 mA */
}

esp_err_t ppg_channel_init(void)
{
    if (s_state.inited) return ESP_ERR_INVALID_STATE;

    memset(&s_state, 0, sizeof(s_state));
    s_state.cb_lock = (portMUX_TYPE)portMUX_INITIALIZER_UNLOCKED;
    apply_default_agc(&s_state);
    s_state.pending_reset_flag = 1;
    s_state.inited = true;

    ESP_LOGI(TAG, "init: active=IR target_dc=[%lu..%lu] step=%u.%u mA",
             (unsigned long)s_state.agc_target_dc_min,
             (unsigned long)s_state.agc_target_dc_max,
             s_state.agc_step_ma_x10 / 10, s_state.agc_step_ma_x10 % 10);
    return ESP_OK;
}

esp_err_t ppg_channel_deinit(void)
{
    s_state.inited = false;
    portENTER_CRITICAL(&s_state.cb_lock);
    s_state.out_cb = NULL;
    s_state.out_ctx = NULL;
    portEXIT_CRITICAL(&s_state.cb_lock);
    return ESP_OK;
}

esp_err_t ppg_channel_register_output_cb(ppg_channel_output_cb_t cb, void *ctx)
{
    if (!s_state.inited) return ESP_ERR_INVALID_STATE;
    portENTER_CRITICAL(&s_state.cb_lock);
    s_state.out_cb = cb;
    s_state.out_ctx = ctx;
    portEXIT_CRITICAL(&s_state.cb_lock);
    return ESP_OK;
}

esp_err_t ppg_channel_apply_config(const narbis_runtime_config_t *cfg)
{
    if (!s_state.inited) return ESP_ERR_INVALID_STATE;
    if (cfg == NULL)     return ESP_ERR_INVALID_ARG;

    s_state.agc_enabled          = (cfg->agc_enabled != 0);
    s_state.agc_update_period_ms = (cfg->agc_update_period_ms > 0)
                                       ? cfg->agc_update_period_ms : 200;
    s_state.agc_target_dc_min    = cfg->agc_target_dc_min;
    s_state.agc_target_dc_max    = (cfg->agc_target_dc_max > cfg->agc_target_dc_min)
                                       ? cfg->agc_target_dc_max
                                       : (cfg->agc_target_dc_min + 1u);
    s_state.agc_step_ma_x10      = (cfg->agc_step_ma_x10 > 0) ? cfg->agc_step_ma_x10 : 5;
    /* Re-sync the AGC's LED-current tracker to whatever the active channel's
     * configured current is. Without this, AGC's first adjustment after a
     * user-driven LED change would compute from a stale baseline and stomp
     * the user's setting. */
    s_state.agc_last_known_x10 = (k_active == PPG_ACTIVE_RED)
                                     ? cfg->led_red_ma_x10
                                     : cfg->led_ir_ma_x10;
    return ESP_OK;
}

void ppg_channel_reset_dsp_state(void)
{
    s_state.dc_seeded          = false;
    s_state.dc_q8              = 0;
    s_state.near_max_run       = 0;
    s_state.pending_reset_flag = 1;
    s_state.agc_last_step_us   = 0;
}

static void agc_update(uint32_t dc, bool saturated)
{
    if (!s_state.agc_enabled) return;

    int64_t now = esp_timer_get_time();
    bool rate_ok = (now - s_state.agc_last_step_us) >=
                   (int64_t)s_state.agc_update_period_ms * 1000;

    int delta_x10 = 0;
    if (saturated) {
        /* Saturation bypasses the rate limit — recovery is urgent. */
        delta_x10 = -(int)s_state.agc_step_ma_x10;
    } else if (!rate_ok) {
        return;
    } else if (dc < s_state.agc_target_dc_min) {
        delta_x10 = +(int)s_state.agc_step_ma_x10;
    } else if (dc > s_state.agc_target_dc_max) {
        delta_x10 = -(int)s_state.agc_step_ma_x10;
    } else {
        return;
    }

    /* Tracker lives in s_state and is re-synced from runtime config in
     * ppg_channel_apply_config() whenever the user changes LED current.
     *
     * AGC LED-current cap (Kconfig CONFIG_NARBIS_AGC_LED_MAX_X10): the
     * MAX3010x can drive each LED to 51 mA, but past ~20 mA the optical
     * coupling is almost certainly broken (loose earclip, no finger,
     * etc.) and pumping more current can't fix that — it just wastes
     * power. Cap at 200 (= 20.0 mA) by default and log once when railed. */
    int new_x10 = (int)s_state.agc_last_known_x10 + delta_x10;
    if (new_x10 < 0) new_x10 = 0;
    if (new_x10 > CONFIG_NARBIS_AGC_LED_MAX_X10) {
        new_x10 = CONFIG_NARBIS_AGC_LED_MAX_X10;
        if (!s_state.agc_cap_warned) {
            ESP_LOGW(TAG,
                     "agc railed at LED cap (%d.%d mA) — likely poor optical coupling",
                     CONFIG_NARBIS_AGC_LED_MAX_X10 / 10,
                     CONFIG_NARBIS_AGC_LED_MAX_X10 % 10);
            s_state.agc_cap_warned = true;
        }
    } else {
        /* Re-arm the warning once we drop back below the cap. */
        s_state.agc_cap_warned = false;
    }
    if ((uint16_t)new_x10 == s_state.agc_last_known_x10) return;

    esp_err_t err = ppg_driver_set_led_current(active_to_led(), (uint16_t)new_x10);
    if (err == ESP_OK) {
        s_state.agc_last_known_x10 = (uint16_t)new_x10;
        s_state.agc_last_step_us = now;
        ESP_LOGI(TAG, "agc: dc=%lu sat=%d → led=%d.%d mA",
                 (unsigned long)dc, (int)saturated,
                 new_x10 / 10, new_x10 % 10);
    }
}

void ppg_channel_feed(const ppg_sample_t *raw)
{
    if (!s_state.inited || raw == NULL) return;

    uint32_t value = pick_raw_for_active(raw);

    /* Saturation detection. */
    bool at_max = (value >= PPG_ADC_MAX_18BIT);
    bool near_max = (value >= PPG_ADC_NEAR_MAX);
    if (near_max) {
        if (s_state.near_max_run < 0xFF) s_state.near_max_run++;
    } else {
        s_state.near_max_run = 0;
    }
    bool saturated = at_max ||
                     (s_state.near_max_run >= PPG_NEAR_MAX_HOLD_N);

    /* DC IIR in Q24.8 — seed on first sample to avoid a long ramp-in. */
    int64_t value_q8 = (int64_t)value << PPG_DC_FRAC_BITS;
    if (!s_state.dc_seeded) {
        s_state.dc_q8 = value_q8;
        s_state.dc_seeded = true;
    } else {
        s_state.dc_q8 += (value_q8 - s_state.dc_q8) >> PPG_DC_IIR_SHIFT;
    }
    uint32_t dc = (uint32_t)(s_state.dc_q8 >> PPG_DC_FRAC_BITS);

    int64_t ac64 = (int64_t)value - (int64_t)dc;
    if (ac64 >  INT32_MAX) ac64 =  INT32_MAX;
    if (ac64 < -INT32_MAX) ac64 = -INT32_MAX;

    uint8_t flags = 0;
    if (saturated) flags |= PPG_PROCESSED_FLAG_SATURATED;
    if (s_state.pending_reset_flag) {
        flags |= PPG_PROCESSED_FLAG_CHANNEL_RESET;
        s_state.pending_reset_flag = 0;
    }

    ppg_processed_sample_t out = {
        .timestamp_ms   = (uint32_t)(raw->timestamp_us / 1000),
        .sample_index   = s_state.sample_index++,
        .ac             = (int32_t)ac64,
        .dc_baseline    = dc,
        .active_channel = (uint8_t)k_active,
        .flags          = flags,
    };

    /* Snapshot the callback under the spinlock for safety against a
     * concurrent register call from another task. */
    ppg_channel_output_cb_t cb;
    void *ctx;
    portENTER_CRITICAL(&s_state.cb_lock);
    cb = s_state.out_cb;
    ctx = s_state.out_ctx;
    portEXIT_CRITICAL(&s_state.cb_lock);
    if (cb != NULL) cb(&out, ctx);

    /* AGC after emit so downstream sees the un-clipped sample first. */
    agc_update(dc, saturated);
}
