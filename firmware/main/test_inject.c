/*
 * test_inject.c — synthetic 1 Hz sine generator. Bypasses the real
 * MAX3010x driver; calls ppg_channel_feed() directly. Used only when
 * CONFIG_NARBIS_TEST_INJECT=y.
 *
 * Output expectation: with the default 0.5–8 Hz bandpass and Elgendi
 * defaults, a clean 1 Hz sine should produce one beat every ~1000 ms,
 * confidence near 100 after the median ring fills (~10 beats), no
 * ARTIFACT flag.
 */

#include "test_inject.h"

#include <math.h>
#include <stdbool.h>

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "ppg_channel.h"
#include "ppg_driver_max3010x.h"

#define TI_FS_HZ           200
#define TI_PERIOD_MS       (1000 / TI_FS_HZ)        /* 5 ms */
#define TI_DC_OFFSET       130000u                  /* mid AGC band */
#define TI_AC_AMPLITUDE    5000.0f
#define TI_FREQ_HZ         1.0f
#define TI_TASK_STACK      4096
#define TI_TASK_PRIO       5

static const char *TAG = "test_inject";

static TaskHandle_t s_task = NULL;
static volatile bool s_running = false;

static void inject_task(void *arg)
{
    (void)arg;
    ESP_LOGI(TAG, "synthetic 1 Hz sine on IR @ %d Hz, DC=%u amp=%d",
             TI_FS_HZ, (unsigned)TI_DC_OFFSET, (int)TI_AC_AMPLITUDE);

    uint32_t sample_n = 0;
    TickType_t last = xTaskGetTickCount();
    const TickType_t period = pdMS_TO_TICKS(TI_PERIOD_MS);

    while (s_running) {
        float t = (float)sample_n / (float)TI_FS_HZ;
        float ac = TI_AC_AMPLITUDE * sinf(2.0f * (float)M_PI * TI_FREQ_HZ * t);
        int32_t ir_signed = (int32_t)TI_DC_OFFSET + (int32_t)ac;
        if (ir_signed < 0)        ir_signed = 0;
        if (ir_signed > 0x3FFFF)  ir_signed = 0x3FFFF;

        ppg_sample_t out = {
            .timestamp_us    = esp_timer_get_time(),
            .red             = 0,
            .ir              = (uint32_t)ir_signed,
            .green           = 0,
            .channels_active = PPG_CH_RED | PPG_CH_IR,
        };
        ppg_channel_feed(&out);
        sample_n++;
        vTaskDelayUntil(&last, period);
    }

    s_task = NULL;
    vTaskDelete(NULL);
}

esp_err_t test_inject_start(void)
{
    if (s_running) return ESP_ERR_INVALID_STATE;
    s_running = true;
    BaseType_t ok = xTaskCreate(inject_task, "ppg_inject",
                                TI_TASK_STACK, NULL, TI_TASK_PRIO, &s_task);
    if (ok != pdPASS) {
        s_running = false;
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

esp_err_t test_inject_stop(void)
{
    if (!s_running) return ESP_ERR_INVALID_STATE;
    s_running = false;
    return ESP_OK;
}
