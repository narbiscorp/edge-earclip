# Stage 14 — Generate Edge firmware additions

## Task

Generate the files needed to add ESP-NOW receiver to the existing Edge firmware. Files go in `edge-additions/` for later copy into the actual Edge firmware repo.

## Prerequisites

Stages 01-13 complete. Earclip works end-to-end.

## What to build

Place all under `edge-additions/`:

1. **`edge-additions/components/narbis_esp_now_rx/`**:
   - `narbis_esp_now_rx.h` — public API: init with beat callback, set/clear partner MAC, get packet stats
   - `narbis_esp_now_rx.c`:
     - Init Wi-Fi STA mode (no association)
     - Init ESP-NOW
     - Read partner MAC from NVS namespace `narbis_pair`, fallback to `CONFIG_NARBIS_HARDCODED_PARTNER_MAC_VAL`
     - Add partner as peer
     - Receive callback: filter by MAC, validate length+CRC, decode `narbis_packet_t`, push to FreeRTOS queue
     - Worker task pulls from queue, calls beat callback for IBI messages
     - UART log every received packet
   - `CMakeLists.txt`

2. **`edge-additions/sdkconfig.additions`** — text file showing diffs to add to Edge's sdkconfig.defaults:
   - `CONFIG_ESP_WIFI_ENABLED=y` (if not already)
   - `CONFIG_ESP_COEX_SW_COEXIST_ENABLE=y`

3. **`edge-additions/Kconfig.additions`** — Kconfig flags to add:
   - `CONFIG_NARBIS_HARDCODED_PARTNER_MAC` boolean, default y
   - `CONFIG_NARBIS_HARDCODED_PARTNER_MAC_VAL` string

4. **`edge-additions/main_changes.md`** — instructions on what to add to existing Edge `main.c`:
   - Init `narbis_esp_now_rx` during boot
   - Wire callback to existing IBI processing queue
   - Print Wi-Fi MAC and BLE MAC at boot

5. **`edge-additions/README.md`** — step-by-step guide for porting these files into the real Edge firmware repo:
   1. Copy `components/narbis_esp_now_rx/` into the Edge repo's `components/`
   2. Add narbis-protocol files (or symlink to this repo)
   3. Apply sdkconfig changes
   4. Apply Kconfig changes
   5. Modify main.c per main_changes.md
   6. Build and verify

## Implementation notes

- ESP-NOW receive callback is short-execution-context — push to queue, process in task
- Wi-Fi MAC ≠ BLE MAC — log both at boot
- Don't enable Wi-Fi power save

## Do not

- Add BLE relay of earclip data (deferred to v2)
- Add sensor fusion (deferred)
- Add pairing UI (deferred)
- Encrypt ESP-NOW (deferred)

## When done

Confirm files are ready to be moved into the real Edge firmware repo. List what should be tested after porting.
