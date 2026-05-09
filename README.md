# narbis-earclip

Narbis earclip firmware, dashboard, and protocol — all in one repo.

## What's here

- `protocol/` — shared definitions (C header for firmware, TypeScript for dashboard)
- `firmware/` — ESP-IDF firmware for Seeed XIAO ESP32-C6 with MAX30102/MAX30101 PPG
- `dashboard/` — Web Bluetooth tuning dashboard (Chrome/Edge)
- `edge-additions/` — files to add to the existing Edge firmware repo (when ready)
- `ota-additions/` — files to add to the existing OTA webapp repo (when ready)
- `docs/` — protocol spec, recording format, decision history
- `staged-prompts/` — Claude Code prompts to run in order

See `CLAUDE.md` for architecture, decisions, and conventions.
See `staged-prompts/README.md` for the build order.
See [docs/pairing.md](docs/pairing.md) for the user-facing pairing & LED guide
(what the earclip LED means, what the Edge lens patterns mean, how to pair with
the dashboard and glasses, troubleshooting).

## Quick start

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

## Hardware

- Seeed XIAO ESP32-C6
- MAX30102 or MAX30101 breakout (auto-detected)
- Single-cell LiPo battery
- Wiring: SDA→D4, SCL→D5, INT→D0, VIN→3V3, GND→GND
