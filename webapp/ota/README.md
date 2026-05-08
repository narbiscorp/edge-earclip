# Narbis OTA Updater

Single-page Web Bluetooth updater that handles both **Edge glasses** and the **Narbis earclip**. Open `index.html` in any Chromium-based browser (Chrome, Edge, Brave) on a desktop or Android device with Bluetooth.

## How it works

1. **Connect** — scan accepts both Edge advertising names (`Smart_Glasses`, `Narbis_Edge`) and the earclip's name prefix (`Narbis Earclip XXYYZZ`). Whichever device the user picks, the webapp identifies it from the advertised name and configures everything else accordingly.
2. **Select firmware** — release list is fetched from the matching GitHub repo:
   - Edge → `narbiscorp/edge-firmware`, asset `ESP32_Ble.bin`
   - Earclip → `narbiscorp/edge-earclip`, asset `narbis_earclip.bin`
3. **Validate** — before any byte is sent, the first 512 bytes of the chosen `.bin` are parsed for ESP image magic, `chip_id`, and the ESP-IDF app descriptor's `project_name`. The wrong `.bin` for the connected device is refused with a clear pre-flash error.
4. **Flash** — page-based CRC32 transfer (4 KB pages, 244 B chunks), identical wire protocol on both devices. The earclip-only error codes (`0x06` low battery, `0x07` chip mismatch, `0x08` already in OTA) are surfaced in the UI.

The Device Information Service (`0x180A` / `0x2A26`) is read after connect to display the current firmware revision side-by-side with the version embedded in the chosen `.bin`. Downgrades show a yellow warning but are not blocked.

## Hosting

This is a single static HTML file with no build step. Drop it on:
- GitHub Pages (e.g. publish from `main:/webapp/ota`)
- Any HTTPS static host (Netlify, Cloudflare Pages, S3 + CloudFront)
- Local file (`file://` works for testing, but Web Bluetooth requires a secure context — use `https://` for production)

## Browser support

| Browser | Desktop | Android | iOS |
|---------|---------|---------|-----|
| Chrome  | ✅       | ✅       | ❌   |
| Edge    | ✅       | ✅       | ❌   |
| Brave   | ✅       | ✅       | ❌   |
| Firefox | ❌ (no Web Bluetooth) | ❌ | ❌ |
| Safari  | ❌       | n/a     | ❌   |

iOS users can try [Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055), but it is not officially supported.

## Adding a new device

Edit the `DEVICES` map at the top of `index.html`. Each entry needs:

| Field | What it does |
|-------|--------------|
| `label` | Human-readable name for the chip in the UI |
| `kind` | Lower-case key used for device-tag CSS class |
| `nameMatch(name)` | Predicate matching the BLE advertising name |
| `chipId` | ESP image-header `chip_id` (e.g. `0x000D` for ESP32-C6) |
| `chipLabel` | Friendly chip name for error messages |
| `projectNamePrefix` | Required prefix of the `.bin`'s app-desc `project_name` |
| `binName` | GitHub release asset filename to look for |
| `maxBytes` | Refuse `.bin` larger than this (one OTA partition slot) |
| `slotMB` | Same value in MB, shown in the partition diagram legend |
| `ghOwner` / `ghRepo` | GitHub repo to query for releases |

The OTA wire protocol (UUIDs, opcodes, page-CRC flow) is shared and lives outside the table.

## Source files this consolidates

- `Downloads/index (12).html` — base webapp (v13.2 with page-CRC + reliability fixes)
- `ota-additions/firmware_validator.js` — `.bin` header/app-desc parser
- `ota-additions/version_display.js` — DIS read + semver compare + downgrade warning
- `ota-additions/device_config.js` — per-device chip/project mapping
