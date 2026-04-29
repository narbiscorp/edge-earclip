/*
 * ppg_driver_max3010x.c — MAX30102 / MAX30101 driver.
 *
 * Pipeline:
 *   FIFO_A_FULL ─► GPIO0 falling edge ─► ISR (timestamp + give sem)
 *                                          │
 *                                          ▼
 *                              ppg_task: drain FIFO via I2C burst,
 *                              unpack 18-bit samples, back-compute
 *                              per-sample timestamps, invoke callback.
 *
 * No floating point. No work in ISR beyond timestamp + sem give.
 */

#include "ppg_driver_max3010x.h"
#include "max3010x_regs.h"

#include <stdbool.h>

#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "esp_check.h"
#include "esp_err.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

static const char *TAG = "ppg_driver";

#define PPG_I2C_FREQ_HZ      400000
#define PPG_I2C_TIMEOUT_MS   100
#define PPG_TASK_STACK       4096
#define PPG_TASK_PRIO        5

/* FIFO_A_FULL field: 0x0F = 15 empty slots remaining = IRQ at 17 unread. */
#define PPG_FIFO_A_FULL_FIELD  0x0F

/* ---- driver state ---- */
typedef struct {
    bool                       inited;
    ppg_driver_config_t        cfg;
    ppg_chip_type_t            chip;
    uint8_t                    rev_id;

    i2c_master_bus_handle_t    bus;
    i2c_master_dev_handle_t    dev;

    SemaphoreHandle_t          irq_sem;
    SemaphoreHandle_t          i2c_mutex;
    TaskHandle_t               task;
    volatile bool              task_running;

    volatile int64_t           last_irq_us;
    int64_t                    period_us;
    uint8_t                    bytes_per_sample;  /* 3 * active_channel_count */
    uint8_t                    channels_active;   /* PPG_CH_* mask */

    ppg_sample_callback_t      sample_cb;
    void                      *sample_cb_ctx;
    portMUX_TYPE               cb_lock;
} ppg_state_t;

static ppg_state_t s = {
    .cb_lock = portMUX_INITIALIZER_UNLOCKED,
};

/* ============================================================
 * I2C helpers
 * ============================================================ */

static esp_err_t reg_write(uint8_t reg, uint8_t value)
{
    uint8_t buf[2] = { reg, value };
    return i2c_master_transmit(s.dev, buf, sizeof(buf), PPG_I2C_TIMEOUT_MS);
}

static esp_err_t reg_read(uint8_t reg, uint8_t *value)
{
    return i2c_master_transmit_receive(s.dev, &reg, 1, value, 1, PPG_I2C_TIMEOUT_MS);
}

static esp_err_t reg_burst_read(uint8_t reg, uint8_t *buf, size_t len)
{
    return i2c_master_transmit_receive(s.dev, &reg, 1, buf, len, PPG_I2C_TIMEOUT_MS);
}

static esp_err_t reg_update(uint8_t reg, uint8_t mask, uint8_t value)
{
    uint8_t cur;
    esp_err_t err = reg_read(reg, &cur);
    if (err != ESP_OK) return err;
    cur = (uint8_t)((cur & ~mask) | (value & mask));
    return reg_write(reg, cur);
}

/* ============================================================
 * Chip detection
 *
 * PART_ID is 0x15 on both chips. We probe LED3_PA: MAX30101 latches the
 * write and reads it back, MAX30102 typically reads back 0x00 because
 * LED3 is not bonded. We restore the original LED3_PA either way.
 * ============================================================ */

static esp_err_t detect_chip(void)
{
    uint8_t part_id = 0;
    esp_err_t err = reg_read(MAX3010X_REG_PART_ID, &part_id);
    if (err != ESP_OK) return err;
    if (part_id != MAX3010X_PART_ID_VALUE) {
        ESP_LOGE(TAG, "unexpected PART_ID 0x%02X (expected 0x%02X)",
                 part_id, MAX3010X_PART_ID_VALUE);
        return ESP_ERR_NOT_FOUND;
    }

    err = reg_read(MAX3010X_REG_REV_ID, &s.rev_id);
    if (err != ESP_OK) return err;

    uint8_t saved_led3 = 0;
    (void)reg_read(MAX3010X_REG_LED3_PA, &saved_led3);

    const uint8_t probe = 0x55;
    err = reg_write(MAX3010X_REG_LED3_PA, probe);
    if (err != ESP_OK) return err;

    uint8_t echo = 0;
    err = reg_read(MAX3010X_REG_LED3_PA, &echo);
    if (err != ESP_OK) return err;

    (void)reg_write(MAX3010X_REG_LED3_PA, saved_led3);

    s.chip = (echo == probe) ? PPG_CHIP_MAX30101 : PPG_CHIP_MAX30102;
    ESP_LOGI(TAG, "chip detected: %s (rev 0x%02X)",
             s.chip == PPG_CHIP_MAX30101 ? "MAX30101" : "MAX30102", s.rev_id);
    return ESP_OK;
}

/* ============================================================
 * Sample-rate encoding
 * ============================================================ */

static esp_err_t sample_rate_to_field(uint16_t hz, uint8_t *field_out)
{
    switch (hz) {
        case 50:  *field_out = MAX3010X_SR_50HZ;  return ESP_OK;
        case 100: *field_out = MAX3010X_SR_100HZ; return ESP_OK;
        case 200: *field_out = MAX3010X_SR_200HZ; return ESP_OK;
        case 400: *field_out = MAX3010X_SR_400HZ; return ESP_OK;
        default:  return ESP_ERR_INVALID_ARG;
    }
}

/* ============================================================
 * ISR
 * ============================================================ */

static void IRAM_ATTR ppg_isr(void *arg)
{
    (void)arg;
    s.last_irq_us = esp_timer_get_time();
    BaseType_t hpw = pdFALSE;
    xSemaphoreGiveFromISR(s.irq_sem, &hpw);
    if (hpw == pdTRUE) {
        portYIELD_FROM_ISR();
    }
}

/* ============================================================
 * FIFO drain
 * ============================================================ */

static uint32_t unpack_18bit(const uint8_t *p)
{
    uint32_t v = ((uint32_t)p[0] << 16) | ((uint32_t)p[1] << 8) | (uint32_t)p[2];
    return v & 0x0003FFFFu;
}

static void dispatch_sample(const ppg_sample_t *sample)
{
    ppg_sample_callback_t cb;
    void *ctx;
    portENTER_CRITICAL(&s.cb_lock);
    cb = s.sample_cb;
    ctx = s.sample_cb_ctx;
    portEXIT_CRITICAL(&s.cb_lock);
    if (cb != NULL) {
        cb(sample, ctx);
    }
}

static void drain_fifo(int64_t irq_us)
{
    /* 32 entries × 9 bytes max (3 channels × 3 bytes); typical 15 × 6 = 90. */
    uint8_t buf[MAX3010X_FIFO_DEPTH * 9];

    if (xSemaphoreTake(s.i2c_mutex, pdMS_TO_TICKS(50)) != pdTRUE) {
        ESP_LOGW(TAG, "drain_fifo: i2c mutex timeout");
        return;
    }

    uint8_t wr = 0, rd = 0;
    if (reg_read(MAX3010X_REG_FIFO_WR_PTR, &wr) != ESP_OK ||
        reg_read(MAX3010X_REG_FIFO_RD_PTR, &rd) != ESP_OK) {
        xSemaphoreGive(s.i2c_mutex);
        return;
    }

    uint8_t n = (uint8_t)((wr - rd) & 0x1F);
    if (n == 0) {
        /* Spurious / overflow rollover (wr == rd can also mean full).
         * Read INT_STATUS_1 to clear A_FULL latch and bail. */
        uint8_t st;
        (void)reg_read(MAX3010X_REG_INT_STATUS_1, &st);
        xSemaphoreGive(s.i2c_mutex);
        return;
    }

    size_t bytes = (size_t)n * s.bytes_per_sample;
    if (bytes > sizeof(buf)) {
        /* Cannot happen for 32 × 9 = 288 vs. buf 288 — defensive only. */
        bytes = (sizeof(buf) / s.bytes_per_sample) * s.bytes_per_sample;
        n = (uint8_t)(bytes / s.bytes_per_sample);
    }

    if (reg_burst_read(MAX3010X_REG_FIFO_DATA, buf, bytes) != ESP_OK) {
        xSemaphoreGive(s.i2c_mutex);
        ESP_LOGW(TAG, "drain_fifo: burst read failed (n=%u)", n);
        return;
    }

    /* Reading FIFO_DATA advances RD_PTR on the chip, which deasserts the
     * A_FULL interrupt automatically. */
    xSemaphoreGive(s.i2c_mutex);

    int64_t period_us = s.period_us;
    int64_t base_us = irq_us - (int64_t)(n - 1) * period_us;

    for (uint8_t i = 0; i < n; i++) {
        const uint8_t *p = &buf[(size_t)i * s.bytes_per_sample];
        ppg_sample_t out = { 0 };
        out.timestamp_us = base_us + (int64_t)i * period_us;
        out.channels_active = s.channels_active;

        size_t off = 0;
        if (s.channels_active & PPG_CH_RED) {
            out.red = unpack_18bit(&p[off]); off += 3;
        }
        if (s.channels_active & PPG_CH_IR) {
            out.ir = unpack_18bit(&p[off]); off += 3;
        }
        if (s.channels_active & PPG_CH_GREEN) {
            out.green = unpack_18bit(&p[off]); off += 3;
        }
        dispatch_sample(&out);
    }
}

/* ============================================================
 * Dispatch task
 * ============================================================ */

static void ppg_task(void *arg)
{
    (void)arg;
    s.task_running = true;
    ESP_LOGI(TAG, "task started");
    /* Two operating modes, selectable at compile time via Kconfig:
     *
     *   poll_ms > 0  (default 25 ms): polling fallback. Task wakes every
     *     poll_ms via the semaphore timeout and drains the FIFO via I2C
     *     regardless of GPIO state. The IRQ path still works in parallel
     *     when the chip's INT pin is healthy; drain_fifo is idempotent so
     *     the two paths don't conflict. This is the recommended setting
     *     while sensor INT-line hardware is being validated.
     *
     *   poll_ms == 0: pure IRQ mode, original behavior. 1 s timeout
     *     used only for stall detection. Recommended once hardware is
     *     verified good — keeps task off the CPU between IRQs. */
    const uint32_t poll_ms = (uint32_t)CONFIG_NARBIS_PPG_POLL_FALLBACK_MS;
    const TickType_t timeout_ticks = (poll_ms > 0)
                                         ? pdMS_TO_TICKS(poll_ms)
                                         : pdMS_TO_TICKS(1000);
    int64_t last_drain_us = esp_timer_get_time();
    int64_t last_warn_us = last_drain_us;

    if (poll_ms > 0) {
        ESP_LOGI(TAG, "poll-fallback enabled: %u ms", (unsigned)poll_ms);
    }

    while (s.task_running) {
        if (xSemaphoreTake(s.irq_sem, timeout_ticks) == pdTRUE) {
            /* IRQ path. */
            drain_fifo(s.last_irq_us);
            last_drain_us = esp_timer_get_time();
        } else if (poll_ms > 0) {
            /* Poll path. Drain unconditionally; if the FIFO is empty,
             * drain_fifo bails on (wr - rd) == 0. */
            int64_t now_us = esp_timer_get_time();
            drain_fifo(now_us);
            last_drain_us = now_us;
        } else {
            /* IRQ-only mode, no IRQ in 1 s. Self-heal if the line is
             * stuck low (indicates a missed edge or a chip in latched
             * state with no drains feeding it). */
            int level = gpio_get_level(s.cfg.int_gpio);
            if (level == 0) {
                ESP_LOGW(TAG, "INT stuck low — draining FIFO to recover");
                drain_fifo(esp_timer_get_time());
            } else {
                ESP_LOGW(TAG, "no IRQ in 1s — sensor stalled?");
            }
        }

        /* Sparse health check: warn at most once per 5 s if we've gone
         * that long with no samples drained, regardless of mode. */
        int64_t now_us = esp_timer_get_time();
        if ((now_us - last_drain_us) > 5000000 &&
            (now_us - last_warn_us) > 5000000) {
            ESP_LOGW(TAG, "no samples drained in 5s — bus or chip wedged?");
            last_warn_us = now_us;
        }
    }
    ESP_LOGI(TAG, "task exiting");
    vTaskDelete(NULL);
}

/* ============================================================
 * Boot-time stall diagnostic
 *
 * One-shot task. Spawned at the end of ppg_driver_init(), AFTER the IRQ
 * is armed and the chip is fully configured. Runs 10 iterations at 1 Hz,
 * snapshotting key registers + the live INT line so a developer can tell
 * — from monitor output alone — whether the chip is sampling and the INT
 * wire is broken, or whether the chip never started.
 *
 * NOTE: Reading INT_STATUS_1 clears the A_FULL latch. If the chip is
 * asserting A_FULL but the INT wire is broken, this read deasserts it
 * briefly; the chip re-asserts as long as 17+ samples remain unread, so
 * consecutive iterations will show INT1 bit 7 set repeatedly. That is
 * the diagnostic, not a bug.
 * ============================================================ */

#define PPG_BOOT_DIAG_ITERS       10
#define PPG_BOOT_DIAG_PERIOD_MS   1000
#define PPG_BOOT_DIAG_MUTEX_MS    100
#define PPG_BOOT_DIAG_STACK       3072
#define PPG_BOOT_DIAG_PRIO        3

static void ppg_boot_diag_task(void *arg)
{
    (void)arg;

    /* One-shot config snapshot — describes how install_isr() armed the line. */
    ESP_LOGI(TAG,
             "boot-diag config: INT_GPIO=%d mode=INPUT pull=PULLUP edge=NEGEDGE level0=%d",
             (int)s.cfg.int_gpio, gpio_get_level(s.cfg.int_gpio));

    for (int i = 0; i < PPG_BOOT_DIAG_ITERS; i++) {
        uint8_t int1 = 0xFF, int2 = 0xFF;
        uint8_t en1 = 0xFF, en2 = 0xFF;
        uint8_t wr = 0xFF, rd = 0xFF, ovf = 0xFF;
        uint8_t mode = 0xFF, spo2 = 0xFF, fifo_cfg = 0xFF;
        uint8_t led1 = 0xFF, led2 = 0xFF;
        bool got_bus = false;

        if (xSemaphoreTake(s.i2c_mutex, pdMS_TO_TICKS(PPG_BOOT_DIAG_MUTEX_MS)) == pdTRUE) {
            got_bus = true;
            (void)reg_read(MAX3010X_REG_INT_STATUS_1, &int1);
            (void)reg_read(MAX3010X_REG_INT_STATUS_2, &int2);
            (void)reg_read(MAX3010X_REG_INT_ENABLE_1, &en1);
            (void)reg_read(MAX3010X_REG_INT_ENABLE_2, &en2);
            (void)reg_read(MAX3010X_REG_FIFO_WR_PTR,  &wr);
            (void)reg_read(MAX3010X_REG_FIFO_RD_PTR,  &rd);
            (void)reg_read(MAX3010X_REG_OVF_COUNTER,  &ovf);
            (void)reg_read(MAX3010X_REG_FIFO_CONFIG,  &fifo_cfg);
            (void)reg_read(MAX3010X_REG_MODE_CONFIG,  &mode);
            (void)reg_read(MAX3010X_REG_SPO2_CONFIG,  &spo2);
            (void)reg_read(MAX3010X_REG_LED1_PA,      &led1);
            (void)reg_read(MAX3010X_REG_LED2_PA,      &led2);
            xSemaphoreGive(s.i2c_mutex);
        }

        int gpio_lvl = gpio_get_level(s.cfg.int_gpio);

        if (got_bus) {
            ESP_LOGI(TAG,
                     "boot-diag[i=%d/%d] INT1=0x%02X INT2=0x%02X EN1=0x%02X EN2=0x%02X "
                     "WR=0x%02X RD=0x%02X OVF=0x%02X FIFOCFG=0x%02X "
                     "MODE=0x%02X SPO2=0x%02X LED1=0x%02X LED2=0x%02X "
                     "GPIO%d=%d",
                     i, PPG_BOOT_DIAG_ITERS,
                     int1, int2, en1, en2,
                     wr, rd, ovf, fifo_cfg,
                     mode, spo2, led1, led2,
                     (int)s.cfg.int_gpio, gpio_lvl);
        } else {
            ESP_LOGW(TAG,
                     "boot-diag[i=%d/%d] i2c mutex busy — skipped reg snapshot; GPIO%d=%d",
                     i, PPG_BOOT_DIAG_ITERS,
                     (int)s.cfg.int_gpio, gpio_lvl);
        }

        vTaskDelay(pdMS_TO_TICKS(PPG_BOOT_DIAG_PERIOD_MS));
    }

    ESP_LOGI(TAG, "boot-diag complete");
    vTaskDelete(NULL);
}

/* ============================================================
 * Public API: default config
 * ============================================================ */

ppg_driver_config_t ppg_driver_default_config(void)
{
    ppg_driver_config_t cfg = {
        .sample_rate_hz   = 200,
        .led_red_ma_x10   = 70,
        .led_ir_ma_x10    = 70,
        .led_green_ma_x10 = 0,
        .channels         = PPG_CH_RED | PPG_CH_IR,
        .sda_gpio         = 22,
        .scl_gpio         = 23,
        .int_gpio         = 0,
        .i2c_port         = 0,
    };
    return cfg;
}

/* ============================================================
 * Init
 * ============================================================ */

static esp_err_t soft_reset(void)
{
    esp_err_t err = reg_write(MAX3010X_REG_MODE_CONFIG, MAX3010X_MODE_RESET);
    if (err != ESP_OK) return err;
    /* Datasheet: bit clears within ~10 ms. Poll up to 100 ms. */
    for (int i = 0; i < 50; i++) {
        vTaskDelay(pdMS_TO_TICKS(2));
        uint8_t v = 0;
        err = reg_read(MAX3010X_REG_MODE_CONFIG, &v);
        if (err == ESP_OK && (v & MAX3010X_MODE_RESET) == 0) {
            return ESP_OK;
        }
    }
    return ESP_ERR_TIMEOUT;
}

static esp_err_t configure_fifo_and_mode(void)
{
    /* FIFO: no averaging, rollover enabled, A_FULL threshold programmed
     * so the IRQ fires with at least 17 unread samples in the FIFO. */
    const uint8_t fifo_cfg = MAX3010X_SMP_AVE_1
                           | MAX3010X_FIFO_ROLLOVER_EN
                           | PPG_FIFO_A_FULL_FIELD;
    ESP_RETURN_ON_ERROR(reg_write(MAX3010X_REG_FIFO_CONFIG, fifo_cfg), TAG, "fifo_cfg");

    bool need_multi_led = (s.channels_active & PPG_CH_GREEN) != 0;
    uint8_t mode_field = need_multi_led ? MAX3010X_MODE_MULTI_LED : MAX3010X_MODE_SPO2;
    ESP_RETURN_ON_ERROR(reg_write(MAX3010X_REG_MODE_CONFIG, mode_field), TAG, "mode_cfg");

    uint8_t sr_field;
    ESP_RETURN_ON_ERROR(sample_rate_to_field(s.cfg.sample_rate_hz, &sr_field), TAG, "sr");
    const uint8_t spo2_cfg = MAX3010X_ADC_RGE_8192NA | sr_field | MAX3010X_LED_PW_411US_18BIT;
    ESP_RETURN_ON_ERROR(reg_write(MAX3010X_REG_SPO2_CONFIG, spo2_cfg), TAG, "spo2_cfg");

    if (need_multi_led) {
        /* SLOT1=red, SLOT2=IR, SLOT3=green, SLOT4 disabled. */
        const uint8_t ml1 = (uint8_t)((MAX3010X_SLOT_IR << 4) | MAX3010X_SLOT_RED);
        const uint8_t ml2 = (uint8_t)((MAX3010X_SLOT_DISABLED << 4) | MAX3010X_SLOT_GREEN);
        ESP_RETURN_ON_ERROR(reg_write(MAX3010X_REG_MULTI_LED_CTRL1, ml1), TAG, "ml1");
        ESP_RETURN_ON_ERROR(reg_write(MAX3010X_REG_MULTI_LED_CTRL2, ml2), TAG, "ml2");
    }

    /* Reset FIFO pointers. */
    ESP_RETURN_ON_ERROR(reg_write(MAX3010X_REG_FIFO_WR_PTR, 0), TAG, "wr_ptr");
    ESP_RETURN_ON_ERROR(reg_write(MAX3010X_REG_FIFO_RD_PTR, 0), TAG, "rd_ptr");
    ESP_RETURN_ON_ERROR(reg_write(MAX3010X_REG_OVF_COUNTER, 0), TAG, "ovf");

    /* Enable A_FULL interrupt. */
    ESP_RETURN_ON_ERROR(reg_write(MAX3010X_REG_INT_ENABLE_1, MAX3010X_INT1_A_FULL),
                        TAG, "int_en");
    return ESP_OK;
}

static esp_err_t apply_led_currents(void)
{
    uint8_t led1 = (uint8_t)(s.cfg.led_red_ma_x10 / 2);
    uint8_t led2 = (uint8_t)(s.cfg.led_ir_ma_x10 / 2);
    ESP_RETURN_ON_ERROR(reg_write(MAX3010X_REG_LED1_PA, led1), TAG, "led1");
    ESP_RETURN_ON_ERROR(reg_write(MAX3010X_REG_LED2_PA, led2), TAG, "led2");
    if (s.channels_active & PPG_CH_GREEN) {
        uint8_t led3 = (uint8_t)(s.cfg.led_green_ma_x10 / 2);
        ESP_RETURN_ON_ERROR(reg_write(MAX3010X_REG_LED3_PA, led3), TAG, "led3");
    }
    return ESP_OK;
}

static esp_err_t install_isr(int int_gpio)
{
    gpio_config_t io = {
        .pin_bit_mask = 1ULL << int_gpio,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_NEGEDGE,
    };
    ESP_RETURN_ON_ERROR(gpio_config(&io), TAG, "gpio_config");

    esp_err_t err = gpio_install_isr_service(0);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGE(TAG, "gpio_install_isr_service: %s", esp_err_to_name(err));
        return err;
    }
    ESP_RETURN_ON_ERROR(gpio_isr_handler_add(int_gpio, ppg_isr, NULL), TAG, "isr_add");
    return ESP_OK;
}

esp_err_t ppg_driver_init(const ppg_driver_config_t *cfg)
{
    if (cfg == NULL) return ESP_ERR_INVALID_ARG;
    if (s.inited) return ESP_ERR_INVALID_STATE;

    s.cfg = *cfg;
    s.chip = PPG_CHIP_UNKNOWN;
    s.channels_active = cfg->channels & (PPG_CH_RED | PPG_CH_IR | PPG_CH_GREEN);
    if (s.channels_active == 0) {
        ESP_LOGE(TAG, "no channels selected");
        return ESP_ERR_INVALID_ARG;
    }
    /* 3 bytes per active channel, 18-bit MSB-first. */
    s.bytes_per_sample = (uint8_t)(3u * (uint8_t)__builtin_popcount(s.channels_active));
    s.period_us = 1000000 / cfg->sample_rate_hz;

    s.irq_sem = xSemaphoreCreateBinary();
    s.i2c_mutex = xSemaphoreCreateMutex();
    if (s.irq_sem == NULL || s.i2c_mutex == NULL) {
        ESP_LOGE(TAG, "sem/mutex alloc failed");
        return ESP_ERR_NO_MEM;
    }

    /* I2C bus + device. */
    i2c_master_bus_config_t bus_cfg = {
        .i2c_port = cfg->i2c_port,
        .sda_io_num = cfg->sda_gpio,
        .scl_io_num = cfg->scl_gpio,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    ESP_RETURN_ON_ERROR(i2c_new_master_bus(&bus_cfg, &s.bus), TAG, "i2c_bus");

    i2c_device_config_t dev_cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = MAX3010X_I2C_ADDR,
        .scl_speed_hz = PPG_I2C_FREQ_HZ,
    };
    ESP_RETURN_ON_ERROR(i2c_master_bus_add_device(s.bus, &dev_cfg, &s.dev), TAG, "i2c_dev");

    /* Soft reset, detect chip, configure. */
    ESP_RETURN_ON_ERROR(soft_reset(), TAG, "reset");
    ESP_RETURN_ON_ERROR(detect_chip(), TAG, "detect");

    if ((s.channels_active & PPG_CH_GREEN) && s.chip != PPG_CHIP_MAX30101) {
        ESP_LOGW(TAG, "GREEN channel requested but chip is MAX30102 — disabling");
        s.channels_active &= (uint8_t)~PPG_CH_GREEN;
        s.bytes_per_sample = (uint8_t)(3u * (uint8_t)__builtin_popcount(s.channels_active));
    }

    ESP_RETURN_ON_ERROR(apply_led_currents(), TAG, "led_pa");

    /* Spawn dispatch task BEFORE arming IRQ so the first IRQ has a consumer. */
    BaseType_t ok = xTaskCreate(ppg_task, "ppg_task", PPG_TASK_STACK,
                                NULL, PPG_TASK_PRIO, &s.task);
    if (ok != pdPASS) {
        ESP_LOGE(TAG, "task create failed");
        return ESP_ERR_NO_MEM;
    }

    /* CRITICAL ORDER: install the GPIO ISR (NEGEDGE) BEFORE configuring
     * the chip's INT_ENABLE_1 = A_FULL. configure_fifo_and_mode() switches
     * the chip into active sampling and arms the chip-side A_FULL
     * interrupt; at 200 Hz with two channels, the FIFO crosses the
     * A_FULL threshold within ~80 ms, the chip drives its open-drain
     * INT pin LOW, and the FIFO then overflows continuously — meaning
     * the line stays low forever. If the GPIO ISR isn't armed before
     * that single high→low transition, we miss the only edge we'll
     * ever see and the task blocks on irq_sem indefinitely (symptom:
     * "no IRQ in 1s — sensor stalled?" on every loop). */
    ESP_RETURN_ON_ERROR(install_isr(cfg->int_gpio), TAG, "isr");
    ESP_RETURN_ON_ERROR(configure_fifo_and_mode(), TAG, "fifo_mode");

    /* Boot-time stall diagnostic: one-shot task, 10 s at 1 Hz, lower
     * priority than ppg_task so it loses bus contention gracefully. */
    BaseType_t diag_ok = xTaskCreate(ppg_boot_diag_task, "ppg_boot_diag",
                                     PPG_BOOT_DIAG_STACK, NULL,
                                     PPG_BOOT_DIAG_PRIO, NULL);
    if (diag_ok != pdPASS) {
        /* Non-fatal — driver still works without the diagnostic. */
        ESP_LOGW(TAG, "boot-diag task create failed (non-fatal)");
    }

    s.inited = true;
    ESP_LOGI(TAG, "configured %u Hz, channels=0x%02X, LED red=%u.%u mA, IR=%u.%u mA",
             (unsigned)s.cfg.sample_rate_hz, s.channels_active,
             s.cfg.led_red_ma_x10 / 10, s.cfg.led_red_ma_x10 % 10,
             s.cfg.led_ir_ma_x10 / 10, s.cfg.led_ir_ma_x10 % 10);
    return ESP_OK;
}

esp_err_t ppg_driver_deinit(void)
{
    if (!s.inited) return ESP_ERR_INVALID_STATE;

    /* Stop IRQ first so the task drains once and exits cleanly. */
    gpio_isr_handler_remove(s.cfg.int_gpio);
    s.task_running = false;
    xSemaphoreGive(s.irq_sem);
    /* Self-deleting task — wait a fixed window rather than poll its handle. */
    vTaskDelay(pdMS_TO_TICKS(100));

    /* Power down the chip. */
    (void)reg_write(MAX3010X_REG_MODE_CONFIG, MAX3010X_MODE_SHDN);

    if (s.dev) i2c_master_bus_rm_device(s.dev);
    if (s.bus) i2c_del_master_bus(s.bus);
    if (s.irq_sem) vSemaphoreDelete(s.irq_sem);
    if (s.i2c_mutex) vSemaphoreDelete(s.i2c_mutex);

    /* Reset only the fields that need reset; cb_lock keeps its valid
     * spinlock state across init/deinit cycles. */
    s.inited = false;
    s.chip = PPG_CHIP_UNKNOWN;
    s.bus = NULL;
    s.dev = NULL;
    s.irq_sem = NULL;
    s.i2c_mutex = NULL;
    s.task = NULL;
    portENTER_CRITICAL(&s.cb_lock);
    s.sample_cb = NULL;
    s.sample_cb_ctx = NULL;
    portEXIT_CRITICAL(&s.cb_lock);
    return ESP_OK;
}

ppg_chip_type_t ppg_driver_get_chip_type(void)
{
    return s.chip;
}

esp_err_t ppg_driver_set_led_current(ppg_led_t led, uint16_t milliamps_x10)
{
    if (!s.inited) return ESP_ERR_INVALID_STATE;
    if (milliamps_x10 > 510) return ESP_ERR_INVALID_ARG;

    uint8_t reg;
    switch (led) {
        case PPG_LED_RED:   reg = MAX3010X_REG_LED1_PA; break;
        case PPG_LED_IR:    reg = MAX3010X_REG_LED2_PA; break;
        case PPG_LED_GREEN:
            if (s.chip != PPG_CHIP_MAX30101) return ESP_ERR_NOT_SUPPORTED;
            reg = MAX3010X_REG_LED3_PA;
            break;
        default: return ESP_ERR_INVALID_ARG;
    }

    uint8_t pa = (uint8_t)(milliamps_x10 / 2);
    if (xSemaphoreTake(s.i2c_mutex, pdMS_TO_TICKS(50)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    esp_err_t err = reg_write(reg, pa);
    xSemaphoreGive(s.i2c_mutex);

    if (err == ESP_OK) {
        switch (led) {
            case PPG_LED_RED:   s.cfg.led_red_ma_x10   = milliamps_x10; break;
            case PPG_LED_IR:    s.cfg.led_ir_ma_x10    = milliamps_x10; break;
            case PPG_LED_GREEN: s.cfg.led_green_ma_x10 = milliamps_x10; break;
        }
    }
    return err;
}

esp_err_t ppg_driver_set_sample_rate(uint16_t hz)
{
    if (!s.inited) return ESP_ERR_INVALID_STATE;
    uint8_t field;
    esp_err_t err = sample_rate_to_field(hz, &field);
    if (err != ESP_OK) return err;

    if (xSemaphoreTake(s.i2c_mutex, pdMS_TO_TICKS(50)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    /* SPO2_SR is bits [4:2] of SPO2_CONFIG. */
    err = reg_update(MAX3010X_REG_SPO2_CONFIG, 0x1Cu, field);
    xSemaphoreGive(s.i2c_mutex);

    if (err == ESP_OK) {
        s.cfg.sample_rate_hz = hz;
        s.period_us = 1000000 / hz;
    }
    return err;
}

esp_err_t ppg_driver_register_sample_callback(ppg_sample_callback_t cb, void *user_ctx)
{
    if (!s.inited) return ESP_ERR_INVALID_STATE;
    portENTER_CRITICAL(&s.cb_lock);
    s.sample_cb = cb;
    s.sample_cb_ctx = user_ctx;
    portEXIT_CRITICAL(&s.cb_lock);
    return ESP_OK;
}

esp_err_t ppg_driver_unregister_sample_callback(void)
{
    portENTER_CRITICAL(&s.cb_lock);
    s.sample_cb = NULL;
    s.sample_cb_ctx = NULL;
    portEXIT_CRITICAL(&s.cb_lock);
    return ESP_OK;
}
