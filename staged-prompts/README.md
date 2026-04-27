# Staged prompts

Run these in Claude Code in order. One per Claude Code session unless they're trivially related.

## Workflow

1. Open the repo in Claude Code
2. Open the next staged prompt file
3. Copy its contents into Claude Code
4. Wait for Claude Code to finish
5. Verify success criteria
6. Commit and push (in GitHub Desktop)
7. Move to next stage

## Stages

### Foundation
- **`01_protocol.md`** — define shared protocol (C header + TypeScript types + UUIDs + serialization)

### Firmware
- **`02_firmware_skeleton.md`** — empty ESP-IDF project that builds
- **`03_firmware_ppg_driver.md`** — MAX30102/30101 driver with auto-detect
- **`04_firmware_dsp.md`** — channel/AGC + bandpass + Elgendi + IBI validator
- **`05_firmware_espnow.md`** — ESP-NOW transport to Edge
- **`06_firmware_ble.md`** — BLE GATT services
- **`07_firmware_config_power.md`** — config persistence, mode state machine, light sleep
- **`08_firmware_ota.md`** — Nordic DFU OTA (port from Edge)

### Dashboard
- **`09_dashboard_skeleton.md`** — Vite + React project skeleton
- **`10_dashboard_ble.md`** — Web Bluetooth connection + packet parsing
- **`11_dashboard_charts.md`** — real-time charts + HRV metrics
- **`12_dashboard_config.md`** — config panel + presets
- **`13_dashboard_recording.md`** — recording + replay

### External work (when ready)
- **`14_edge_additions.md`** — generates files for the Edge firmware (you'll move them to that repo)
- **`15_ota_additions.md`** — generates files for the OTA webapp

## Tips

- **Don't combine stages.** If a prompt feels small, that's fine — small wins are easier to verify.
- **Verify before moving on.** Each stage has success criteria. Don't proceed if those aren't met.
- **Commit between stages.** Even broken stages should be committed before retrying — gives you a rollback point.
- **Hardware needed** for some stages:
  - Stage 03: MAX30102/30101 board on hand
  - Stage 05: a second ESP32 to act as ESP-NOW receiver test fixture (any spare)
  - Stage 08: reference to existing Edge OTA code
  - Stage 10+: earclip firmware running and BLE working

## When you finish

You'll have a working earclip with:
- Live PPG sampling and beat detection
- ESP-NOW link to Edge glasses
- BLE link for phone/dashboard
- OTA firmware updates
- A dashboard for tuning, recording, and validation
