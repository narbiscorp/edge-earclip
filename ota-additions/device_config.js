/*
 * device_config.js — device-type → BLE/firmware identity mapping.
 *
 * Used by the OTA webapp to:
 *   - filter the requestDevice() scan to the selected product
 *   - tell the firmware validator which chip / project_name to require
 *
 * The OTA service UUIDs (0x00FF / 0xFF01-0xFF03) are identical between
 * Edge and the Narbis earclip — earclip's DFU was deliberately ported
 * from Edge so a single transport implementation drives both. What
 * differs is the product's primary service (used for scan filtering),
 * the chip target (ESP32 vs ESP32-C6), and the esp_app_desc project
 * name baked into the .bin.
 *
 * NOTE on the Edge `productServiceUuid`: the existing Edge firmware
 * already advertises a product service UUID — fill it in from Edge's
 * existing webapp scan filter at integration time. The earclip side
 * is concrete (NARBIS_SVC_UUID from protocol/uuids.ts).
 */

export const DEVICE_CONFIG = {
  edge: {
    label: "Edge glasses",
    otaServiceUuid: 0x00ff,
    // TODO(integrator): replace with the Edge primary service UUID
    // currently used by the existing webapp's requestDevice() filter.
    productServiceUuid: null,
    projectNamePrefix: "edge",
    chipId: 0x0000,
    chipLabel: "ESP32",
  },
  earclip: {
    label: "Narbis earclip",
    otaServiceUuid: 0x00ff,
    productServiceUuid: "a24080b2-8857-4785-b3ba-a43b66af4f28",
    projectNamePrefix: "narbis_earclip",
    chipId: 0x000d,
    chipLabel: "ESP32-C6",
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
