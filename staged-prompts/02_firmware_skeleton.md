# Stage 02 — Firmware project skeleton

## Task

Set up the bare ESP-IDF project under `firmware/` for the XIAO ESP32-C6. All components stubbed but not implemented. Goal: project compiles cleanly with the right structure.

## Read first

- `CLAUDE.md` (project root)
- `protocol/narbis_protocol.h`

## What to build

1. **`firmware/CMakeLists.txt`** — standard ESP-IDF top-level. Project name `narbis_earclip`.

2. **`firmware/sdkconfig.defaults`**:
   - `CONFIG_IDF_TARGET="esp32c6"`
   - BLE enabled (NimBLE host)
   - Wi-Fi enabled (for ESP-NOW)
   - `CONFIG_ESP_COEX_SW_COEXIST_ENABLE=y`
   - Light sleep enabled (`CONFIG_PM_ENABLE=y`, `CONFIG_FREERTOS_USE_TICKLESS_IDLE=y`)
   - Default log level INFO

3. **`firmware/partitions.csv`** with dual app slots:
   - factory: 1 MB (recovery)
   - ota_0: 1.5 MB
   - ota_1: 1.5 MB
   - nvs: 24 KB
   - ota_data: 8 KB
   - phy_init: 4 KB

4. **`firmware/Kconfig.projbuild`**:
   - `CONFIG_NARBIS_HARDCODED_PARTNER_MAC` boolean (default y)
   - `CONFIG_NARBIS_HARDCODED_PARTNER_MAC_VAL` string (placeholder MAC)

5. **`firmware/main/`** with:
   - `CMakeLists.txt` listing all source files
   - `main.c` — minimal entry: NVS init, log "Narbis earclip booting v0.1.0", print protocol version, then enter empty FreeRTOS task
   - Stub files for: `app_state.c/h`, `transport_espnow.c/h`, `transport_ble.c/h`, `ble_service_hrs.c/h`, `ble_service_battery.c/h`, `ble_service_dis.c/h`, `ble_service_narbis.c/h`, `ble_ota.c/h`, `config_manager.c/h`, `power_mgmt.c/h`, `diagnostics.c/h`
   - Each stub has init/deinit functions returning ESP_OK with a TODO comment

6. **`firmware/components/`**:
   - `ppg_driver_max3010x/` — header, .c file, CMakeLists, all stubbed
   - `ppg_channel/` — same
   - `elgendi/` — same
   - `beat_validator/` — same
   - `narbis_protocol/` — symlink or copy of the protocol files (since this is one repo, you can include them via relative path in CMakeLists)

7. **`firmware/.gitignore`** — standard ESP-IDF artifacts (build/, sdkconfig, *.bin, etc.)

8. **`.github/workflows/firmware-build.yml`** at repo root — GitHub Actions workflow that builds the firmware on every push.

## Success criteria

- `cd firmware && idf.py set-target esp32c6` succeeds
- `idf.py build` succeeds with zero errors and zero warnings
- Firmware boots on real hardware and prints the boot message over UART
- All component stubs are present in build output

## Do not

- Implement any logic yet — scaffolding only
- Configure GPIOs or peripherals
- Add code that uses protocol structs in a way requiring real definitions

## When done

Confirm the project builds, report the binary size, and list created files.
