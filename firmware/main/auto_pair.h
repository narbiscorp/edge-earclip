#ifndef NARBIS_AUTO_PAIR_H
#define NARBIS_AUTO_PAIR_H

#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/* =============================================================================
 * Auto-pair: discover the Edge glasses' STA MAC over ESP-NOW with no manual
 * MAC entry on either side.
 *
 * Boot path:
 *   - If NVS holds a valid partner_mac, auto_pair_init() is a no-op (already
 *     paired). transport_espnow already added the peer in that case.
 *   - Otherwise auto_pair_init() spawns a one-shot discovery task that:
 *       1. Adds the ESP-NOW broadcast peer (FF:…:FF, channel = Kconfig).
 *       2. Sends NARBIS_MSG_PAIR_DISCOVER (carrying our STA MAC + a 16-bit
 *          nonce) every DISCOVER_INTERVAL_MS until either a matching
 *          NARBIS_MSG_PAIR_OFFER comes back from the Edge that picked it up,
 *          or DISCOVER_RETRIES expires.
 *       3. On match: persists Edge's MAC via config_apply_partner_mac()
 *          (which writes NVS, hot-swaps the live peer, notifies the
 *          dashboard's CONFIG characteristic) and removes the broadcast peer.
 *
 * The matching Edge-side filter bypass lives in
 *   edge-additions/components/narbis_esp_now_rx/narbis_esp_now_rx.c
 * (handle_pair_discover). Keep both halves in sync.
 * ============================================================================= */

typedef enum {
    AUTO_PAIR_STATE_IDLE        = 0,  /* not started yet */
    AUTO_PAIR_STATE_PAIRED      = 1,  /* steady state, partner in NVS */
    AUTO_PAIR_STATE_DISCOVERING = 2,  /* broadcasting PAIR_DISCOVER */
    AUTO_PAIR_STATE_FAILED      = 3   /* timed out without an offer */
} auto_pair_state_t;

esp_err_t auto_pair_init(void);

/* Snapshot of the current state (lock-free read of a volatile uint8_t). */
auto_pair_state_t auto_pair_current_state(void);

/* Erase the persisted partner MAC and re-run discovery. Returns
 * ESP_ERR_INVALID_STATE if a discovery is already in progress. */
esp_err_t auto_pair_request_repair(void);

#ifdef __cplusplus
}
#endif

#endif /* NARBIS_AUTO_PAIR_H */
