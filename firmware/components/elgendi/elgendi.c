/*
 * elgendi.c — bandpass + Elgendi systolic peak detection.
 *
 * Fixed-point conventions:
 *   - Biquad coefficients: signed Q28 (range ±8.0). Q30 would fit b0/b1/b2
 *     and a2 of a Butterworth BP at 0.5 Hz / 200 Hz fs, but a1 has magnitude
 *     up to ~2.0 and overflows Q30 by epsilon — Q28 keeps margin.
 *   - Biquad state (DF-II Transposed): int64_t accumulators; multiply x32
 *     by coefficient x32 → int64 product, summed, then >>28.
 *   - Filter input: int32 (channel stage's signed AC).
 *   - Filter output: int32 (saturated post-shift).
 *   - Squared signal: int64 (max ≈ (2^31)^2 = 4.6e18, fits with margin).
 *   - MA(W1)/MA(W2) ring sums: int64.
 *
 * Design recipe for the default 0.5–8 Hz @ 200 Hz coefficients (BPF):
 *
 *   # scipy.signal-style cookbook BPF (constant 0 dB peak gain)
 *   import math
 *   fs = 200; f_low = 0.5; f_high = 8.0
 *   f0 = math.sqrt(f_low * f_high)
 *   bw_oct = math.log2(f_high / f_low)
 *   w0 = 2 * math.pi * f0 / fs
 *   alpha = math.sin(w0) * math.sinh(math.log(2)/2 * bw_oct * w0 / math.sin(w0))
 *   b0 =  alpha;          b1 = 0;            b2 = -alpha
 *   a0 =  1 + alpha;      a1 = -2*math.cos(w0); a2 = 1 - alpha
 *   # Normalize by a0, then encode each as round(c * (1<<28)).
 *
 * Refractory period uses narbis_runtime_config_t.ibi_min_ms (which doubles
 * as the validator's IBI floor — single physiological constant).
 */

#include "elgendi.h"

#include <math.h>
#include <string.h>
#include <stdbool.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/portmacro.h"

static const char *TAG = "elgendi";

#define ELGENDI_Q                28
#define ELGENDI_Q_ONE            ((int32_t)((int64_t)1 << ELGENDI_Q))

/* Sized for fs_max = 400 Hz: W1=44, W2=267 → round up. */
#define ELGENDI_W1_MAX_SAMPLES   64
#define ELGENDI_W2_MAX_SAMPLES   320

#define ELGENDI_DEFAULT_FS_HZ    200
#define ELGENDI_DEFAULT_LOW_X100 50    /* 0.50 Hz */
#define ELGENDI_DEFAULT_HIGH_X100 800  /* 8.00 Hz */
#define ELGENDI_DEFAULT_W1_MS    111
#define ELGENDI_DEFAULT_W2_MS    667
#define ELGENDI_DEFAULT_BETA_X1000 20
#define ELGENDI_DEFAULT_REFRACTORY_MS 300

typedef struct {
    bool     inited;

    /* Derived from config. */
    uint16_t sample_rate_hz;
    uint16_t bp_low_x100;
    uint16_t bp_high_x100;
    uint16_t w1_samples;
    uint16_t w2_samples;
    uint16_t beta_x1000;
    uint16_t refractory_ms;          /* base floor from ibi_min_ms */
    uint8_t  refractory_ibi_pct;     /* dynamic: refractory = max(floor, pct·last_IBI/100) */
    uint32_t override_refractory_ms; /* if non-zero, supersedes both above */
    uint32_t last_ibi_ms;            /* delta between the two most recent emitted peaks */

    /* Biquad coeffs (Q28) — single 2nd-order section, DF-II Transposed,
     * a0 normalized to 1 so only b0/b1/b2/a1/a2 are stored. */
    int32_t  b0, b1, b2;
    int32_t  a1, a2;
    int64_t  z1, z2;          /* state */

    /* Squared-signal MA ring buffers. */
    int64_t  w1_buf[ELGENDI_W1_MAX_SAMPLES];
    int64_t  w2_buf[ELGENDI_W2_MAX_SAMPLES];
    uint16_t w1_head, w2_head;
    uint16_t w1_filled, w2_filled;
    int64_t  w1_sum, w2_sum;

    /* Block tracking. */
    bool     in_block;
    int32_t  block_max_amp;
    uint32_t block_max_ts_ms;
    uint32_t block_max_idx;

    /* Refractory. */
    bool     has_last_peak;
    uint32_t last_peak_ts_ms;

    /* Output. */
    portMUX_TYPE          cb_lock;
    elgendi_peak_cb_t     out_cb;
    void                 *out_ctx;
    elgendi_filtered_cb_t filtered_cb;
    void                 *filtered_ctx;
} elgendi_state_t;

static elgendi_state_t s = {
    .cb_lock = portMUX_INITIALIZER_UNLOCKED,
};

static inline int64_t sat_q28_to_i32(int64_t v)
{
    /* After shift, v fits in int32 range provided coeffs and state are
     * sane. Saturate defensively to avoid wrap-around on transient blow-up. */
    if (v >  (int64_t)INT32_MAX) return INT32_MAX;
    if (v < -(int64_t)INT32_MAX) return -INT32_MAX;
    return v;
}

static int32_t float_to_q28(float v)
{
    float scaled = v * (float)ELGENDI_Q_ONE;
    if (scaled >  (float)INT32_MAX) return INT32_MAX;
    if (scaled < -(float)INT32_MAX) return -INT32_MAX;
    return (int32_t)lroundf(scaled);
}

static void compute_bp_coeffs(uint16_t fs_hz, uint16_t low_x100, uint16_t high_x100,
                              int32_t *b0, int32_t *b1, int32_t *b2,
                              int32_t *a1, int32_t *a2)
{
    float fs = (float)fs_hz;
    float f_low  = (float)low_x100 / 100.0f;
    float f_high = (float)high_x100 / 100.0f;
    if (f_low  <= 0.0f)        f_low  = 0.5f;
    if (f_high >= fs * 0.5f)   f_high = fs * 0.5f - 0.1f;
    if (f_high <= f_low)       f_high = f_low + 0.1f;

    float f0 = sqrtf(f_low * f_high);
    float bw_oct = log2f(f_high / f_low);
    float w0 = 2.0f * (float)M_PI * f0 / fs;
    float sin_w0 = sinf(w0);
    float cos_w0 = cosf(w0);
    float alpha = sin_w0 * sinhf(0.5f * logf(2.0f) * bw_oct * w0 / sin_w0);

    float a0_n =  1.0f + alpha;
    float b0_n =  alpha;
    float b1_n =  0.0f;
    float b2_n = -alpha;
    float a1_n = -2.0f * cos_w0;
    float a2_n =  1.0f - alpha;

    /* Normalize by a0. */
    *b0 = float_to_q28(b0_n / a0_n);
    *b1 = float_to_q28(b1_n / a0_n);
    *b2 = float_to_q28(b2_n / a0_n);
    *a1 = float_to_q28(a1_n / a0_n);
    *a2 = float_to_q28(a2_n / a0_n);
}

static uint16_t ms_to_samples(uint16_t ms, uint16_t fs_hz, uint16_t cap)
{
    uint32_t n = ((uint32_t)ms * fs_hz + 500u) / 1000u;
    if (n < 1)   n = 1;
    if (n > cap) n = cap;
    return (uint16_t)n;
}

static void reset_dsp(void)
{
    s.z1 = 0;
    s.z2 = 0;
    memset(s.w1_buf, 0, sizeof(s.w1_buf));
    memset(s.w2_buf, 0, sizeof(s.w2_buf));
    s.w1_head = 0; s.w2_head = 0;
    s.w1_filled = 0; s.w2_filled = 0;
    s.w1_sum = 0; s.w2_sum = 0;
    s.in_block = false;
    s.block_max_amp = INT32_MIN;
    s.block_max_ts_ms = 0;
    s.block_max_idx = 0;
    s.has_last_peak = false;
    s.last_peak_ts_ms = 0;
    s.last_ibi_ms = 0;
}

static void load_defaults(void)
{
    s.sample_rate_hz = ELGENDI_DEFAULT_FS_HZ;
    s.bp_low_x100    = ELGENDI_DEFAULT_LOW_X100;
    s.bp_high_x100   = ELGENDI_DEFAULT_HIGH_X100;
    s.w1_samples     = ms_to_samples(ELGENDI_DEFAULT_W1_MS, s.sample_rate_hz,
                                     ELGENDI_W1_MAX_SAMPLES);
    s.w2_samples     = ms_to_samples(ELGENDI_DEFAULT_W2_MS, s.sample_rate_hz,
                                     ELGENDI_W2_MAX_SAMPLES);
    s.beta_x1000     = ELGENDI_DEFAULT_BETA_X1000;
    s.refractory_ms  = ELGENDI_DEFAULT_REFRACTORY_MS;
    s.refractory_ibi_pct    = 60;
    s.override_refractory_ms = 0;
    s.last_ibi_ms    = 0;
    compute_bp_coeffs(s.sample_rate_hz, s.bp_low_x100, s.bp_high_x100,
                      &s.b0, &s.b1, &s.b2, &s.a1, &s.a2);
}

esp_err_t elgendi_init(void)
{
    if (s.inited) return ESP_ERR_INVALID_STATE;

    portMUX_TYPE saved = s.cb_lock;
    elgendi_peak_cb_t saved_cb = s.out_cb;
    void *saved_ctx = s.out_ctx;
    memset(&s, 0, sizeof(s));
    s.cb_lock = saved;
    s.out_cb  = saved_cb;
    s.out_ctx = saved_ctx;

    load_defaults();
    reset_dsp();
    s.inited = true;

    ESP_LOGI(TAG, "init: bp=%u.%02u..%u.%02u Hz w1=%u w2=%u beta=%u.%03u refr=%u ms",
             s.bp_low_x100 / 100, s.bp_low_x100 % 100,
             s.bp_high_x100 / 100, s.bp_high_x100 % 100,
             s.w1_samples, s.w2_samples,
             s.beta_x1000 / 1000, s.beta_x1000 % 1000,
             s.refractory_ms);
    return ESP_OK;
}

esp_err_t elgendi_deinit(void)
{
    s.inited = false;
    portENTER_CRITICAL(&s.cb_lock);
    s.out_cb = NULL;
    s.out_ctx = NULL;
    portEXIT_CRITICAL(&s.cb_lock);
    return ESP_OK;
}

esp_err_t elgendi_register_peak_cb(elgendi_peak_cb_t cb, void *ctx)
{
    if (!s.inited) return ESP_ERR_INVALID_STATE;
    portENTER_CRITICAL(&s.cb_lock);
    s.out_cb = cb;
    s.out_ctx = ctx;
    portEXIT_CRITICAL(&s.cb_lock);
    return ESP_OK;
}

esp_err_t elgendi_register_filtered_cb(elgendi_filtered_cb_t cb, void *ctx)
{
    if (!s.inited) return ESP_ERR_INVALID_STATE;
    portENTER_CRITICAL(&s.cb_lock);
    s.filtered_cb = cb;
    s.filtered_ctx = ctx;
    portEXIT_CRITICAL(&s.cb_lock);
    return ESP_OK;
}

esp_err_t elgendi_apply_config(const narbis_runtime_config_t *cfg)
{
    if (!s.inited) return ESP_ERR_INVALID_STATE;
    if (cfg == NULL) return ESP_ERR_INVALID_ARG;

    s.sample_rate_hz = (cfg->sample_rate_hz > 0) ? cfg->sample_rate_hz
                                                 : ELGENDI_DEFAULT_FS_HZ;
    s.bp_low_x100    = (cfg->bandpass_low_hz_x100 > 0)
                           ? cfg->bandpass_low_hz_x100 : ELGENDI_DEFAULT_LOW_X100;
    s.bp_high_x100   = (cfg->bandpass_high_hz_x100 > s.bp_low_x100)
                           ? cfg->bandpass_high_hz_x100 : ELGENDI_DEFAULT_HIGH_X100;
    s.w1_samples     = ms_to_samples((cfg->elgendi_w1_ms > 0) ? cfg->elgendi_w1_ms
                                                              : ELGENDI_DEFAULT_W1_MS,
                                     s.sample_rate_hz, ELGENDI_W1_MAX_SAMPLES);
    s.w2_samples     = ms_to_samples((cfg->elgendi_w2_ms > 0) ? cfg->elgendi_w2_ms
                                                              : ELGENDI_DEFAULT_W2_MS,
                                     s.sample_rate_hz, ELGENDI_W2_MAX_SAMPLES);
    if (s.w2_samples <= s.w1_samples) s.w2_samples = (uint16_t)(s.w1_samples + 1);
    s.beta_x1000     = cfg->elgendi_beta_x1000;
    s.refractory_ms  = (cfg->ibi_min_ms > 0) ? cfg->ibi_min_ms
                                             : ELGENDI_DEFAULT_REFRACTORY_MS;
    s.refractory_ibi_pct = (cfg->refractory_ibi_pct <= 100) ? cfg->refractory_ibi_pct : 60;

    int32_t nb0, nb1, nb2, na1, na2;
    compute_bp_coeffs(s.sample_rate_hz, s.bp_low_x100, s.bp_high_x100,
                      &nb0, &nb1, &nb2, &na1, &na2);

    /* Atomic-ish swap: take the same critical section feed() uses. */
    portENTER_CRITICAL(&s.cb_lock);
    s.b0 = nb0; s.b1 = nb1; s.b2 = nb2;
    s.a1 = na1; s.a2 = na2;
    s.z1 = 0; s.z2 = 0;
    portEXIT_CRITICAL(&s.cb_lock);

    /* MA + block + refractory state must be flushed when windows change. */
    reset_dsp();
    return ESP_OK;
}

void elgendi_reset_state(void)
{
    portENTER_CRITICAL(&s.cb_lock);
    reset_dsp();
    portEXIT_CRITICAL(&s.cb_lock);
}

static inline int32_t biquad_step(int32_t x)
{
    /* DF-II Transposed:
     *   y = (b0*x + z1) >> Q
     *   z1 = b1*x - a1*y + z2
     *   z2 = b2*x - a2*y
     */
    int64_t bx0 = (int64_t)s.b0 * x;
    int64_t y_full = bx0 + s.z1;
    int32_t y = (int32_t)sat_q28_to_i32(y_full >> ELGENDI_Q);

    int64_t bx1 = (int64_t)s.b1 * x;
    int64_t ay1 = (int64_t)s.a1 * y;
    s.z1 = bx1 - ay1 + s.z2;

    int64_t bx2 = (int64_t)s.b2 * x;
    int64_t ay2 = (int64_t)s.a2 * y;
    s.z2 = bx2 - ay2;

    return y;
}

static void emit_peak(uint32_t ts_ms, uint32_t idx, int32_t amp)
{
    elgendi_peak_t evt = {
        .timestamp_ms = ts_ms,
        .sample_index = idx,
        .amplitude    = amp,
    };
    elgendi_peak_cb_t cb;
    void *ctx;
    portENTER_CRITICAL(&s.cb_lock);
    cb = s.out_cb;
    ctx = s.out_ctx;
    portEXIT_CRITICAL(&s.cb_lock);
    if (cb != NULL) cb(&evt, ctx);
}

void elgendi_feed(const ppg_processed_sample_t *ps)
{
    if (!s.inited || ps == NULL) return;

    if (ps->flags & PPG_PROCESSED_FLAG_CHANNEL_RESET) {
        reset_dsp();
    }

    /* 1) Bandpass. */
    int32_t y = biquad_step(ps->ac);

    /* 2) Square (always non-negative, int64 to avoid overflow). */
    int64_t sq = (int64_t)y * (int64_t)y;

    /* 3) Push into both MA ring buffers; update sums. */
    int64_t old_w1 = s.w1_buf[s.w1_head];
    s.w1_buf[s.w1_head] = sq;
    s.w1_sum += sq - old_w1;
    s.w1_head = (uint16_t)((s.w1_head + 1) % s.w1_samples);
    if (s.w1_filled < s.w1_samples) s.w1_filled++;

    int64_t old_w2 = s.w2_buf[s.w2_head];
    s.w2_buf[s.w2_head] = sq;
    s.w2_sum += sq - old_w2;
    s.w2_head = (uint16_t)((s.w2_head + 1) % s.w2_samples);
    if (s.w2_filled < s.w2_samples) s.w2_filled++;

    /* 4) Wait for both windows to fill before any peak detection. This
     * also covers the bandpass settling time (~W2 samples is plenty). */
    if (s.w2_filled < s.w2_samples) return;

    /* Emit per-sample bandpass output for the diagnostic stream. Done
     * after settling so the dashboard's filtered chart isn't flooded
     * with the biquad ramp transient on first connection. */
    if (s.filtered_cb != NULL) {
        const elgendi_filtered_sample_t f = {
            .timestamp_ms = ps->timestamp_ms,
            .filtered     = y,
        };
        s.filtered_cb(&f, s.filtered_ctx);
    }

    /* 5) Trigger condition (avoid division):
     *      MA1 > MA2 * (1 + beta)
     *  ⇒ (W1_sum / W1) > (W2_sum / W2) * (1000 + beta_x1000) / 1000
     *  ⇒ W1_sum * W2 * 1000 > W2_sum * W1 * (1000 + beta_x1000)
     *
     * All operands are non-negative; LHS/RHS easily fit int64 because
     * the squared signal has been averaged across W1/W2 already. */
    int64_t lhs = s.w1_sum * (int64_t)s.w2_samples * 1000;
    int64_t rhs = s.w2_sum * (int64_t)s.w1_samples *
                  (int64_t)(1000 + (int32_t)s.beta_x1000);
    bool above = (lhs > rhs);

    /* 6) Block tracking + local-max within the block. */
    if (above && !s.in_block) {
        s.in_block = true;
        s.block_max_amp   = y;
        s.block_max_ts_ms = ps->timestamp_ms;
        s.block_max_idx   = ps->sample_index;
    } else if (above && s.in_block) {
        if (y > s.block_max_amp) {
            s.block_max_amp   = y;
            s.block_max_ts_ms = ps->timestamp_ms;
            s.block_max_idx   = ps->sample_index;
        }
    } else if (!above && s.in_block) {
        s.in_block = false;

        /* 7) Refractory check. Three sources, in priority order:
         *      a) override_refractory_ms (set by adaptive_detector via setter)
         *      b) refractory_ibi_pct × last_IBI / 100, floor at refractory_ms
         *      c) bare refractory_ms (= ibi_min_ms)
         * (a) lets the Kalman-tracked IBI in adaptive mode dominate; (b) is
         * the Tier-1 auto-knob that adapts to slow HRs without any adaptive
         * detector running. */
        uint32_t refr = s.refractory_ms;
        if (s.override_refractory_ms > 0) {
            refr = s.override_refractory_ms;
        } else if (s.refractory_ibi_pct > 0 &&
                   s.last_ibi_ms > 0 && s.last_ibi_ms < 60000u) {
            /* Cap on last_ibi_ms guards the multiply against pathological
             * values from a bad block-end timestamp. 60 s = 1 BPM floor,
             * well below physiology. */
            uint32_t scaled = (s.last_ibi_ms * (uint32_t)s.refractory_ibi_pct) / 100u;
            /* Hard ceiling at 750 ms protects against a single artifact-
             * inflated last_ibi_ms (e.g. 1500–2000 ms after a missed
             * beat) suppressing real beats at typical resting cadence
             * (HR 75 → IBI 800 ms). At 60% × 1500 = 900 ms the next
             * real beat would land inside refractory and be eaten,
             * producing a half-rate stuck pattern. 750 ms admits beats
             * down to 80 bpm-equivalent; below that, dicrotic-notch
             * suppression is slightly weaker but the static refractory
             * floor (ibi_min_ms, default 300) still applies. */
            if (scaled > 750u) scaled = 750u;
            if (scaled > refr) refr = scaled;
        }

        bool refractory_ok = !s.has_last_peak ||
            (s.block_max_ts_ms >= s.last_peak_ts_ms &&
             (s.block_max_ts_ms - s.last_peak_ts_ms) >= refr);

        if (refractory_ok && s.block_max_amp > 0) {
            if (s.has_last_peak && s.block_max_ts_ms >= s.last_peak_ts_ms) {
                s.last_ibi_ms = s.block_max_ts_ms - s.last_peak_ts_ms;
            }
            emit_peak(s.block_max_ts_ms, s.block_max_idx, s.block_max_amp);
            s.last_peak_ts_ms = s.block_max_ts_ms;
            s.has_last_peak = true;
        }
    }
}

void elgendi_set_beta_x1000(uint16_t v)
{
    /* Single-word write — atomic on RV32 with respect to per-sample reads.
     * The threshold formula reads beta_x1000 once per sample inside feed(),
     * which runs on the same task context, so there's no preemption window
     * here in practice. We still take the cb_lock to be explicit. */
    portENTER_CRITICAL(&s.cb_lock);
    s.beta_x1000 = v;
    portEXIT_CRITICAL(&s.cb_lock);
}

void elgendi_set_dynamic_refractory_ms(uint32_t ms)
{
    portENTER_CRITICAL(&s.cb_lock);
    s.override_refractory_ms = ms;
    portEXIT_CRITICAL(&s.cb_lock);
}
