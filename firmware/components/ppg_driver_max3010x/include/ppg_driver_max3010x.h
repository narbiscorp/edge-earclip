/*
 * ppg_driver_max3010x.h — public API for the MAX30102 / MAX30101 PPG driver.
 *
 * Hardware (XIAO ESP32-C6, see CLAUDE.md):
 *   SDA = GPIO22, SCL = GPIO23, INT = GPIO0, VIN = 3.3 V (NOT 5 V).
 *
 * The driver auto-detects the chip on init, configures the FIFO for
 * interrupt-driven sampling, and dispatches each sample to a registered
 * callback from a dedicated FreeRTOS task. Callbacks run in task context
 * (NOT in ISR) but on the driver's own task — the callback must not call
 * back into the driver's I2C path or it will deadlock. Pushing samples
 * to a queue or calling lightweight DSP code is fine.
 */

#ifndef NARBIS_PPG_DRIVER_MAX3010X_H
#define NARBIS_PPG_DRIVER_MAX3010X_H

#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    PPG_CHIP_UNKNOWN = 0,
    PPG_CHIP_MAX30102,
    PPG_CHIP_MAX30101,
} ppg_chip_type_t;

typedef enum {
    PPG_LED_RED   = 0,  /* LED1_PA on both chips */
    PPG_LED_IR    = 1,  /* LED2_PA on both chips */
    PPG_LED_GREEN = 2,  /* LED3_PA — MAX30101 only */
} ppg_led_t;

#define PPG_CH_RED    0x01u
#define PPG_CH_IR     0x02u
#define PPG_CH_GREEN  0x04u

typedef struct {
    int64_t  timestamp_us;     /* esp_timer_get_time() at sample capture */
    uint32_t red;              /* 18-bit ADC counts; 0 if RED not active */
    uint32_t ir;               /* 18-bit ADC counts; 0 if IR not active */
    uint32_t green;            /* 18-bit ADC counts; 0 if GREEN not active */
    uint8_t  channels_active;  /* PPG_CH_* bitmask */
} ppg_sample_t;

typedef void (*ppg_sample_callback_t)(const ppg_sample_t *sample, void *user_ctx);

typedef struct {
    uint16_t sample_rate_hz;   /* 50 / 100 / 200 / 400 — default 200 */
    uint16_t led_red_ma_x10;   /* default 70 (= 7.0 mA) */
    uint16_t led_ir_ma_x10;    /* default 70 (= 7.0 mA) */
    uint16_t led_green_ma_x10; /* default 0; ignored on MAX30102 */
    uint8_t  channels;         /* PPG_CH_* mask, default RED|IR */
    int      sda_gpio;         /* default GPIO22 */
    int      scl_gpio;         /* default GPIO23 */
    int      int_gpio;         /* default GPIO0 */
    uint8_t  i2c_port;         /* default 0 */
} ppg_driver_config_t;

/* Build a config populated with the XIAO ESP32-C6 defaults. */
ppg_driver_config_t ppg_driver_default_config(void);

/* Init I2C, detect chip, configure the FIFO, install IRQ, start the
 * dispatch task. Idempotent failure on re-init returns ESP_ERR_INVALID_STATE. */
esp_err_t ppg_driver_init(const ppg_driver_config_t *cfg);

/* Stop sampling, tear down task / IRQ / I2C. */
esp_err_t ppg_driver_deinit(void);

/* Returns the auto-detected chip, or PPG_CHIP_UNKNOWN if init has not
 * succeeded yet. */
ppg_chip_type_t ppg_driver_get_chip_type(void);

/* Set per-LED current in 0.1 mA units. Range: 0..510 (= 0..51.0 mA).
 * Returns ESP_ERR_INVALID_ARG if out of range or LED not supported on
 * the detected chip (e.g. GREEN on MAX30102). */
esp_err_t ppg_driver_set_led_current(ppg_led_t led, uint16_t milliamps_x10);

/* Read back the last-applied LED current in 0.1 mA units. Reflects the
 * driver's internal cache of the last successful set, NOT a register
 * readback — but since AGC writes go through ppg_driver_set_led_current()
 * the cache is authoritative. Returns ESP_ERR_INVALID_ARG on bad LED. */
esp_err_t ppg_driver_get_led_current(ppg_led_t led, uint16_t *milliamps_x10);

/* Change sample rate at runtime. Valid: 50, 100, 200, 400. */
esp_err_t ppg_driver_set_sample_rate(uint16_t hz);

/* Register / unregister the per-sample callback. Only one callback is
 * installed at a time; registering replaces the previous one. */
esp_err_t ppg_driver_register_sample_callback(ppg_sample_callback_t cb, void *user_ctx);
esp_err_t ppg_driver_unregister_sample_callback(void);

#ifdef __cplusplus
}
#endif

#endif /* NARBIS_PPG_DRIVER_MAX3010X_H */
