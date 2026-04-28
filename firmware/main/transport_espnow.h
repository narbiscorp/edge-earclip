#ifndef NARBIS_TRANSPORT_ESPNOW_H
#define NARBIS_TRANSPORT_ESPNOW_H

#include <stdint.h>

#include "esp_err.h"
#include "sdkconfig.h"

#include "narbis_protocol.h"  /* beat_event_t, narbis_raw_ppg_payload_t */

#ifdef __cplusplus
extern "C" {
#endif

#define TRANSPORT_ESPNOW_DEFAULT_CHANNEL CONFIG_NARBIS_ESPNOW_CHANNEL

/* Bring up Wi-Fi (STA, no association), ESP-NOW, register send callback,
 * resolve the partner MAC (NVS first, Kconfig fallback) and add it as a
 * peer. Must be called BEFORE the BLE controller is started so SW coex
 * registers Wi-Fi first. Idempotent w.r.t. esp_netif_init / event loop. */
esp_err_t transport_espnow_init(void);

esp_err_t transport_espnow_deinit(void);

/* Replace the current ESP-NOW peer and persist the new MAC to NVS so it
 * survives reboot. */
esp_err_t transport_espnow_set_partner(const uint8_t mac[6]);

/* Pack a beat_event_t into a NARBIS_MSG_IBI frame and send. */
esp_err_t transport_espnow_send_beat(const beat_event_t *beat);

/* Send a pre-built raw-PPG batch as a NARBIS_MSG_RAW_PPG frame. The caller
 * fills sample_rate_hz, n_samples (≤ NARBIS_RAW_PPG_MAX_SAMPLES) and the
 * sample array. Stage 05 leaves this unwired in main.c — it exists so
 * Stage 06 only has to add a call site. */
esp_err_t transport_espnow_send_raw_sample(const narbis_raw_ppg_payload_t *batch);

/* Send a NARBIS_MSG_BATTERY frame. */
esp_err_t transport_espnow_send_battery(uint8_t soc_pct, uint16_t mv, uint8_t charging);

/* Read back the partner MAC and the source string ("nvs" or "kconfig").
 * Used by main.c at boot for the MAC log line. The returned string is
 * static and does not need to be freed. Returns ESP_ERR_INVALID_STATE if
 * transport_espnow_init has not run yet. */
esp_err_t transport_espnow_get_partner_info(uint8_t mac[6], const char **source);

#ifdef __cplusplus
}
#endif

#endif /* NARBIS_TRANSPORT_ESPNOW_H */
