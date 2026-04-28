/*
 * beat_validator.c — IBI plausibility + continuity (running median over
 * the last 10 IBIs). Never drops: every peak after the first emits an
 * event, with NARBIS_BEAT_FLAG_ARTIFACT / LOW_CONFIDENCE flags + a
 * confidence score reflecting which checks passed.
 *
 * The very first peak has no prior IBI to compute, so it is recorded
 * silently (no event emitted) — every later peak yields an event.
 *
 * The IBI ring buffer accumulates the *raw* observed IBI even when the
 * beat is flagged as artifact, so the running median tracks the true
 * physiological rate rather than a sanitized subset.
 */

#include "beat_validator.h"

#include <stdint.h>
#include <string.h>
#include <stdbool.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/portmacro.h"

static const char *TAG = "beat_validator";

#define BV_RING_LEN 10

#define BV_DEFAULT_IBI_MIN_MS         300
#define BV_DEFAULT_IBI_MAX_MS         2000
#define BV_DEFAULT_IBI_MAX_DELTA_PCT  30
#define BV_DEFAULT_SQI_THRESHOLD_X100 50

typedef struct {
    bool     inited;

    uint16_t ibi_min_ms;
    uint16_t ibi_max_ms;
    uint8_t  ibi_max_delta_pct;
    uint16_t sqi_threshold_x100;

    bool     have_prev;
    uint32_t prev_ts_ms;
    uint16_t prev_ibi_ms;

    uint16_t ring[BV_RING_LEN];
    uint8_t  ring_head;
    uint8_t  ring_filled;

    portMUX_TYPE              cb_lock;
    beat_validator_event_cb_t out_cb;
    void                     *out_ctx;
} bv_state_t;

static bv_state_t s = {
    .cb_lock = portMUX_INITIALIZER_UNLOCKED,
};

static void load_defaults(bv_state_t *st)
{
    st->ibi_min_ms         = BV_DEFAULT_IBI_MIN_MS;
    st->ibi_max_ms         = BV_DEFAULT_IBI_MAX_MS;
    st->ibi_max_delta_pct  = BV_DEFAULT_IBI_MAX_DELTA_PCT;
    st->sqi_threshold_x100 = BV_DEFAULT_SQI_THRESHOLD_X100;
}

esp_err_t beat_validator_init(void)
{
    if (s.inited) return ESP_ERR_INVALID_STATE;

    portMUX_TYPE saved = s.cb_lock;
    beat_validator_event_cb_t saved_cb = s.out_cb;
    void *saved_ctx = s.out_ctx;
    memset(&s, 0, sizeof(s));
    s.cb_lock = saved;
    s.out_cb = saved_cb;
    s.out_ctx = saved_ctx;

    load_defaults(&s);
    s.inited = true;

    ESP_LOGI(TAG, "init: ibi=[%u..%u] ms delta_pct=%u sqi_thr=%u.%02u",
             s.ibi_min_ms, s.ibi_max_ms, s.ibi_max_delta_pct,
             s.sqi_threshold_x100 / 100, s.sqi_threshold_x100 % 100);
    return ESP_OK;
}

esp_err_t beat_validator_deinit(void)
{
    s.inited = false;
    portENTER_CRITICAL(&s.cb_lock);
    s.out_cb = NULL;
    s.out_ctx = NULL;
    portEXIT_CRITICAL(&s.cb_lock);
    return ESP_OK;
}

esp_err_t beat_validator_register_event_cb(beat_validator_event_cb_t cb, void *ctx)
{
    if (!s.inited) return ESP_ERR_INVALID_STATE;
    portENTER_CRITICAL(&s.cb_lock);
    s.out_cb = cb;
    s.out_ctx = ctx;
    portEXIT_CRITICAL(&s.cb_lock);
    return ESP_OK;
}

esp_err_t beat_validator_apply_config(const narbis_runtime_config_t *cfg)
{
    if (!s.inited) return ESP_ERR_INVALID_STATE;
    if (cfg == NULL) return ESP_ERR_INVALID_ARG;

    s.ibi_min_ms         = (cfg->ibi_min_ms > 0) ? cfg->ibi_min_ms : BV_DEFAULT_IBI_MIN_MS;
    s.ibi_max_ms         = (cfg->ibi_max_ms > s.ibi_min_ms)
                                ? cfg->ibi_max_ms : BV_DEFAULT_IBI_MAX_MS;
    s.ibi_max_delta_pct  = (cfg->ibi_max_delta_pct > 0) ? cfg->ibi_max_delta_pct
                                                        : BV_DEFAULT_IBI_MAX_DELTA_PCT;
    s.sqi_threshold_x100 = cfg->sqi_threshold_x100;
    return ESP_OK;
}

/* Insertion sort + median (n is at most BV_RING_LEN = 10). */
static uint16_t running_median(void)
{
    if (s.ring_filled == 0) return 0;
    uint16_t buf[BV_RING_LEN];
    uint8_t n = s.ring_filled;
    for (uint8_t i = 0; i < n; i++) {
        buf[i] = s.ring[i];
    }
    for (uint8_t i = 1; i < n; i++) {
        uint16_t key = buf[i];
        int8_t j = (int8_t)(i - 1);
        while (j >= 0 && buf[j] > key) {
            buf[j + 1] = buf[j];
            j--;
        }
        buf[j + 1] = key;
    }
    return buf[n / 2];
}

static void push_ibi(uint16_t ibi_ms)
{
    s.ring[s.ring_head] = ibi_ms;
    s.ring_head = (uint8_t)((s.ring_head + 1) % BV_RING_LEN);
    if (s.ring_filled < BV_RING_LEN) s.ring_filled++;
}

static int32_t clamp_amp_u16(int32_t v)
{
    if (v < 0)         return 0;
    if (v > UINT16_MAX) return UINT16_MAX;
    return v;
}

void beat_validator_feed(const elgendi_peak_t *p)
{
    if (!s.inited || p == NULL) return;

    if (!s.have_prev) {
        s.have_prev = true;
        s.prev_ts_ms = p->timestamp_ms;
        s.prev_ibi_ms = 0;
        return;
    }

    uint32_t dt = (p->timestamp_ms >= s.prev_ts_ms)
                      ? (p->timestamp_ms - s.prev_ts_ms) : 0;
    uint16_t ibi = (dt > UINT16_MAX) ? UINT16_MAX : (uint16_t)dt;

    int confidence = 100;
    uint8_t flags = 0;

    bool plausibility_ok = (ibi >= s.ibi_min_ms) && (ibi <= s.ibi_max_ms);
    if (!plausibility_ok) {
        flags |= NARBIS_BEAT_FLAG_ARTIFACT;
        confidence = 0;
    }

    if (s.ring_filled > 0) {
        uint16_t median = running_median();
        if (median > 0) {
            int32_t diff = (int32_t)ibi - (int32_t)median;
            if (diff < 0) diff = -diff;
            int32_t threshold = ((int32_t)median * (int32_t)s.ibi_max_delta_pct) / 100;
            if (diff > threshold) {
                flags |= NARBIS_BEAT_FLAG_ARTIFACT;
                confidence -= 50;
                if (confidence < 0) confidence = 0;
            }
        }
    }

    if (confidence < (int)s.sqi_threshold_x100) {
        flags |= NARBIS_BEAT_FLAG_LOW_CONFIDENCE;
    }

    /* Always update the median ring with the raw observation. */
    push_ibi(ibi);

    beat_event_t evt = {
        .timestamp_ms    = p->timestamp_ms,
        .ibi_ms          = ibi,
        .prev_ibi_ms     = s.prev_ibi_ms,
        .confidence_x100 = (uint8_t)((confidence < 0) ? 0
                                   : (confidence > 100) ? 100 : confidence),
        .flags           = flags,
        .peak_amplitude  = (uint16_t)clamp_amp_u16(p->amplitude),
        .sample_index    = p->sample_index,
    };

    beat_validator_event_cb_t cb;
    void *ctx;
    portENTER_CRITICAL(&s.cb_lock);
    cb = s.out_cb;
    ctx = s.out_ctx;
    portEXIT_CRITICAL(&s.cb_lock);
    if (cb != NULL) cb(&evt, ctx);

    s.prev_ts_ms  = p->timestamp_ms;
    s.prev_ibi_ms = ibi;
}
