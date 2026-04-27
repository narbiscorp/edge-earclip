# Stage 15 — Generate OTA webapp additions

## Task

Generate files to extend the existing Edge OTA webapp to also update earclip firmware.

## Prerequisites

Stages 01-14 complete.

## What to build

Place all under `ota-additions/`:

1. **`ota-additions/device_selector.html`** — UI snippet to add device selection (Edge / Earclip)

2. **`ota-additions/device_config.js`** — config mapping:
   - Device type → service UUID → expected firmware ID prefix → chip target

3. **`ota-additions/firmware_validator.js`** — validates uploaded .bin file:
   - Parse first 32 bytes (ESP32 image header)
   - Detect chip type (classic ESP32 vs ESP32-C6)
   - Refuse if mismatched with selected device

4. **`ota-additions/version_display.js`** — reads firmware version from DIS, displays current vs new

5. **`ota-additions/integration_guide.md`** — step-by-step:
   1. Add device selector to existing UI
   2. Wire selector to existing scan filter
   3. Add firmware validator before "Start Update"
   4. Add version display
   5. Test: Edge OTA still works
   6. Test: Earclip OTA works
   7. Test: Wrong firmware refused

## Implementation notes

- Don't refactor existing DFU protocol code — additive changes only
- ESP32 image header magic byte: 0xE9
- Chip ID in extended header (see ESP-IDF docs)

## Do not

- Modify the DFU protocol implementation
- Drop support for existing Edge update flow
- Allow downgrades without warning

## When done

Confirm files ready to be moved into real OTA webapp repo. List what to test after integration.
