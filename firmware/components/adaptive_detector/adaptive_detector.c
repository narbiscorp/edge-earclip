/*
 * adaptive_detector.c — port of dashboard v13.27 learning beat detector.
 *
 * Numerics: per-sample bandpass ring + watchdog tick are int-only and run
 * on every sample in the channel-processing task (no IRQ context). The
 * NCC + z-score + Kalman path runs at ≤1 Hz (only when the elgendi block
 * detector emits a candidate, then HALF samples later). That part uses
 * single-precision float — the ESP32-C6 FPU is fine here, and CLAUDE.md's
 * float ban applies to the per-sample hot path, not these candidate-rate
 * computations.
 *
 * Memory: ~5 KB static
 *   bp_ring[256]                     1 KB
 *   recent_beats[16][80] (Float32)   5 KB  (cap = ADAPT_RECENT_MAX × ADAPT_WINDOW_MAX)
 *   template[80]                    320 B
 *   misc state                      <100 B
 */

#include "adaptive_detector.h"

#include <math.h>
#include <string.h>
#include <stdbool.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/portmacro.h"

static const char *TAG = "adaptive_detector";

/* Static buffer caps. Validation in config_manager rejects template_window_ms
 * out of range; apply_config also clamps window_samples to ADAPT_WINDOW_MAX. */
#define ADAPT_WINDOW_MAX     80
#define ADAPT_BP_RING_LEN    256
#define ADAPT_BP_RING_MASK   (ADAPT_BP_RING_LEN - 1)
#define ADAPT_RECENT_MAX     16

#define ADAPT_REJECT_RING_LEN 16  /* must match bit width of reject_ring (uint16_t) */

#define ADAPT_R_MIN_MS2       100.0f
#define ADAPT_R_MAX_MS2       10000.0f
#define ADAPT_R_BUMP_FACTOR   1.5f
#define ADAPT_R_DECAY_FACTOR  0.95f
#define ADAPT_R_HIGH_RATE_PCT 25
#define ADAPT_R_LOW_RATE_PCT  5

/* α self-tuning step sizes ×1000 (matches dashboard v13.27). */
#define ADAPT_ALPHA_STEP_NCC_REJECT   1.0f   /* +0.001 */
#define ADAPT_ALPHA_STEP_BLOCK_SHORT  0.5f   /* +0.0005 — currently unused; elgendi handles it */
#define ADAPT_ALPHA_STEP_ACCEPT       0.5f   /* -0.0005 toward floor */
#define ADAPT_ALPHA_STEP_STUCK        5.0f   /* -0.005 on stuck silence */

#define ADAPT_STUCK_RELAX_MS  2500u  /* light α relax — matches dashboard line 952 */

typedef struct {
    bool     inited;

    /* Config snapshot (reapplied via apply_config). */
    uint8_t  mode;
    uint8_t  template_max_beats;
    uint8_t  template_warmup_beats;
    uint8_t  kalman_warmup_beats;
    uint8_t  kalman_sigma_x10;
    uint8_t  watchdog_max_consec_rejects;
    uint8_t  refractory_ibi_pct;
    uint16_t template_window_samples;
    uint16_t template_half_samples;
    uint16_t ncc_min_x1000;
    uint16_t ncc_learn_min_x1000;
    uint16_t kalman_q_ms2;
    uint16_t kalman_r_baseline_ms2;
    uint16_t watchdog_silence_ms;
    uint16_t alpha_min_x1000;
    uint16_t alpha_max_x1000;
    uint16_t ibi_min_ms;
    uint16_t ibi_max_ms;
    uint16_t sample_rate_hz;

    /* Bandpass ring (filtered samples, post-Elgendi BP). bp_head_idx is the
     * absolute sample index of the NEXT slot to write — i.e. the total number
     * of samples seen since boot. A sample at absolute idx K is in the ring
     * iff (bp_head_idx - K) <= bp_filled. */
    int32_t  bp_ring[ADAPT_BP_RING_LEN];
    uint32_t bp_head_idx;
    uint32_t bp_filled;
    uint32_t last_sample_ts_ms;

    /* Pending candidate (waiting for HALF samples post-peak). */
    bool     have_pending;
    uint32_t pending_peak_abs_idx;
    uint32_t pending_peak_ts_ms;
    int32_t  pending_peak_amp;

    /* Template (z-scored mean of recent_beats). */
    float    template[ADAPT_WINDOW_MAX];
    bool     have_template;
    float    recent_beats[ADAPT_RECENT_MAX][ADAPT_WINDOW_MAX];
    uint8_t  recent_head;
    uint8_t  recent_filled;
    uint32_t beats_learned;

    /* Kalman. R is adaptive (Layer E Tier 1 #1). */
    float    kal_x;
    float    kal_P;
    float    kal_R;
    bool     kal_initialized;
    uint32_t kal_beats_seen;

    /* Adaptive-R rolling window (1 = rejected, 0 = accepted), bit 0 = newest. */
    uint16_t reject_ring;
    uint8_t  reject_filled;

    /* Watchdog. */
    uint8_t  consecutive_rejects;
    uint8_t  lockon_count;        /* consecutive 2× lock-on Kalman rejects */
    uint32_t last_accepted_ts_ms;

    /* α (= elgendi beta). Internally float for the dashboard's 0.0005 steps. */
    float    alpha_x1000;

    /* Stats. */
    int16_t  last_ncc_x1000;
    uint32_t ncc_rejects;
    uint32_t kalman_rejects;
    uint32_t watchdog_resets;

    /* Output cb. */
    portMUX_TYPE                cb_lock;
    adaptive_detector_peak_cb_t out_cb;
    void                       *out_ctx;
} adaptive_state_t;

static adaptive_state_t s = {
    .cb_lock = portMUX_INITIALIZER_UNLOCKED,
};

/* elgendi_set_beta_x1000 + elgendi_set_dynamic_refractory_ms are declared in
 * elgendi.h (already included above) and let this module write back two
 * pieces of feedback into the rule-based detector: α self-tuning, and
 * Kalman-driven refractory override. The dependency stays one-way: we
 * require elgendi in CMakeLists; elgendi has no knowledge of this module. */

/* ============================================================================
 * Helpers
 * ========================================================================= */

static uint16_t ms_to_samples(uint32_t ms, uint16_t fs_hz, uint16_t cap)
{
    uint32_t n = (ms * fs_hz + 500u) / 1000u;
    if (n < 4)   n = 4;     /* ≥4 samples or NCC is meaningless */
    if (n > cap) n = cap;
    /* Force even so HALF = WINDOW/2 splits cleanly. */
    n &= ~(uint32_t)1u;
    if (n < 4) n = 4;
    return (uint16_t)n;
}

static void load_defaults(void)
{
    s.mode                     = NARBIS_DETECTOR_FIXED;
    s.template_max_beats       = 10;
    s.template_warmup_beats    = 4;
    s.kalman_warmup_beats      = 5;
    s.kalman_sigma_x10         = 30;
    s.watchdog_max_consec_rejects = 5;
    s.refractory_ibi_pct       = 60;
    s.template_window_samples  = 40;
    s.template_half_samples    = 20;
    s.ncc_min_x1000            = 500;
    s.ncc_learn_min_x1000      = 750;
    s.kalman_q_ms2             = 400;
    s.kalman_r_baseline_ms2    = 2500;
    s.watchdog_silence_ms      = 4000;
    s.alpha_min_x1000          = 10;
    s.alpha_max_x1000          = 500;
    s.ibi_min_ms               = 300;
    s.ibi_max_ms               = 2000;
    s.sample_rate_hz           = 200;
    s.alpha_x1000              = 20.0f;
}

static void reset_learned_state(void)
{
    /* Match dashboard resetDetectorLearnedState() at line 738. Critical:
     * also clear last_accepted_ts_ms so the next beat doesn't trip a giant
     * IBI rejection (dashboard v13.1 fix at line 743 — do not regress). */
    s.have_pending           = false;
    s.have_template          = false;
    memset(s.template, 0, sizeof(s.template));
    memset(s.recent_beats, 0, sizeof(s.recent_beats));
    s.recent_head            = 0;
    s.recent_filled          = 0;
    s.beats_learned          = 0;
    s.consecutive_rejects    = 0;
    s.lockon_count           = 0;
    s.last_accepted_ts_ms    = 0;
    s.kal_x                  = 900.0f;
    s.kal_P                  = 10000.0f;
    s.kal_R                  = (float)s.kalman_r_baseline_ms2;
    s.kal_initialized        = false;
    s.kal_beats_seen         = 0;
    s.reject_ring            = 0;
    s.reject_filled          = 0;
    s.last_ncc_x1000         = 0;
    s.alpha_x1000            = 20.0f;  /* back to Elgendi default */
    if (s.alpha_x1000 < (float)s.alpha_min_x1000) s.alpha_x1000 = (float)s.alpha_min_x1000;
    if (s.alpha_x1000 > (float)s.alpha_max_x1000) s.alpha_x1000 = (float)s.alpha_max_x1000;
    elgendi_set_beta_x1000((uint16_t)lrintf(s.alpha_x1000));
    elgendi_set_dynamic_refractory_ms(0);  /* fall back to ibi_min_ms */
}

static float zscore_normalize(float *arr, size_t n)
{
    double sum = 0.0;
    for (size_t i = 0; i < n; i++) sum += arr[i];
    float mean = (float)(sum / (double)n);
    double sq = 0.0;
    for (size_t i = 0; i < n; i++) {
        arr[i] -= mean;
        sq += (double)arr[i] * (double)arr[i];
    }
    float std = sqrtf((float)(sq / (double)n));
    if (std > 1e-6f) {
        float inv = 1.0f / std;
        for (size_t i = 0; i < n; i++) arr[i] *= inv;
    }
    return std;
}

static float ncc_floats(const float *a, const float *b, size_t n)
{
    /* Both inputs are z-scored (mean 0, std 1) so NCC = (1/N) Σ aᵢbᵢ. */
    double s_acc = 0.0;
    for (size_t i = 0; i < n; i++) s_acc += (double)a[i] * (double)b[i];
    return (float)(s_acc / (double)n);
}

static void rebuild_template(void)
{
    if (s.recent_filled == 0) {
        s.have_template = false;
        return;
    }
    size_t n = s.template_window_samples;
    for (size_t i = 0; i < n; i++) s.template[i] = 0.0f;
    for (uint8_t b = 0; b < s.recent_filled; b++) {
        for (size_t i = 0; i < n; i++) s.template[i] += s.recent_beats[b][i];
    }
    float inv = 1.0f / (float)s.recent_filled;
    for (size_t i = 0; i < n; i++) s.template[i] *= inv;
    (void)zscore_normalize(s.template, n);
    s.have_template = true;
}

/* Push reject/accept outcome into the 16-beat ring. Bit 0 = newest. */
static void reject_ring_push(bool rejected)
{
    s.reject_ring = (uint16_t)((s.reject_ring << 1) | (rejected ? 1u : 0u));
    if (s.reject_filled < ADAPT_REJECT_RING_LEN) s.reject_filled++;
}

static uint8_t reject_ring_count(void)
{
    /* popcount on uint16_t. */
    uint16_t v = s.reject_ring;
    if (s.reject_filled < ADAPT_REJECT_RING_LEN) {
        /* Mask to only the bits we've actually filled. */
        v &= (uint16_t)((1u << s.reject_filled) - 1u);
    }
    uint8_t c = 0;
    while (v) { c += (uint8_t)(v & 1u); v >>= 1; }
    return c;
}

static void update_kalman_R_adaptive(void)
{
    if (s.reject_filled < ADAPT_REJECT_RING_LEN) return;  /* not enough history */
    uint8_t rejects = reject_ring_count();
    uint8_t pct = (uint8_t)((rejects * 100u) / ADAPT_REJECT_RING_LEN);
    if (pct > ADAPT_R_HIGH_RATE_PCT) {
        s.kal_R *= ADAPT_R_BUMP_FACTOR;
        if (s.kal_R > ADAPT_R_MAX_MS2) s.kal_R = ADAPT_R_MAX_MS2;
    } else if (pct < ADAPT_R_LOW_RATE_PCT) {
        float baseline = (float)s.kalman_r_baseline_ms2;
        s.kal_R *= ADAPT_R_DECAY_FACTOR;
        if (s.kal_R < baseline) s.kal_R = baseline;
    }
}

static bool kalman_step(float observed_ibi_ms)
{
    s.kal_beats_seen++;
    float xPred = s.kal_x;
    float PPred = s.kal_P + (float)s.kalman_q_ms2;
    float y = observed_ibi_ms - xPred;
    float S = PPred + s.kal_R;

    if (s.kal_initialized && s.kal_beats_seen > s.kalman_warmup_beats) {
        float sigma = sqrtf(S);
        float gate = ((float)s.kalman_sigma_x10 / 10.0f) * sigma;
        if (fabsf(y) > gate) {
            s.kalman_rejects++;
            /* "Every-other-beat" lock-on detection.
             *
             * Failure mode: an artifact bumped kal_x to ~2× the true IBI.
             * Real beats now arrive with observed ≈ kal_x / 2. The gate
             * rejects them; the gap-spanning IBI for the NEXT beat is
             * ≈ kal_x and gets accepted, so consecutive_rejects keeps
             * resetting and the existing rejects/silence watchdogs never
             * trip. Detect it directly: if predicted is 1.7×–2.3× the
             * observed for two rejects in a row, force reset. Two-in-a-row
             * is what distinguishes a sustained lock-on from a single
             * ectopic beat (which has the same ratio but is followed by
             * a compensatory long IBI, not another short one). The next
             * accepted beat will have last_accepted_ts_ms=0 → no IBI
             * computed → reseeds Kalman from scratch with the true rate. */
            if (observed_ibi_ms > 0.0f) {
                float ratio = xPred / observed_ibi_ms;
                if (ratio > 1.7f && ratio < 2.3f) {
                    s.lockon_count++;
                    if (s.lockon_count >= 2) {
                        ESP_LOGW(TAG,
                                 "kalman: 2× lock-on confirmed (xPred=%.0f, obs=%.0f) → reset",
                                 (double)xPred, (double)observed_ibi_ms);
                        s.watchdog_resets++;
                        reset_learned_state();
                    }
                } else {
                    s.lockon_count = 0;
                }
            }
            return false;
        }
    }
    float K = PPred / S;
    s.kal_x = xPred + K * y;
    s.kal_P = (1.0f - K) * PPred;
    s.kal_initialized = true;
    s.lockon_count = 0;  /* clear on any successful Kalman update */
    return true;
}

static void publish_alpha(void)
{
    if (s.alpha_x1000 < (float)s.alpha_min_x1000) s.alpha_x1000 = (float)s.alpha_min_x1000;
    if (s.alpha_x1000 > (float)s.alpha_max_x1000) s.alpha_x1000 = (float)s.alpha_max_x1000;
    elgendi_set_beta_x1000((uint16_t)lrintf(s.alpha_x1000));
}

static void publish_dynamic_refractory(void)
{
    /* Override elgendi's refractory only when ADAPTIVE mode is on AND we
     * have a Kalman-tracked IBI. Otherwise pass 0 so elgendi falls back to
     * its local refractory_ibi_pct × last_IBI logic — which is already
     * correct for the FIXED-mode case. */
    if (s.mode != NARBIS_DETECTOR_ADAPTIVE || !s.kal_initialized ||
        s.refractory_ibi_pct == 0) {
        elgendi_set_dynamic_refractory_ms(0);
        return;
    }
    uint32_t scaled = (uint32_t)((s.kal_x * (float)s.refractory_ibi_pct) / 100.0f);
    if (scaled < s.ibi_min_ms) scaled = s.ibi_min_ms;
    elgendi_set_dynamic_refractory_ms(scaled);
}

/* Extract the WINDOW samples around the pending peak from the bp_ring. Returns
 * false if the window has aged out of the ring (shouldn't happen given the
 * watchdog, but defensive). */
static bool extract_window(float *out_window)
{
    uint32_t half = s.template_half_samples;
    uint32_t win = s.template_window_samples;
    /* Window covers absolute indices [peak - half, peak - half + win). */
    if (s.pending_peak_abs_idx < half) return false;
    uint32_t win_start = s.pending_peak_abs_idx - half;

    /* Verify window is still in the ring. */
    if (s.bp_head_idx < win_start + win) return false;
    if (s.bp_head_idx - win_start > s.bp_filled) return false;

    for (uint32_t i = 0; i < win; i++) {
        uint32_t abs = win_start + i;
        out_window[i] = (float)s.bp_ring[abs & ADAPT_BP_RING_MASK];
    }
    return true;
}

static void emit_accepted_peak(void)
{
    elgendi_peak_t evt = {
        .timestamp_ms = s.pending_peak_ts_ms,
        .sample_index = s.pending_peak_abs_idx,
        .amplitude    = s.pending_peak_amp,
    };
    adaptive_detector_peak_cb_t cb;
    void *ctx;
    portENTER_CRITICAL(&s.cb_lock);
    cb = s.out_cb;
    ctx = s.out_ctx;
    portEXIT_CRITICAL(&s.cb_lock);
    if (cb != NULL) cb(&evt, ctx);
}

static void process_pending(void)
{
    float window[ADAPT_WINDOW_MAX];
    if (!extract_window(window)) {
        /* Ring lost the data — drop the candidate. */
        s.have_pending = false;
        return;
    }

    size_t n = s.template_window_samples;
    float win_std = zscore_normalize(window, n);

    bool accept = true;
    float ncc_v = 0.0f;
    bool ncc_active = (s.have_template && s.beats_learned >= s.template_warmup_beats);

    if (ncc_active) {
        ncc_v = ncc_floats(window, s.template, n);
        s.last_ncc_x1000 = (int16_t)lrintf(ncc_v * 1000.0f);
        float ncc_min = (float)s.ncc_min_x1000 / 1000.0f;
        if (ncc_v < ncc_min || win_std < 1.0f) {
            accept = false;
            s.ncc_rejects++;
            s.consecutive_rejects++;
            s.alpha_x1000 += ADAPT_ALPHA_STEP_NCC_REJECT;
            publish_alpha();
        }
    } else if (s.have_template) {
        /* Pre-warmup: still measure NCC for telemetry, but don't gate. */
        ncc_v = ncc_floats(window, s.template, n);
        s.last_ncc_x1000 = (int16_t)lrintf(ncc_v * 1000.0f);
    }

    /* Kalman gate on observed IBI. */
    if (accept && s.last_accepted_ts_ms > 0) {
        uint32_t observed = (s.pending_peak_ts_ms >= s.last_accepted_ts_ms)
                                ? (s.pending_peak_ts_ms - s.last_accepted_ts_ms) : 0;
        if (observed < s.ibi_min_ms || observed > s.ibi_max_ms) {
            accept = false;
            s.consecutive_rejects++;
        } else {
            if (!kalman_step((float)observed)) {
                accept = false;
                s.consecutive_rejects++;
            }
        }
    }

    if (accept) {
        /* Add to template if quality is high (or still in template warmup). */
        bool in_warmup = (s.beats_learned < s.template_warmup_beats);
        bool ncc_good = (!ncc_active) ||
                        (ncc_v * 1000.0f >= (float)s.ncc_learn_min_x1000);
        if (in_warmup || ncc_good) {
            uint8_t slot = s.recent_head;
            for (size_t i = 0; i < n; i++) s.recent_beats[slot][i] = window[i];
            s.recent_head = (uint8_t)((s.recent_head + 1) % s.template_max_beats);
            if (s.recent_filled < s.template_max_beats) s.recent_filled++;
            rebuild_template();
        }
        s.beats_learned++;
        s.consecutive_rejects = 0;
        reject_ring_push(false);
        update_kalman_R_adaptive();

        /* Decay α toward the Elgendi default (matches dashboard line 919). */
        if (s.alpha_x1000 > 20.0f) {
            s.alpha_x1000 -= ADAPT_ALPHA_STEP_ACCEPT;
            if (s.alpha_x1000 < 20.0f) s.alpha_x1000 = 20.0f;
            publish_alpha();
        }

        s.last_accepted_ts_ms = s.pending_peak_ts_ms;
        publish_dynamic_refractory();
        emit_accepted_peak();
    } else {
        reject_ring_push(true);
        update_kalman_R_adaptive();
        if (s.consecutive_rejects >= s.watchdog_max_consec_rejects) {
            ESP_LOGW(TAG, "watchdog: %u consec rejects → reset", s.consecutive_rejects);
            s.watchdog_resets++;
            reset_learned_state();
        }
    }

    s.have_pending = false;
}

static void watchdog_tick(uint32_t now_ms)
{
    if (s.last_accepted_ts_ms == 0) return;
    if (now_ms < s.last_accepted_ts_ms) return;
    uint32_t gap = now_ms - s.last_accepted_ts_ms;
    if (gap > s.watchdog_silence_ms) {
        ESP_LOGW(TAG, "watchdog: %u ms silence → reset", (unsigned)gap);
        s.watchdog_resets++;
        reset_learned_state();
    } else if (gap > ADAPT_STUCK_RELAX_MS) {
        /* Light relaxation — let α decay so a noise-driven climb can recover. */
        s.alpha_x1000 -= ADAPT_ALPHA_STEP_STUCK;
        publish_alpha();
    }
}

/* ============================================================================
 * Public API
 * ========================================================================= */

esp_err_t adaptive_detector_init(void)
{
    if (s.inited) return ESP_ERR_INVALID_STATE;
    portMUX_TYPE saved_lock = s.cb_lock;
    adaptive_detector_peak_cb_t saved_cb = s.out_cb;
    void *saved_ctx = s.out_ctx;
    memset(&s, 0, sizeof(s));
    s.cb_lock = saved_lock;
    s.out_cb  = saved_cb;
    s.out_ctx = saved_ctx;
    load_defaults();
    reset_learned_state();
    s.inited = true;
    ESP_LOGI(TAG, "init: mode=FIXED (transparent passthrough)");
    return ESP_OK;
}

esp_err_t adaptive_detector_deinit(void)
{
    s.inited = false;
    portENTER_CRITICAL(&s.cb_lock);
    s.out_cb = NULL;
    s.out_ctx = NULL;
    portEXIT_CRITICAL(&s.cb_lock);
    return ESP_OK;
}

esp_err_t adaptive_detector_apply_config(const narbis_runtime_config_t *cfg)
{
    if (!s.inited) return ESP_ERR_INVALID_STATE;
    if (cfg == NULL) return ESP_ERR_INVALID_ARG;

    bool mode_changed = (s.mode != cfg->detector_mode);

    /* Compute the new window size first so we can decide whether the change
     * actually invalidates the learned template. */
    uint16_t new_sample_rate_hz = (cfg->sample_rate_hz > 0) ? cfg->sample_rate_hz : 200;
    uint16_t new_window_samples = ms_to_samples(cfg->template_window_ms, new_sample_rate_hz,
                                                ADAPT_WINDOW_MAX);
    bool window_changed = (new_window_samples != s.template_window_samples) ||
                          (new_sample_rate_hz != s.sample_rate_hz);

    s.mode                        = cfg->detector_mode;
    s.template_max_beats          = cfg->template_max_beats;
    if (s.template_max_beats == 0 || s.template_max_beats > ADAPT_RECENT_MAX) {
        s.template_max_beats = ADAPT_RECENT_MAX;
    }
    s.template_warmup_beats       = cfg->template_warmup_beats;
    s.kalman_warmup_beats         = cfg->kalman_warmup_beats;
    s.kalman_sigma_x10            = cfg->kalman_sigma_x10;
    s.watchdog_max_consec_rejects = cfg->watchdog_max_consec_rejects;
    s.refractory_ibi_pct          = cfg->refractory_ibi_pct;
    s.ncc_min_x1000               = cfg->ncc_min_x1000;
    s.ncc_learn_min_x1000         = cfg->ncc_learn_min_x1000;
    s.kalman_q_ms2                = cfg->kalman_q_ms2;
    s.kalman_r_baseline_ms2       = cfg->kalman_r_ms2;
    s.watchdog_silence_ms         = cfg->watchdog_silence_ms;
    s.alpha_min_x1000             = cfg->alpha_min_x1000;
    s.alpha_max_x1000             = cfg->alpha_max_x1000;
    s.ibi_min_ms                  = (cfg->ibi_min_ms > 0) ? cfg->ibi_min_ms : 300;
    s.ibi_max_ms                  = (cfg->ibi_max_ms > s.ibi_min_ms) ? cfg->ibi_max_ms : 2000;
    s.sample_rate_hz              = new_sample_rate_hz;
    s.template_window_samples     = new_window_samples;
    s.template_half_samples       = (uint16_t)(s.template_window_samples / 2u);

    /* Reset learned state ONLY when the structural shape of the template
     * changes (window-size or sample-rate or detector-mode). Threshold
     * tweaks (NCC/Kalman/α/watchdog values) preserve the learned template
     * and Kalman state — otherwise touching any slider would force a
     * 4-beat re-learn and that's how a user accidentally papers over
     * stuck-state bugs. */
    if (mode_changed || window_changed) {
        reset_learned_state();
    }
    publish_dynamic_refractory();

    if (mode_changed) {
        ESP_LOGI(TAG, "mode → %s (window=%u samples, half=%u)",
                 (s.mode == NARBIS_DETECTOR_ADAPTIVE) ? "ADAPTIVE" : "FIXED",
                 s.template_window_samples, s.template_half_samples);
    }
    return ESP_OK;
}

esp_err_t adaptive_detector_register_peak_cb(adaptive_detector_peak_cb_t cb, void *ctx)
{
    portENTER_CRITICAL(&s.cb_lock);
    s.out_cb = cb;
    s.out_ctx = ctx;
    portEXIT_CRITICAL(&s.cb_lock);
    return ESP_OK;
}

void adaptive_detector_feed_sample(uint32_t timestamp_ms, int32_t filtered)
{
    if (!s.inited) return;

    /* Always maintain the bandpass ring — even in FIXED mode it costs almost
     * nothing and lets a runtime mode switch kick in cleanly. */
    s.bp_ring[s.bp_head_idx & ADAPT_BP_RING_MASK] = filtered;
    s.bp_head_idx++;
    if (s.bp_filled < ADAPT_BP_RING_LEN) s.bp_filled++;
    s.last_sample_ts_ms = timestamp_ms;

    if (s.mode != NARBIS_DETECTOR_ADAPTIVE) return;

    /* Pending candidate ready for evaluation? */
    if (s.have_pending) {
        /* bp_head_idx is the absolute idx of the NEXT slot. The most recent
         * sample we just stored has absolute idx (bp_head_idx - 1). */
        uint32_t newest_abs = s.bp_head_idx - 1u;
        if (newest_abs >= s.pending_peak_abs_idx + s.template_half_samples) {
            process_pending();
        }
    }

    watchdog_tick(timestamp_ms);
}

void adaptive_detector_propose_peak(const elgendi_peak_t *p)
{
    if (!s.inited || p == NULL) return;

    if (s.mode != NARBIS_DETECTOR_ADAPTIVE) {
        /* FIXED mode: transparent passthrough. */
        adaptive_detector_peak_cb_t cb;
        void *ctx;
        portENTER_CRITICAL(&s.cb_lock);
        cb = s.out_cb;
        ctx = s.out_ctx;
        portEXIT_CRITICAL(&s.cb_lock);
        if (cb != NULL) cb(p, ctx);
        return;
    }

    /* ADAPTIVE mode: queue. If a previous candidate is somehow still pending,
     * drop it — the elgendi block detector won't propose a second peak before
     * the first one's refractory expires anyway. */
    s.have_pending          = true;
    s.pending_peak_abs_idx  = p->sample_index;
    s.pending_peak_ts_ms    = p->timestamp_ms;
    s.pending_peak_amp      = p->amplitude;
}

void adaptive_detector_get_stats(adaptive_detector_stats_t *out)
{
    if (out == NULL) return;
    /* Lock-free single-word reads; tearing on uint32 stats is acceptable for
     * UI display. */
    out->beats_learned     = s.beats_learned;
    out->ncc_rejects       = s.ncc_rejects;
    out->kalman_rejects    = s.kalman_rejects;
    out->watchdog_resets   = s.watchdog_resets;
    out->ncc_x1000         = s.last_ncc_x1000;
    out->alpha_x1000       = (uint16_t)lrintf(s.alpha_x1000);
    out->kalman_x_ms       = (uint16_t)lrintf(s.kal_x);
    out->kalman_r_ms2      = (uint16_t)((s.kal_R > 65535.0f) ? 65535.0f : s.kal_R);
    out->beats_in_template = s.recent_filled;
    out->mode              = s.mode;
}

void adaptive_detector_reset(void)
{
    reset_learned_state();
    publish_dynamic_refractory();
}
