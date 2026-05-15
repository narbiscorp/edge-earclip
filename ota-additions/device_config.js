/*
 * device_config.js — device-type → BLE/firmware identity + release-source
 * mapping.
 *
 * Used by the OTA webapp to:
 *   - filter the requestDevice() scan to the selected product
 *   - tell the firmware validator which chip / project_name to require
 *   - know which GitHub repo to fetch firmware releases from
 *   - know which release asset filename is the application image
 *
 * The OTA service UUIDs (0x00FF / 0xFF01-0xFF03) are identical between
 * Edge and the Narbis earclip — earclip's DFU was deliberately ported
 * from Edge so a single transport implementation drives both. What
 * differs is the scan filter (Edge advertises by name; earclip
 * advertises a primary service UUID), the chip target (ESP32 vs
 * ESP32-C6), the esp_app_desc project name baked into the .bin, and
 * the GitHub repo the firmware releases are published to.
 *
 * `scanFilters` mirrors the exact shape `navigator.bluetooth.requestDevice()`
 * accepts for its `filters` field, so the integrator can pass it through
 * without rewrapping. `optionalServices` likewise feeds straight into
 * the same call.
 */

export const DEVICE_CONFIG = {
  edge: {
    label: "Edge glasses",
    scanFilters: [{ name: "Smart_Glasses" }, { name: "Narbis_Edge" }],
    optionalServices: [0x00ff],
    projectNamePrefix: "ESP32_Ble",
    chipId: 0x0000,
    chipLabel: "ESP32",
    releaseRepo: { owner: "narbiscorp", repo: "edge-firmware" },
    binName: "ESP32_Ble.bin",
  },
  earclip: {
    label: "Narbis earclip",
    scanFilters: [
      { services: ["a24080b2-8857-4785-b3ba-a43b66af4f28"] },
    ],
    optionalServices: [0x00ff, 0x180a],
    projectNamePrefix: "narbis_earclip",
    chipId: 0x000d,
    chipLabel: "ESP32-C6",
    // TODO(integrator): replace `repo` with the actual destination repo
    // once the earclip firmware release workflow is installed (see
    // firmware-release-additions/INTEGRATION.md). Until then, the OTA
    // webapp will surface a "release source not configured" message
    // instead of issuing a 404 against a placeholder.
    releaseRepo: { owner: "narbiscorp", repo: null },
    binName: "narbis_earclip.bin",
  },
};

/* Friendly names for esp_image_header_t.chip_id values, used when
 * surfacing a mismatch error. Source: ESP-IDF esp_app_format.h. */
export const CHIP_ID_NAMES = {
  0x0000: "ESP32",
  0x0002: "ESP32-S2",
  0x0005: "ESP32-C3",
  0x0009: "ESP32-S3",
  0x000c: "ESP32-C2",
  0x000d: "ESP32-C6",
  0x0010: "ESP32-H2",
};

export function chipIdName(id) {
  return CHIP_ID_NAMES[id] ?? `unknown(0x${id.toString(16).padStart(4, "0")})`;
}

export function deviceConfig(deviceKey) {
  const cfg = DEVICE_CONFIG[deviceKey];
  if (!cfg) throw new Error(`unknown device key: ${deviceKey}`);
  return cfg;
}
