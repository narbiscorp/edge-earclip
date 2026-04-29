# edge-additions — porting guide

This directory contains everything needed to add Narbis earclip ESP-NOW reception to the existing Edge glasses firmware. Nothing here builds in this repo; the files are staged so they can be copied into the Edge firmware repo as one batch.

## Contents

```
edge-additions/
├── components/narbis_esp_now_rx/    drop-in component
│   ├── include/narbis_esp_now_rx.h
│   ├── narbis_esp_now_rx.c
│   └── CMakeLists.txt
├── sdkconfig.additions              lines to append to Edge's sdkconfig.defaults
├── Kconfig.additions                lines to append to Edge's Kconfig.projbuild
├── main_changes.md                  edits to Edge's main.c
└── README.md                        this file
```

## What the component does

- Brings up Wi-Fi in STA mode (no association) and ESP-NOW.
- Reads the partner (earclip) MAC from NVS namespace `narbis_pair`, key `partner_mac`. If absent, falls back to the Kconfig string `CONFIG_NARBIS_HARDCODED_PARTNER_MAC_VAL` when `CONFIG_NARBIS_HARDCODED_PARTNER_MAC=y`.
- Adds the partner as an ESP-NOW peer. Frames from any other source MAC are dropped (counted in `rx_wrong_peer`).
- The ESP-NOW receive callback only copies the frame and enqueues it. A worker task pulls from the queue, deserializes through `narbis_packet_deserialize` (CRC + version + length checked there), logs every packet, and invokes the user beat callback for `NARBIS_MSG_IBI`.
- Other message types (BATTERY, RAW_PPG, SQI, HEARTBEAT, CONFIG_ACK) are logged but not forwarded — Edge has no use for them in v1.

## Porting steps

1. **Copy the component.** Copy `components/narbis_esp_now_rx/` into the Edge repo's `components/` directory.

2. **Make the shared protocol available.** The component requires a `narbis_protocol` component. Two options:

   - **Option A (recommended): git submodule.** Add this repo as a submodule of the Edge repo and create `components/narbis_protocol/CMakeLists.txt` pointing at the submodule's `protocol/` directory:

     ```cmake
     idf_component_register(
         SRCS         "${COMPONENT_DIR}/../../<submodule_path>/protocol/narbis_protocol.c"
         INCLUDE_DIRS "${COMPONENT_DIR}/../../<submodule_path>/protocol"
     )
     ```

   - **Option B: copy.** Copy `protocol/narbis_protocol.h` and `protocol/narbis_protocol.c` into a new `components/narbis_protocol/` directory in the Edge repo, alongside a `CMakeLists.txt`:

     ```cmake
     idf_component_register(
         SRCS         "narbis_protocol.c"
         INCLUDE_DIRS "."
     )
     ```

     Option B drifts when the protocol changes — only use it if a submodule is impractical.

3. **Append `sdkconfig.additions`** to Edge's `sdkconfig.defaults` (or your equivalent base sdkconfig fragment).

4. **Append `Kconfig.additions`** to Edge's `main/Kconfig.projbuild` (or the relevant Kconfig file). Then `idf.py menuconfig` and set `CONFIG_NARBIS_HARDCODED_PARTNER_MAC_VAL` to the earclip's Wi-Fi STA MAC.

5. **Apply `main_changes.md`** to Edge's `main.c`. The key insertion points are: include the header, add a beat callback that hands `evt->ibi_ms` to Edge's existing IBI processing queue, log both MACs at boot, and call `narbis_esp_now_rx_init(...)` after BLE init.

6. **Build and flash.** From the Edge repo root:

   ```sh
   idf.py fullclean
   idf.py build
   idf.py -p <port> flash monitor
   ```

## Bring-up test plan

After porting, verify in this order. All steps run with the Edge glasses serial monitor open.

1. **Boot prints both MACs.** On reset you should see two distinct lines:

   ```
   I (xxx) boot: WIFI_STA_MAC: AA:BB:CC:DD:EE:FF
   I (xxx) boot: BLE_MAC:      AA:BB:CC:DD:EE:FE
   ```

   The two values must differ. If they are identical, the `esp_read_mac(...)` calls were swapped or the BLE controller never initialized.

2. **Pair both sides.** Note Edge's `WIFI_STA_MAC` and put it in the earclip's `CONFIG_NARBIS_HARDCODED_PARTNER_MAC_VAL` (or write it via the dashboard pairing flow). Conversely, put the earclip's `WIFI_STA_MAC` in Edge's `CONFIG_NARBIS_HARDCODED_PARTNER_MAC_VAL`. Reflash both.

3. **Receiver init log.** Edge should print:

   ```
   I (xxx) narbis_rx: partner (kconfig) <earclip MAC>  ch=1
   ```

   If you see `no partner MAC configured`, the Kconfig string did not parse — check for a typo.

4. **Live IBI stream.** Power the earclip and have it acquire signal. Within a few seconds Edge should print roughly one of these per beat (≈1 Hz at rest):

   ```
   I (xxx) narbis_rx: IBI       seq=N ts=… ibi=850 ms  conf=92  flags=0x00
   ```

5. **Beat-callback wiring.** Add a temporary `ESP_LOGI` inside `on_earclip_beat` (in Edge's `main.c`) and confirm it fires on every IBI line. Once verified, remove the log and confirm the beat is reaching Edge's downstream IBI processing.

6. **Wrong-peer rejection.** Flash a third ESP32 with a Narbis-format transmitter (any earclip with a different MAC). Edge should not log any `IBI` lines from that device, and `rx_wrong_peer` should increment in the periodic stats log.

7. **CRC rejection.** With the third ESP32, transmit a frame with one corrupted byte. `rx_bad_frame` should increment and an `ESP_LOGW` "deserialize failed" line should appear. No callback fires.

8. **Queue full (optional).** Stress-test by transmitting at high rate (e.g. RAW_PPG batches at >50 Hz). `rx_queue_full` should remain 0 in normal operation; if it climbs steadily, the worker task is starved — check task priorities.

9. **Latency check.** Trigger a known beat (finger pulse on the sensor) and confirm Edge's `IBI` log appears within ~300 ms (the project-wide latency target from `CLAUDE.md`).

## Out of scope (deferred to v2)

- BLE relay of earclip data to the dashboard via Edge.
- Sensor fusion of Edge-side and earclip-side beats.
- Pairing UI (the v1 path is Kconfig + `narbis_esp_now_rx_set_partner` from a future BLE characteristic).
- ESP-NOW encryption or signing.

## Confirmation

The seven files in this directory are ready to be copied into the Edge firmware repo. Port them per the steps above and run the test plan. The component compiles against ESP-IDF 5.5.1 (matching the earclip's pin) and uses only public IDF APIs (`esp_wifi`, `esp_now`, `esp_event`, `esp_netif`, `nvs_flash`, `freertos`, `esp_mac`).
