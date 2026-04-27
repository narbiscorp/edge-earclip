# Stage 05 — Firmware: ESP-NOW transport

## Task

Implement the ESP-NOW transport that sends beat events to the Edge glasses.

## Prerequisites

Stage 04 complete. Beats are detected.

## Hardware needed

A second ESP32 (any variant) flashed with a basic ESP-NOW receiver to act as test fixture.

## What to build

1. **`firmware/main/transport_espnow.c/h`**:
   - Init Wi-Fi in WIFI_MODE_STA (no association — just enable radio)
   - Init ESP-NOW
   - Read partner MAC: NVS first (namespace `narbis_pair`, key `partner_mac`); fallback to `CONFIG_NARBIS_HARDCODED_PARTNER_MAC_VAL` if Kconfig flag set
   - Add partner as ESP-NOW peer
   - API:
     - `esp_err_t espnow_transport_init(void)`
     - `esp_err_t espnow_transport_set_partner(const uint8_t mac[6])` — also persists to NVS
     - `esp_err_t espnow_transport_send_beat(const beat_event_t *beat)`
     - `esp_err_t espnow_transport_send_raw_sample(...)`
     - `esp_err_t espnow_transport_send_battery(uint8_t soc_pct, uint16_t mv)`
   - Each send packs into `narbis_packet_t` with sequence number, CRC, timestamp
   - Send callback logs delivery success/failure

2. **NVS helpers in `firmware/main/config_manager.c`**:
   - Namespace `narbis_pair`
   - Functions: `config_get_partner_mac`, `config_set_partner_mac`, `config_clear_pairing`

3. **Test fixture under `firmware/test/espnow_receiver_fixture/`**:
   - Separate minimal ESP-IDF project for any ESP32
   - Receives Narbis packets, prints them
   - Documents its MAC in `firmware/test/README.md`

4. **Wire up in main.c**:
   - Beat callback → `espnow_transport_send_beat()`
   - Periodic battery report every 30 seconds
   - Boot log: print partner MAC and source (NVS vs hardcoded)
   - Boot log: print this device's Wi-Fi MAC and BLE MAC separately

## Implementation notes

- ESP-NOW uses Wi-Fi MAC, not BLE MAC — print both at boot to avoid confusion
- Max payload 250 bytes — beat events fit easily
- Unencrypted ESP-NOW for v1
- Don't enable Wi-Fi power save while ESP-NOW is active
- Send callback fires from Wi-Fi task — keep it short

## Success criteria

- Two-device test: earclip + receiver fixture
- Earclip beats arrive at receiver with sequence numbers incrementing
- CRC validation passes on receiver
- Clearing NVS and rebooting → hardcoded fallback used
- Writing to NVS via test command → that MAC used after reboot
- 10-minute test: packet success rate > 99%

## When done

Report packet success rate, end-to-end latency from beat detection to receiver print.
