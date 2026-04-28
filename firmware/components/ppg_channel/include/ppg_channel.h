/*
 * ppg_channel.h — channel selection, DC-baseline tracking, AGC.
 *
 * Consumes raw `ppg_sample_t` from the MAX3010x driver and emits
 * `ppg_processed_sample_t` to the next stage (elgendi). Internal type;
 * never serialized to the wire.
 *
 * AGC adjusts LED current via the driver's set_led_current API when the
 * tracked DC baseline drifts outside the configured target window. Calls
 * into the driver are safe from the driver's sample-callback context
 * because the driver releases its I2C mutex before dispatching samples
 * (see ppg_driver_max3010x.c::drain_fifo).
 */

#ifndef NARBIS_PPG_CHANNEL_H
#define NARBIS_PPG_CHANNEL_H

#include <stdint.h>

#include "esp_err.h"

#include "narbis_protocol.h"
#include "ppg_driver_max3010x.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    PPG_PROCESSED_FLAG_SATURATED      = 0x01u,
    PPG_PROCESSED_FLAG_CHANNEL_RESET  = 0x02u,  /* first sample after reset */
} ppg_processed_flag_t;

typedef enum {
    PPG_ACTIVE_RED   = 0,
    PPG_ACTIVE_IR    = 1,
    PPG_ACTIVE_GREEN = 2,
} ppg_active_channel_t;

/* Output of the channel stage. AC component is signed (raw - DC). DC is
 * exported for AGC visibility / SQI computation downstream. */
typedef struct {
    uint32_t timestamp_ms;     /* ppg_sample_t.timestamp_us / 1000 */
    uint32_t sample_index;     /* monotonic, 0 at init */
    int32_t  ac;               /* raw - dc_baseline */
    uint32_t dc_baseline;      /* IIR-tracked DC level (ADC counts) */
    uint8_t  active_channel;   /* ppg_active_channel_t */
    uint8_t  flags;            /* PPG_PROCESSED_FLAG_* */
} ppg_processed_sample_t;

typedef void (*ppg_channel_output_cb_t)(const ppg_processed_sample_t *s, void *ctx);

esp_err_t ppg_channel_init(void);
esp_err_t ppg_channel_deinit(void);

/* Register the downstream consumer. Only one callback at a time. */
esp_err_t ppg_channel_register_output_cb(ppg_channel_output_cb_t cb, void *ctx);

/* Synchronously process one raw sample. Called from the driver's task. */
void ppg_channel_feed(const ppg_sample_t *raw);

/* Apply runtime config (AGC + target DC bounds). Safe to call any time. */
esp_err_t ppg_channel_apply_config(const narbis_runtime_config_t *cfg);

/* Drop DC baseline + saturation history. Next emitted sample carries
 * PPG_PROCESSED_FLAG_CHANNEL_RESET so downstream stages can flush state. */
void ppg_channel_reset_dsp_state(void);

#ifdef __cplusplus
}
#endif

#endif /* NARBIS_PPG_CHANNEL_H */
