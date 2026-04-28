/*
 * power_mgmt.c — esp_pm + battery monitoring.
 *
 * Light sleep:
 *   - esp_pm_configure with light_sleep_enable from config.
 *   - One pm_lock for BLE notification bursts (taken in transport_ble.c).
 *
 * Battery:
 *   - When NARBIS_BATT_DIVIDER_PRESENT=y: ADC oneshot on the configured GPIO,
 *     8-sample average, divider-scaled, run through a LiPo SoC LUT, cached.
 *     Sampled by a 30 s timer; cache served by power_mgmt_get_battery() with
 *     no ADC blocking on the caller.
 *   - When NARBIS_BATT_DIVIDER_PRESENT=n: stub returning 4000 mV / 80%, with
 *     a once-per-minute rate-limited STUB warning. The 30 s tick still emits
 *     ESP-NOW + BLE battery frames (with stub values) so the transport stays
 *     warm.
 */

#include "power_mgmt.h"

#include <string.h>

#include "esp_log.h"
#include "esp_pm.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "sdkconfig.h"

#include "ble_service_battery.h"
#include "ble_service_narbis.h"
#include "transport_ble.h"
#include "transport_espnow.h"

#if CONFIG_NARBIS_BATT_DIVIDER_PRESENT
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "esp_adc/adc_oneshot.h"
#endif

static const char *TAG = "power_mgmt";

#define BATT_TICK_PERIOD_US    (30ULL * 1000ULL * 1000ULL)
#define BATT_LOW_WARN_PERIOD_US (60ULL * 1000ULL * 1000ULL)
#define BATT_STUB_WARN_PERIOD_US (60ULL * 1000ULL * 1000ULL)
#define BATT_AVG_SAMPLES       8

typedef struct {
    uint16_t mv;
    uint8_t  soc_pct;
    uint8_t  charging;
} battery_snapshot_t;

static SemaphoreHandle_t   s_batt_mutex;
static battery_snapshot_t  s_batt = { .mv = 4000, .soc_pct = 80, .charging = 0 };
static esp_timer_handle_t  s_batt_timer;
static int64_t             s_last_stub_warn_us = 0;
static int64_t             s_last_low_warn_us  = 0;

static esp_pm_lock_handle_t s_ble_active_lock;

#if CONFIG_NARBIS_BATT_DIVIDER_PRESENT
static adc_oneshot_unit_handle_t s_adc_unit;
static adc_cali_handle_t         s_adc_cali;
static adc_unit_t                s_adc_unit_id;
static adc_channel_t             s_adc_channel;
static bool                      s_adc_ready;
#endif

/* ============================================================================
 * SoC lookup table (mV → percent) — only used when the battery divider is
 * populated (ADC path). Compiled out otherwise to silence -Wunused-function.
 * ========================================================================= */

#if CONFIG_NARBIS_BATT_DIVIDER_PRESENT
static const struct { uint16_t mv; uint8_t pct; } SOC_LUT[] = {
    { 4200, 100 },
    { 4100,  90 },
    { 4000,  75 },
    { 3900,  60 },
    { 3800,  45 },
    { 3700,  30 },
    { 3600,  15 },
    { 3500,   5 },
    { 3400,   0 },
};
#define SOC_LUT_LEN (sizeof(SOC_LUT) / sizeof(SOC_LUT[0]))

static uint8_t mv_to_soc(uint16_t mv)
{
    if (mv >= SOC_LUT[0].mv)               return SOC_LUT[0].pct;
    if (mv <= SOC_LUT[SOC_LUT_LEN - 1].mv) return SOC_LUT[SOC_LUT_LEN - 1].pct;
    for (size_t i = 0; i + 1 < SOC_LUT_LEN; i++) {
        if (mv <= SOC_LUT[i].mv && mv >= SOC_LUT[i + 1].mv) {
            int span_mv = (int)SOC_LUT[i].mv - (int)SOC_LUT[i + 1].mv;
            int span_pct = (int)SOC_LUT[i].pct - (int)SOC_LUT[i + 1].pct;
            int delta_mv = (int)mv - (int)SOC_LUT[i + 1].mv;
            int pct = (int)SOC_LUT[i + 1].pct + (delta_mv * span_pct + span_mv / 2) / span_mv;
            if (pct < 0)   pct = 0;
            if (pct > 100) pct = 100;
            return (uint8_t)pct;
        }
    }
    return 0;
}
#endif  /* CONFIG_NARBIS_BATT_DIVIDER_PRESENT */

/* ============================================================================
 * esp_pm configuration
 * ========================================================================= */

static esp_err_t configure_pm(bool light_sleep_enabled)
{
#if CONFIG_PM_ENABLE
    esp_pm_config_t cfg = {
#if CONFIG_IDF_TARGET_ESP32C6
        .max_freq_mhz = 160,
        .min_freq_mhz = 40,
#else
        .max_freq_mhz = 160,
        .min_freq_mhz = 40,
#endif
        .light_sleep_enable = light_sleep_enabled,
    };
    return esp_pm_configure(&cfg);
#else
    (void)light_sleep_enabled;
    return ESP_OK;
#endif
}

/* ============================================================================
 * ADC sampling (real mode only)
 * ========================================================================= */

#if CONFIG_NARBIS_BATT_DIVIDER_PRESENT
static esp_err_t adc_init(void)
{
    esp_err_t err = adc_oneshot_io_to_channel(CONFIG_NARBIS_BATT_ADC_GPIO,
                                              &s_adc_unit_id, &s_adc_channel);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "GPIO%d is not ADC-capable: %s",
                 CONFIG_NARBIS_BATT_ADC_GPIO, esp_err_to_name(err));
        return err;
    }

    adc_oneshot_unit_init_cfg_t unit_cfg = {
        .unit_id  = s_adc_unit_id,
        .ulp_mode = ADC_ULP_MODE_DISABLE,
    };
    err = adc_oneshot_new_unit(&unit_cfg, &s_adc_unit);
    if (err != ESP_OK) return err;

    adc_oneshot_chan_cfg_t chan_cfg = {
        .bitwidth = ADC_BITWIDTH_DEFAULT,
        .atten    = ADC_ATTEN_DB_12,
    };
    err = adc_oneshot_config_channel(s_adc_unit, s_adc_channel, &chan_cfg);
    if (err != ESP_OK) return err;

    adc_cali_curve_fitting_config_t cali_cfg = {
        .unit_id  = s_adc_unit_id,
        .chan     = s_adc_channel,
        .atten    = ADC_ATTEN_DB_12,
        .bitwidth = ADC_BITWIDTH_DEFAULT,
    };
    err = adc_cali_create_scheme_curve_fitting(&cali_cfg, &s_adc_cali);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "curve-fitting cali unavailable (%s); voltages will be uncalibrated",
                 esp_err_to_name(err));
        s_adc_cali = NULL;
    }

    s_adc_ready = true;
    ESP_LOGI(TAG, "battery ADC ready: GPIO%d unit=%d chan=%d divider=%d/%d",
             CONFIG_NARBIS_BATT_ADC_GPIO, (int)s_adc_unit_id, (int)s_adc_channel,
             CONFIG_NARBIS_BATT_ADC_DIV_NUM, CONFIG_NARBIS_BATT_ADC_DIV_DEN);
    return ESP_OK;
}

static esp_err_t adc_sample_mv(uint16_t *out_mv)
{
    if (!s_adc_ready) return ESP_ERR_INVALID_STATE;

    int sum_raw = 0, ok = 0;
    for (int i = 0; i < BATT_AVG_SAMPLES; i++) {
        int raw = 0;
        if (adc_oneshot_read(s_adc_unit, s_adc_channel, &raw) == ESP_OK) {
            sum_raw += raw;
            ok++;
        }
    }
    if (ok == 0) return ESP_FAIL;
    int avg_raw = sum_raw / ok;

    int mv_at_pin = 0;
    if (s_adc_cali != NULL) {
        if (adc_cali_raw_to_voltage(s_adc_cali, avg_raw, &mv_at_pin) != ESP_OK) {
            return ESP_FAIL;
        }
    } else {
        /* Linear fallback: 12-bit raw → 0…3100 mV at 11 dB attenuation. */
        mv_at_pin = (avg_raw * 3100) / 4095;
    }

    int batt_mv = (mv_at_pin * CONFIG_NARBIS_BATT_ADC_DIV_NUM) /
                  CONFIG_NARBIS_BATT_ADC_DIV_DEN;
    if (batt_mv < 0)     batt_mv = 0;
    if (batt_mv > 65535) batt_mv = 65535;
    *out_mv = (uint16_t)batt_mv;
    return ESP_OK;
}
#endif  /* CONFIG_NARBIS_BATT_DIVIDER_PRESENT */

/* ============================================================================
 * Tick: sample (real mode), update cache, emit frames.
 * ========================================================================= */

static void emit_battery_frames(uint16_t mv, uint8_t soc, uint8_t charging)
{
    esp_err_t err = transport_espnow_send_battery(soc, mv, charging);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGW(TAG, "espnow send_battery: %s", esp_err_to_name(err));
    }
    (void)transport_ble_send_battery(soc, mv, charging);
    (void)ble_service_narbis_push_battery(soc, mv, charging);
    ble_service_battery_push(soc, mv, charging);
}

static void battery_tick(void *arg)
{
    (void)arg;
    uint16_t mv;
    uint8_t  soc, charging = 0;

#if CONFIG_NARBIS_BATT_DIVIDER_PRESENT
    if (adc_sample_mv(&mv) == ESP_OK) {
        soc = mv_to_soc(mv);
        xSemaphoreTake(s_batt_mutex, portMAX_DELAY);
        s_batt.mv       = mv;
        s_batt.soc_pct  = soc;
        s_batt.charging = charging;
        xSemaphoreGive(s_batt_mutex);
        ESP_LOGI(TAG, "battery=%u mV soc=%u%%", mv, soc);
    } else {
        xSemaphoreTake(s_batt_mutex, portMAX_DELAY);
        mv  = s_batt.mv;
        soc = s_batt.soc_pct;
        charging = s_batt.charging;
        xSemaphoreGive(s_batt_mutex);
    }
#else
    xSemaphoreTake(s_batt_mutex, portMAX_DELAY);
    mv  = s_batt.mv;
    soc = s_batt.soc_pct;
    charging = s_batt.charging;
    xSemaphoreGive(s_batt_mutex);
#endif

    if (soc < 15) {
        int64_t now = esp_timer_get_time();
        if (now - s_last_low_warn_us >= (int64_t)BATT_LOW_WARN_PERIOD_US) {
            ESP_LOGW(TAG, "battery low: %u%% (%u mV)", soc, mv);
            s_last_low_warn_us = now;
        }
    }

    emit_battery_frames(mv, soc, charging);
}

/* ============================================================================
 * Public API
 * ========================================================================= */

esp_err_t power_mgmt_init(void)
{
    if (s_batt_mutex == NULL) {
        s_batt_mutex = xSemaphoreCreateMutex();
        if (s_batt_mutex == NULL) return ESP_ERR_NO_MEM;
    }

#if CONFIG_PM_ENABLE
    esp_err_t err = esp_pm_lock_create(ESP_PM_CPU_FREQ_MAX, 0, "ble_active",
                                       &s_ble_active_lock);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "pm_lock_create ble_active: %s", esp_err_to_name(err));
    }
#endif

    /* Default light sleep on until config_apply_initial overrides. */
    (void)configure_pm(true);

#if CONFIG_NARBIS_BATT_DIVIDER_PRESENT
    esp_err_t aerr = adc_init();
    if (aerr != ESP_OK) {
        ESP_LOGE(TAG, "battery ADC init failed: %s", esp_err_to_name(aerr));
    }
#else
    ESP_LOGW(TAG, "battery divider absent — using stub values; see TODO.md");
#endif

    const esp_timer_create_args_t targs = {
        .callback        = &battery_tick,
        .name            = "batt_tick",
        .dispatch_method = ESP_TIMER_TASK,
    };
    esp_err_t terr = esp_timer_create(&targs, &s_batt_timer);
    if (terr != ESP_OK) return terr;
    return esp_timer_start_periodic(s_batt_timer, BATT_TICK_PERIOD_US);
}

esp_err_t power_mgmt_deinit(void)
{
    if (s_batt_timer != NULL) {
        esp_timer_stop(s_batt_timer);
        esp_timer_delete(s_batt_timer);
        s_batt_timer = NULL;
    }
#if CONFIG_PM_ENABLE
    if (s_ble_active_lock != NULL) {
        esp_pm_lock_delete(s_ble_active_lock);
        s_ble_active_lock = NULL;
    }
#endif
    return ESP_OK;
}

esp_err_t power_mgmt_get_battery(uint16_t *mv, uint8_t *soc_pct, uint8_t *charging)
{
    if (mv == NULL || soc_pct == NULL || charging == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

#if !CONFIG_NARBIS_BATT_DIVIDER_PRESENT
    int64_t now = esp_timer_get_time();
    if (now - s_last_stub_warn_us >= (int64_t)BATT_STUB_WARN_PERIOD_US) {
        ESP_LOGW(TAG, "STUB: battery divider not populated; returning placeholder");
        s_last_stub_warn_us = now;
    }
#endif

    if (s_batt_mutex != NULL) {
        xSemaphoreTake(s_batt_mutex, portMAX_DELAY);
        *mv       = s_batt.mv;
        *soc_pct  = s_batt.soc_pct;
        *charging = s_batt.charging;
        xSemaphoreGive(s_batt_mutex);
    } else {
        *mv = 4000; *soc_pct = 80; *charging = 0;
    }
    return ESP_OK;
}

esp_err_t power_mgmt_set_light_sleep_enabled(bool enabled)
{
    return configure_pm(enabled);
}

bool power_mgmt_can_ota(void)
{
    uint16_t mv; uint8_t soc, ch;
    if (power_mgmt_get_battery(&mv, &soc, &ch) != ESP_OK) return false;
    return soc >= 30;
}

void power_mgmt_acquire_ble_active(void)
{
#if CONFIG_PM_ENABLE
    if (s_ble_active_lock != NULL) {
        esp_pm_lock_acquire(s_ble_active_lock);
    }
#endif
}

void power_mgmt_release_ble_active(void)
{
#if CONFIG_PM_ENABLE
    if (s_ble_active_lock != NULL) {
        esp_pm_lock_release(s_ble_active_lock);
    }
#endif
}
