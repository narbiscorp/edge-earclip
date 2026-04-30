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

/* ====== Auto-pair plumbing ======
 *
 * The auto_pair module owns the discovery handshake (broadcast
 * PAIR_DISCOVER, await PAIR_OFFER). transport_espnow exposes the minimal
 * primitives it needs: a peer add/remove pair and a single registered
 * receive handler. Anything more elaborate (dispatch by msg_type, fan-out
 * to multiple consumers) is deferred until we actually need it. */

/* Add an ESP-NOW peer (channel = CONFIG_NARBIS_ESPNOW_CHANNEL, encrypt =
 * false). Used by auto_pair to install the broadcast peer before sending
 * PAIR_DISCOVER. ESP_ERR_ESPNOW_EXIST is treated as success.
 * transport_espnow_init must have run first. */
esp_err_t transport_espnow_add_peer(const uint8_t mac[6]);

/* Remove a previously-added peer. ESP_ERR_ESPNOW_NOT_FOUND is treated as
 * success (idempotent cleanup). */
esp_err_t transport_espnow_remove_peer(const uint8_t mac[6]);

/* Receive handler — invoked from the ESP-NOW Wi-Fi task after CRC +
 * length validation. Implementations must return quickly (no blocking).
 * The pkt pointer is on the caller's stack; copy out anything needed
 * beyond the call. There is at most one registered handler. */
typedef void (*transport_espnow_recv_fn)(const uint8_t src[6],
                                         const narbis_packet_t *pkt,
                                         void *ctx);

/* Register a single receive handler. Pass NULL/NULL to unregister. */
void transport_espnow_register_recv_handler(transport_espnow_recv_fn fn, void *ctx);

#ifdef __cplusplus
}
#endif

#endif /* NARBIS_TRANSPORT_ESPNOW_H */
