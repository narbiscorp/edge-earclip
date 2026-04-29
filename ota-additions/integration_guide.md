# OTA webapp integration guide

This directory holds files to graft into the existing Edge OTA webapp so it can also update Narbis earclips. The DFU protocol is identical between the two devices (the earclip's DFU was ported from Edge), so the changes are purely additive: device picker, firmware validator, version display.

**Do not** modify the existing DFU protocol implementation. Everything here sits in front of it.

## 1. Drop-in files

Copy the four runtime files plus the HTML snippet into the existing webapp:

```
<webapp>/src/ota/
├── device_config.js
├── firmware_validator.js
└── version_display.js
<webapp>/src/ota/partials/
└── device_selector.html
```

If the existing webapp is not module-based, paste each .js file's contents into a `<script type="module">` block in the same HTML page that drives OTA. The files use ES module `import`/`export`.

## 2. Wire the device selector into the existing UI

Insert `device_selector.html` above the existing "Connect" button. Read the selected value before kicking off scan/connect:

```js
import { DEVICE_CONFIG } from "./device_config.js";

function selectedDeviceKey() {
  const el = document.querySelector(
    'input[name="narbis-device"]:checked',
  );
  return el ? el.value : "edge";
}
```

`device_selector.html` defaults to `edge` so the existing flow is unchanged for users who do not touch the picker.

## 3. Wire the scan filter

The existing `requestDevice()` call almost certainly hardcodes the Edge primary service UUID. Replace it with a lookup keyed by the selected device:

```js
const cfg = DEVICE_CONFIG[selectedDeviceKey()];
const device = await navigator.bluetooth.requestDevice({
  filters: [{ services: [cfg.productServiceUuid] }],
  optionalServices: [
    cfg.otaServiceUuid,   // 0x00FF — same on both devices
    0x180a,               // DIS, for version_display.js
  ],
});
```

**Before commit**, fill in the `productServiceUuid` for the `edge` entry in `device_config.js`. It is the same UUID currently in the existing `requestDevice()` filter — just hoisted into the config map.

## 4. Wire the firmware validator before "Start Update"

In the file-input change handler:

```js
import { validateFirmware } from "./firmware_validator.js";

fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  if (!file) return;
  const result = await validateFirmware(file, selectedDeviceKey());

  startBtn.disabled = !result.ok;
  errorBox.textContent = result.errors.join("\n");

  // result.version is also useful for the version display below.
  pendingVersion = result.version;
});
```

`validateFirmware()` reads only the first 512 bytes — multi-MB images do not get loaded into memory.

## 5. Wire the version display

After `gatt.connect()` succeeds:

```js
import { readDeviceVersion, renderVersionRow } from "./version_display.js";

const server = await device.gatt.connect();
const current = await readDeviceVersion(server);   // null if no DIS
renderVersionRow(versionContainer, {
  current,
  incoming: pendingVersion,                          // from validator
});
```

If `incoming` is older than `current`, the helper inserts a yellow warning row but does **not** disable the Start button — downgrades are sometimes intentional (rolling back a bad release).

## 6. Test matrix

Run all of these against real hardware after porting. Treat any failure as a release-blocker.

| # | Setup                                  | Expected                                                              |
|---|----------------------------------------|-----------------------------------------------------------------------|
| 1 | Edge selected, known-good Edge .bin    | Validator passes, OTA completes, glasses reboot into new image        |
| 2 | Earclip selected, known-good earclip .bin | Validator passes, OTA completes, earclip reboots into new image    |
| 3 | Earclip selected, Edge .bin            | Validator refuses with chip mismatch (`0x0000` vs `0x000d`); Start disabled |
| 4 | Edge selected, earclip .bin            | Validator refuses with chip mismatch (`0x000d` vs `0x0000`); Start disabled |
| 5 | Either selected, random non-binary file | Validator refuses with "not an ESP32 firmware image" (magic byte)    |
| 6 | Either selected, .bin shorter than 128 bytes | Validator refuses with "file too small"                          |
| 7 | Earclip selected, earclip .bin with mangled app-desc magic | Validator refuses with "no ESP-IDF app descriptor"  |
| 8 | Earclip selected, earclip .bin from a different ESP32-C6 product | Validator refuses with "project name does not start with narbis_earclip" |
| 9 | Connect to running earclip, no upload yet | Version row shows current firmware version from DIS               |
| 10 | Pick an older earclip .bin            | Version row shows downgrade warning; Start button still enabled       |
| 11 | Pick the same version that's on the device | No warning shown; Start enabled                                  |

Cases 1 and 2 are the regression checks — confirm the existing Edge flow is untouched and the new earclip flow works end-to-end. Cases 3–8 are the safety gates that justify this change. Cases 9–11 cover version-display behavior including the "do not silently allow downgrades" rule.

## Out of scope

- Refactoring the DFU control/data/status code paths.
- Adding firmware signing / encryption — deferred to v2.
- Pairing UI — earclip uses NVS-stored partner MAC plus Kconfig fallback.
- Auto-detecting device type from advertisement (the user picks explicitly).
