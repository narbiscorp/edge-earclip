# ota-additions — porting guide

This directory contains everything needed to extend the existing Edge OTA webapp so it can also update Narbis earclip firmware. Nothing here builds in this repo; the files are staged so they can be copied into the OTA webapp repo as one batch. The DFU protocol is identical between the two devices (the earclip's DFU was ported from Edge), so all changes are additive — the existing Edge update flow is untouched.

## Contents

```
ota-additions/
├── device_selector.html    drop-in <fieldset> with Edge / Earclip radios
├── device_config.js        device → service UUID / chip / project_name map
├── firmware_validator.js   parses .bin header + app_desc; refuses mismatches
├── version_display.js      reads DIS firmware revision, warns on downgrade
├── integration_guide.md    step-by-step porting + test matrix
└── README.md               this file
```

## What the additions do

- **Picker.** Adds an Edge/Earclip radio above the existing Connect button. Defaults to Edge so the existing flow is unchanged for users who do not interact with the picker.
- **Scan filter.** Hoists the hardcoded primary-service UUID in the existing `requestDevice()` filter into `device_config.js`, keyed by the selected device.
- **Pre-upload validation.** Reads only the first 512 bytes of the uploaded `.bin`, parses the ESP32 image header for `chip_id` and the ESP-IDF app descriptor for `project_name`, and refuses (with a specific error message) if either does not match the selected device. This catches "wrong .bin at wrong device" before any bytes are sent — matching the earclip-side `NARBIS_OTA_ERR_CHIP_MISMATCH=0x07` guard but giving the user a clearer, earlier error.
- **Version display.** Reads `Firmware Revision String` from the standard Bluetooth DIS (`0x180A` / `0x2A26`) on the connected device, shows it next to the version embedded in the uploaded `.bin`, and warns (does not block) on downgrade.

## Porting steps

See [integration_guide.md](./integration_guide.md). Summary:

1. Copy the four runtime files plus `device_selector.html` into the existing webapp.
2. Fill in the Edge `productServiceUuid` TODO in `device_config.js` from the existing webapp's scan filter.
3. Read the radio value before scan/connect; pass it to `validateFirmware(file, deviceKey)` and to `DEVICE_CONFIG[deviceKey].productServiceUuid` in the `requestDevice` filter.
4. Wire `readDeviceVersion()` after `gatt.connect()` and `renderVersionRow()` to show current vs new.

## Things this directory deliberately does not do

- Modify the existing DFU control/data/status code paths.
- Drop or replace the existing Edge update flow.
- Allow downgrades silently — they show a warning, but the user can still proceed.
- Add encryption / signing — deferred to v2.
- Auto-detect device type from advertisement — the user picks explicitly.

## Confirmation

The five files in this directory are ready to be copied into the existing OTA webapp repo. The only integrator-side fill-in is the Edge `productServiceUuid` in `device_config.js`. After porting, run the test matrix in `integration_guide.md` — in particular, regress-test that the existing Edge OTA still works end-to-end (cases 1–2), then verify the safety gates (cases 3–8) and the version display (cases 9–11).
