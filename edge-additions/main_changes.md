# Changes to apply to Edge `main.c`

These changes wire the new `narbis_esp_now_rx` component into Edge's existing boot sequence.

## 1. Includes

Add near the other component includes at the top of `main/main.c`:

```c
#include "esp_mac.h"
#include "esp_wifi.h"
#include "narbis_esp_now_rx.h"
```

## 2. Beat callback

Add a static beat callback above `app_main` that pushes received earclip beats onto Edge's existing IBI processing queue:

```c
/* Replace `edge_ibi_queue` with whatever Edge uses internally for its
 * existing Polar / on-device IBI source. The Narbis receiver feeds the
 * same downstream pipeline. */
static void on_earclip_beat(const narbis_beat_event_t *evt, void *ctx)
{
    (void)ctx;

    /* TODO(porter): replace this with the Edge-side enqueue call. The
     * existing path likely takes a uint16_t IBI in milliseconds; if it
     * takes a richer struct, populate it here from `evt`. */
    uint16_t ibi_ms = evt->ibi_ms;
    /* xQueueSend(edge_ibi_queue, &ibi_ms, 0); */
    (void)ibi_ms;
}
```

## 3. Boot-time MAC log

Inside `app_main()`, after `nvs_flash_init()` and before BLE initialization, log both MACs. The Wi-Fi STA MAC is the address the earclip needs to be paired against; the BLE MAC is what dashboards / phones see. They are **not** the same.

```c
{
    uint8_t mac[6];
    ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_WIFI_STA));
    ESP_LOGI("boot", "WIFI_STA_MAC: %02x:%02x:%02x:%02x:%02x:%02x",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_BT));
    ESP_LOGI("boot", "BLE_MAC:      %02x:%02x:%02x:%02x:%02x:%02x",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
}
```

(The receiver also logs both MACs from inside its init for redundancy.)

## 4. Receiver init

Still in `app_main()`, after BLE init but before the main loop / event-driven handler, init the receiver:

```c
ESP_ERROR_CHECK(narbis_esp_now_rx_init(on_earclip_beat, NULL));
```

Init order matters: BLE must be brought up first because `narbis_esp_now_rx_init` calls `esp_wifi_start`, and the coexistence layer prefers BLE to register first. If Edge's existing code already starts Wi-Fi or netif for some other reason, that is fine — the receiver tolerates `ESP_ERR_INVALID_STATE` from those calls.

## 5. (Optional) periodic stats log

For bring-up, a periodic stats dump is helpful. Drop this into the existing slow-tick task or a new 10-second timer:

```c
narbis_esp_now_rx_stats_t st;
narbis_esp_now_rx_get_stats(&st);
ESP_LOGI("narbis_rx",
         "stats: total=%lu ibi=%lu wrong_peer=%lu bad_frame=%lu queue_full=%lu other=%lu "
         "pair_disc=%lu pair_rej=%lu pair_offer=%lu pair_offer_err=%lu",
         (unsigned long)st.rx_total, (unsigned long)st.rx_ibi,
         (unsigned long)st.rx_wrong_peer, (unsigned long)st.rx_bad_frame,
         (unsigned long)st.rx_queue_full, (unsigned long)st.rx_other,
         (unsigned long)st.rx_pair_discover, (unsigned long)st.rx_pair_rejected,
         (unsigned long)st.tx_pair_offer, (unsigned long)st.tx_pair_offer_err);
```

## Notes

- The receive callback does **no** deserialization; the worker task does. So the user beat callback runs in task context and may briefly block on a queue send.
- The receiver does not relay beats over BLE on the Edge side — that is deferred to v2.
- Channel: the component hardcodes channel 1 (`NARBIS_RX_CHANNEL` in `narbis_esp_now_rx.c`) to match the earclip's `CONFIG_NARBIS_ESPNOW_CHANNEL` default. If Edge's existing Wi-Fi usage forces a different channel, change both sides to match.
- Auto-pair: out of the box, an unpaired earclip will discover this Edge and self-pair via `NARBIS_MSG_PAIR_DISCOVER` / `PAIR_OFFER`. No additional `main.c` work is required for that — the receive path handles it internally and persists the result to NVS. To force a re-pair, call `narbis_esp_now_rx_clear_partner()`.
