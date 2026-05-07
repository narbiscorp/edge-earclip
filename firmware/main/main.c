#include "esp_err.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs_flash.h"

#include "sdkconfig.h"

#include "narbis_protocol.h"
#include "ppg_driver_max3010x.h"

#include "adaptive_detector.h"
#include "app_state.h"
#include "beat_validator.h"
#include "ble_ota.h"
#include "ble_service_battery.h"
#include "ble_service_dis.h"
#include "ble_service_hrs.h"
#include "ble_service_narbis.h"
#include "config_manager.h"
#include "diagnostics.h"
#include "elgendi.h"
#include "power_mgmt.h"
#include "ppg_channel.h"
#include "sleep_button.h"
#include "transport_ble.h"

#ifdef CONFIG_NARBIS_TEST_INJECT
#include "test_inject.h"
#endif

static const char *TAG = "narbis";

static void on_beat(const beat_event_t *e, void *ctx)
{
    (void)ctx;
    /* BPM x10 = 600000 / IBI(ms), with rounding. Guarded against div-by-0. */
    uint16_t bpm_x10 = (e->ibi_ms > 0)
        ? (uint16_t)((600000u + e->ibi_ms / 2u) / e->ibi_ms) : 0;
    ESP_LOGI(TAG,
             "beat ts=%lu ibi=%u prev=%u bpm=%u.%u conf=%u flags=0x%02x amp=%u",
             (unsigned long)e->timestamp_ms, e->ibi_ms, e->prev_ibi_ms,
             bpm_x10 / 10, bpm_x10 % 10, e->confidence_x100, e->flags,
             e->peak_amplitude);

    (void)transport_ble_send_beat(e);
}

static void boot_log_macs(void)
{
    uint8_t ble_mac[6] = {0};
    (void)esp_read_mac(ble_mac, ESP_MAC_BT);
    ESP_LOGI(TAG, "ble MAC %02x:%02x:%02x:%02x:%02x:%02x",
             ble_mac[0], ble_mac[1], ble_mac[2],
             ble_mac[3], ble_mac[4], ble_mac[5]);
}

/* Hand a candidate peak to the adaptive detector first. In FIXED mode it
 * passes through immediately; in ADAPTIVE mode it queues for HALF samples
 * of look-ahead before deciding accept/reject. Accepted peaks come back
 * via on_accepted_peak below. */
static void on_peak(const elgendi_peak_t *p, void *ctx)
{
    (void)ctx;
    adaptive_detector_propose_peak(p);

    /* Diagnostics records every CANDIDATE (pre-NCC/Kalman) so the dashboard
     * can show what elgendi proposed vs what the adaptive layer accepted. */
    struct __attribute__((packed)) {
        uint32_t timestamp_ms;
        int32_t  amplitude;
    } rec = { .timestamp_ms = p->timestamp_ms, .amplitude = p->amplitude };
    diagnostics_push(NARBIS_DIAG_STREAM_PEAK_CAND, &rec, sizeof(rec));
}

static void on_accepted_peak(const elgendi_peak_t *p, void *ctx)
{
    (void)ctx;
    beat_validator_feed(p);

    /* Push a detector-stats snapshot for the dashboard's "Detector (Adaptive)"
     * sidebar tiles. One record per accepted beat ≈ 1 Hz — well under the
     * diagnostics drain budget. The mask gate inside diagnostics_push makes
     * this a single load + branch when the stream is off. */
    adaptive_detector_stats_t st;
    adaptive_detector_get_stats(&st);
    struct __attribute__((packed)) {
        uint32_t timestamp_ms;
        int16_t  ncc_x1000;
        uint16_t alpha_x1000;
        uint16_t kalman_x_ms;
        uint16_t kalman_r_ms2;
        uint32_t beats_learned;
        uint16_t ncc_rejects;
        uint16_t kalman_rejects;
        uint16_t watchdog_resets;
        uint8_t  beats_in_template;
        uint8_t  mode;
    } rec = {
        .timestamp_ms      = p->timestamp_ms,
        .ncc_x1000         = st.ncc_x1000,
        .alpha_x1000       = st.alpha_x1000,
        .kalman_x_ms       = st.kalman_x_ms,
        .kalman_r_ms2      = st.kalman_r_ms2,
        .beats_learned     = st.beats_learned,
        .ncc_rejects       = (uint16_t)(st.ncc_rejects & 0xFFFFu),
        .kalman_rejects    = (uint16_t)(st.kalman_rejects & 0xFFFFu),
        .watchdog_resets   = (uint16_t)(st.watchdog_resets & 0xFFFFu),
        .beats_in_template = st.beats_in_template,
        .mode              = st.mode,
    };
    diagnostics_push(NARBIS_DIAG_STREAM_DETECTOR_STATS, &rec, sizeof(rec));
}

static void on_processed(const ppg_processed_sample_t *s, void *ctx)
{
    (void)ctx;
    elgendi_feed(s);

    /* Diagnostics: pre-bandpass (post DC-removal/AGC). */
    struct __attribute__((packed)) {
        uint32_t timestamp_ms;
        int32_t  ac;
        uint32_t dc;
    } rec = { .timestamp_ms = s->timestamp_ms, .ac = s->ac, .dc = s->dc_baseline };
    diagnostics_push(NARBIS_DIAG_STREAM_PRE_FILTER, &rec, sizeof(rec));
}

static void on_filtered(const elgendi_filtered_sample_t *f, void *ctx)
{
    (void)ctx;
    /* Adaptive detector needs every bandpass sample for its ring buffer
     * and per-sample watchdog tick. Cheap (one int32 store + a couple of
     * compares) when no candidate is pending. */
    adaptive_detector_feed_sample(f->timestamp_ms, f->filtered);

    /* Diagnostics: post-bandpass (Elgendi filter output). Drives the
     * dashboard's "Filtered signal + peaks" chart. */
    struct __attribute__((packed)) {
        uint32_t timestamp_ms;
        int32_t  filtered;
    } rec = { .timestamp_ms = f->timestamp_ms, .filtered = f->filtered };
    diagnostics_push(NARBIS_DIAG_STREAM_POST_FILTER, &rec, sizeof(rec));
}

#ifndef CONFIG_NARBIS_TEST_INJECT
static void on_ppg_sample(const ppg_sample_t *sample, void *user_ctx)
{
    (void)user_ctx;
    ppg_channel_feed(sample);

    const narbis_runtime_config_t *cfg = ble_service_narbis_config();
    (void)transport_ble_send_raw_sample(sample, cfg->sample_rate_hz, cfg->data_format);
}
#endif

static esp_err_t nvs_init_with_recovery(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    return err;
}

void app_main(void)
{
    ESP_ERROR_CHECK(nvs_init_with_recovery());

    ESP_LOGI(TAG, "Narbis earclip booting v0.1.0, protocol version %d",
             NARBIS_PROTOCOL_VERSION);

    /* Load runtime config first so every later module that reads it sees
     * the persisted values rather than zero. config_apply_initial() runs
     * once everything is up. */
    ESP_ERROR_CHECK(config_manager_init());
    ESP_ERROR_CHECK(power_mgmt_init());

    boot_log_macs();

#if CONFIG_NARBIS_DISABLE_BLE
    ESP_LOGW(TAG, "BLE init SKIPPED (CONFIG_NARBIS_DISABLE_BLE=y) — power-draw bisection build");
#else
    ESP_ERROR_CHECK(transport_ble_init());
    ESP_ERROR_CHECK(ble_service_dis_init());
    ESP_ERROR_CHECK(ble_service_battery_init());
    ESP_ERROR_CHECK(ble_service_hrs_init());
    ESP_ERROR_CHECK(ble_service_narbis_init());
    ESP_ERROR_CHECK(ble_ota_init());
    /* If we're running from a freshly-OTA'd partition that hasn't been
     * marked valid yet, this kicks off a one-shot task that waits for
     * the dashboard to reconnect and then commits the image. Times out
     * silently (the bootloader rolls back on the next reset) when the
     * running partition is the factory image or already validated. */
    (void)ble_ota_validity_selftest_kickoff();
#endif
    ESP_ERROR_CHECK(diagnostics_init());

    ESP_ERROR_CHECK(ppg_channel_init());
    ESP_ERROR_CHECK(elgendi_init());
    ESP_ERROR_CHECK(adaptive_detector_init());
    ESP_ERROR_CHECK(beat_validator_init());
    ESP_ERROR_CHECK(ppg_channel_register_output_cb(on_processed, NULL));
    ESP_ERROR_CHECK(elgendi_register_peak_cb(on_peak, NULL));
    ESP_ERROR_CHECK(elgendi_register_filtered_cb(on_filtered, NULL));
    ESP_ERROR_CHECK(adaptive_detector_register_peak_cb(on_accepted_peak, NULL));
    ESP_ERROR_CHECK(beat_validator_register_event_cb(on_beat, NULL));

#ifdef CONFIG_NARBIS_TEST_INJECT
    ESP_LOGW(TAG, "CONFIG_NARBIS_TEST_INJECT enabled — using synthetic source");
    ESP_ERROR_CHECK(test_inject_start());
#else
    ppg_driver_config_t ppg_cfg = ppg_driver_default_config();
    ESP_ERROR_CHECK(ppg_driver_init(&ppg_cfg));
    ESP_ERROR_CHECK(ppg_driver_register_sample_callback(on_ppg_sample, NULL));
#endif

    /* Push the loaded/default config into every module now that they're up. */
    ESP_ERROR_CHECK(config_apply_initial());

    /* State machine starts in IDLE, then resumes the persisted last mode
     * (or derives one from the loaded config on first boot). */
    ESP_ERROR_CHECK(app_state_init());
    (void)app_state_resume_last_mode();

    /* User-initiated sleep: hold the BOOT button (GPIO9) for 2 s to
     * enter deep sleep. Same button wakes (chip resets out of deep
     * sleep, app_main runs again). */
    ESP_ERROR_CHECK(sleep_button_init());

    while (1) {
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}
