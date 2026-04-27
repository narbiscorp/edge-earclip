# narbis-earclip — CLAUDE.md

Everything for the Narbis earclip lives in this repo: firmware, dashboard, protocol definitions, and modifications planned for the existing Edge firmware and OTA webapp.

This is a single-developer project. We optimize for clarity and velocity, not for the multi-team patterns you'd see in a larger org.

## Repo layout

```
narbis-earclip/
├── CLAUDE.md                       # this file
├── README.md
├── protocol/                       # shared protocol definitions
│   ├── narbis_protocol.h           # used by firmware
│   ├── narbis_protocol.c
│   ├── narbis_protocol.ts          # used by dashboard
│   └── uuids.ts
├── firmware/                       # earclip firmware (ESP-IDF, ESP32-C6)
│   ├── CMakeLists.txt
│   ├── sdkconfig.defaults
│   ├── partitions.csv
│   ├── main/
│   └── components/
├── dashboard/                      # Web Bluetooth tuning dashboard
│   ├── package.json
│   ├── vite.config.ts
│   └── src/
├── edge-additions/                 # files to copy into existing Edge firmware repo later
│   └── narbis_esp_now_rx/
├── ota-additions/                  # files to add to existing OTA webapp later
└── docs/
    ├── protocol.md
    ├── recording_format.md
    └── decisions.md
```

## Hardware target (firmware)

- **MCU**: Seeed XIAO ESP32-C6 (ESP32-C6, 4 MB flash, 512 KB SRAM)
- **PPG sensor**: MAX30102 or MAX30101 (auto-detected) on I²C
  - SDA: GPIO22 (D4)
  - SCL: GPIO23 (D5)
  - INT: GPIO0 (D0)
  - VIN: 3.3V (NOT 5V)
- **Battery**: single-cell LiPo via XIAO's onboard charger

## ESP-IDF version

Pin to **5.5.1** (matches existing Edge firmware). Do not silently upgrade.

## Architecture (decided in design discussion — do not deviate)

```
PPG sample → driver layer → channel layer → bandpass → Elgendi → IBI validator
                                                                       ↓
                                                          ESP-NOW + BLE transport
```

### Firmware components

- **`firmware/components/ppg_driver_max3010x/`** — single driver supporting MAX30102 and MAX30101, auto-detects via Part ID register. FIFO interrupt-driven sampling.
- **`firmware/components/ppg_channel/`** — channel selection, DC removal, AGC.
- **`firmware/components/elgendi/`** — bandpass + Elgendi systolic peak detection.
- **`firmware/components/beat_validator/`** — IBI plausibility + continuity checks. Flags artifacts, never silently drops.

### Firmware main

- **`firmware/main/transport_espnow.c`** — low-latency path to Edge glasses
- **`firmware/main/transport_ble.c`** — BLE GATT server
- **`firmware/main/ble_service_hrs.c`** — standard Heart Rate Service (0x180D)
- **`firmware/main/ble_service_battery.c`** — Battery Service (0x180F)
- **`firmware/main/ble_service_dis.c`** — Device Information Service (0x180A)
- **`firmware/main/ble_service_narbis.c`** — custom Narbis service
- **`firmware/main/ble_ota.c`** — Nordic-style DFU, port from Edge firmware
- **`firmware/main/config_manager.c`** — NVS-based config persistence
- **`firmware/main/app_state.c`** — mode state machine
- **`firmware/main/power_mgmt.c`** — light sleep, battery monitoring
- **`firmware/main/diagnostics.c`** — diagnostic stream emission

### Dashboard

- **`dashboard/`** — Vite + React + TypeScript + TailwindCSS + Plotly
- Web Bluetooth API for direct BLE
- Charts: raw PPG, filtered signal, IBI tachogram, HRV metrics
- Config UI for live firmware tuning
- Recording to CSV/JSON bundle
- Replay capability
- Polar H10 simultaneous reference connection

## Decisions baked in (DO NOT CHANGE without discussion)

- **Algorithm**: Elgendi systolic peak detection (not Pan-Tompkins, not HeartPy)
- **Sample rate**: 200 Hz default (configurable 50/100/200/400)
- **LED currents**: 7 mA red and IR default, AGC adjusts
- **BLE protocol**: standard Heart Rate Service + Battery + DIS + custom Narbis service
- **ESP-NOW**: NVS-stored partner MAC, hardcoded fallback via Kconfig flag
- **OTA**: Nordic-style DFU, ported from Edge firmware
- **Mode model**: 3-axis (transport / BLE profile / data format)
- **HRV computation**: in dashboard, not firmware

## Mode model

Three orthogonal config axes:
- **transport_mode**: `EDGE_ONLY` or `HYBRID`
- **ble_profile**: `BATCHED` (every ~500 ms) or `LOW_LATENCY` (every beat)
- **data_format**: `IBI_ONLY`, `RAW_PPG`, or `IBI_PLUS_RAW`

Set via BLE config write, persisted to NVS.

## Configurable parameters

Everything in `narbis_runtime_config_t` (see `protocol/narbis_protocol.h`) is dashboard-tweakable. Each parameter has a runtime apply path. No "requires reboot to take effect" parameters except sample rate change.

## Validation targets

- Beat detection lag from physiological event to ESP-NOW packet: <300 ms typical
- IBI agreement with simultaneous Polar H10: ±10 ms typical at rest
- Battery life on 100 mAh LiPo, EDGE_ONLY mode: ≥9 hours
- Battery life on 100 mAh LiPo, HYBRID + LOW_LATENCY + RAW_PPG: ≥6 hours

## Build commands

**Firmware:**
```
cd firmware
idf.py set-target esp32c6
idf.py build
idf.py -p /dev/cu.usbmodem* flash monitor
```

**Dashboard:**
```
cd dashboard
npm install
npm run dev
```

## Browser support (dashboard)

✅ Chrome, Edge, Brave (Mac, Windows, Linux, Android)
❌ Firefox (no Web Bluetooth)
❌ iOS Safari (Apple does not support Web Bluetooth)

## Things to never do

- Use floating point in firmware hot path (interrupt handlers, sample processing)
- Silently drop beats — flag and emit
- Block in interrupt context (FIFO read happens in task, IRQ just signals)
- Use `printf` in firmware (use `ESP_LOG*`)
- Hardcode anything that should be in `narbis_runtime_config_t`
- Compute HRV metrics in firmware (firmware emits beats; dashboard computes metrics)
- Skip the `view` of any relevant skill files before writing code that creates files
- Add encryption / signing yet (v2)
- Use deep sleep on the earclip (incompatible with continuous sampling — use light sleep)

## Working order

Build the parts in this order. Each depends on what came before.

1. Protocol definitions (`protocol/`)
2. Firmware project skeleton (`firmware/`)
3. Firmware PPG driver
4. Firmware channel/AGC/Elgendi/validator
5. Firmware ESP-NOW transport
6. Firmware BLE services
7. Firmware mode controller, config persistence, power management
8. Firmware OTA (Nordic-style DFU port from Edge)
9. Dashboard scaffolding
10. Dashboard BLE connection + parsing
11. Dashboard charts + HRV metrics
12. Dashboard config panel + presets
13. Dashboard recording + replay
14. Edge firmware additions (separate repo, files prepared in `edge-additions/`)
15. OTA webapp extensions (separate repo, files prepared in `ota-additions/`)

The staged prompts in `staged-prompts/` map to each of these in order.
