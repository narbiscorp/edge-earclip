/*
 * narbis_esp_now_rx.h — ESP-NOW receiver for the Narbis earclip, intended
 * to live in the Edge glasses firmware repo as a drop-in component.
 *
 * Wire format, NVS layout, and Kconfig fallback names are inherited from
 * the earclip side (see narbis_protocol.h). Do not redefine those here.
 *
 * Threading:
 *   - The ESP-NOW receive callback runs in a short Wi-Fi context. We copy
 *     the frame into a queue and return immediately. A worker task pulls
 *     from the queue, deserializes, and invokes the user callback.
 *   - The user beat callback therefore runs in the worker task, not in
 *     ISR context. It is allowed to block briefly (e.g. xQueueSend to the
 *     existing IBI processing queue) but should not do long work.
 */

#ifndef NARBIS_ESP_NOW_RX_H
#define NARBIS_ESP_NOW_RX_H

#include <stdint.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Beat event handed to the user callback. Mirrors the wire IBI payload
 * plus enough header context for sequence-gap and latency analysis. */
typedef struct {
    uint16_t ibi_ms;            /* inter-beat interval in milliseconds */
    uint8_t  confidence_x100;   /* 0–100 */
    uint8_t  flags;             /* NARBIS_BEAT_FLAG_* bitmask */
    uint16_t seq_num;           /* earclip-side seq for this msg_type */
    uint32_t timestamp_ms;      /* earclip-local time at the beat */
} narbis_beat_event_t;

typedef void (*narbis_beat_cb_t)(const narbis_beat_event_t *evt, void *ctx);

typedef struct {
    uint32_t rx_total;          /* frames received by the ESP-NOW callback */
    uint32_t rx_wrong_peer;     /* dropped: src MAC not equal to partner */
    uint32_t rx_bad_frame;      /* dropped: deserialize failed (length / version / CRC) */
    uint32_t rx_queue_full;     /* dropped: worker queue was full */
    uint32_t rx_ibi;            /* IBI messages delivered to user callback */
    uint32_t rx_other;          /* non-IBI messages logged then dropped */
} narbis_esp_now_rx_stats_t;

/* Initialize Wi-Fi (STA, no association), ESP-NOW, partner peer, and the
 * worker task. Tolerates a netif / event loop / Wi-Fi that is already
 * running (returns ESP_OK). Logs the Wi-Fi STA MAC and the BLE MAC. */
esp_err_t narbis_esp_now_rx_init(narbis_beat_cb_t cb, void *ctx);

/* Persist a new partner MAC to NVS (namespace "narbis_pair", key
 * "partner_mac") and replace the active ESP-NOW peer. */
esp_err_t narbis_esp_now_rx_set_partner(const uint8_t mac[6]);

/* Erase the NVS partner MAC and remove it from the ESP-NOW peer table.
 * After this the receiver is inert until set_partner() is called again
 * (or the device reboots and the Kconfig fallback is enabled). */
esp_err_t narbis_esp_now_rx_clear_partner(void);

/* Copies the currently active partner MAC into out_mac. Returns
 * ESP_ERR_NOT_FOUND if no partner is configured. */
esp_err_t narbis_esp_now_rx_get_partner(uint8_t out_mac[6]);

/* Snapshot of receive counters since boot. */
void narbis_esp_now_rx_get_stats(narbis_esp_now_rx_stats_t *out);

#ifdef __cplusplus
}
#endif

#endif /* NARBIS_ESP_NOW_RX_H */
