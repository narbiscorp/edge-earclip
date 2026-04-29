/*
 * firmware_validator.js — refuse the wrong .bin before bytes are sent.
 *
 * Parses the ESP32 image header and the ESP-IDF app descriptor in the
 * uploaded firmware file. If the chip ID or the project_name prefix
 * does not match the selected device, validation fails and the
 * integrator should disable the "Start Update" button.
 *
 * This is purely additive — it does not touch the existing DFU
 * protocol implementation. It runs before the upload begins.
 *
 * Layout we parse (first 512 bytes of the .bin are enough):
 *
 *   0x00  u8   image magic  (must be 0xE9)
 *   0x01  u8   segment count
 *   0x02..0x0B header bytes we don't care about
 *   0x0C  u16  chip_id (LE)        — esp_image_header_t.chip_id
 *   ...
 *   0x18..0x1F first segment header (load_addr, data_len)
 *   0x20  u32  app_desc magic (LE) (must be 0xABCD5432)
 *   0x30  32B  version       (null-terminated ASCII)
 *   0x50  32B  project_name  (null-terminated ASCII)
 *
 * Sources:
 *   - ESP-IDF esp_app_format.h  (esp_image_header_t, esp_app_desc_t)
 *   - app image format docs at docs.espressif.com
 *
 * Mirrors the earclip-side guard in firmware/main/ble_ota.c which
 * rejects with NARBIS_OTA_ERR_CHIP_MISMATCH (0x07) — catching it here
 * means the user sees a clear error before the transfer starts instead
 * of a status-notification error mid-upload.
 */

import { deviceConfig, chipIdName } from "./device_config.js";

const ESP_IMAGE_MAGIC = 0xe9;
const APP_DESC_MAGIC = 0xabcd5432;

const HEADER_BYTES_NEEDED = 0x80;   /* through end of project_name */
const FILE_SLICE_BYTES    = 512;    /* read a bit extra for safety  */

const OFF_IMAGE_MAGIC      = 0x00;
const OFF_CHIP_ID          = 0x0c;
const OFF_APP_DESC_MAGIC   = 0x20;
const OFF_APP_DESC_VERSION = 0x30;
const OFF_APP_DESC_NAME    = 0x50;
const APP_DESC_STR_LEN     = 32;

function readCString(view, offset, maxLen) {
  const bytes = [];
  for (let i = 0; i < maxLen; i++) {
    const b = view.getUint8(offset + i);
    if (b === 0) break;
    bytes.push(b);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));
}

/**
 * Validate a firmware .bin against the selected device.
 *
 * @param {Blob|File} file       the user-uploaded firmware blob
 * @param {string}    deviceKey  "edge" or "earclip"
 * @returns {Promise<{
 *   ok: boolean,
 *   chipId: number|null,
 *   chipLabel: string|null,
 *   projectName: string|null,
 *   version: string|null,
 *   errors: string[],
 * }>}
 */
export async function validateFirmware(file, deviceKey) {
  const result = {
    ok: false,
    chipId: null,
    chipLabel: null,
    projectName: null,
    version: null,
    errors: [],
  };

  const cfg = deviceConfig(deviceKey);

  if (!file || typeof file.slice !== "function") {
    result.errors.push("no file provided");
    return result;
  }
  if (file.size < HEADER_BYTES_NEEDED) {
    result.errors.push(
      `file too small (${file.size} bytes); not an ESP32 firmware image`,
    );
    return result;
  }

  let buf;
  try {
    buf = await file.slice(0, FILE_SLICE_BYTES).arrayBuffer();
  } catch (e) {
    result.errors.push(`could not read file: ${e.message ?? e}`);
    return result;
  }
  const view = new DataView(buf);

  /* 1. Image header magic byte. */
  const magic = view.getUint8(OFF_IMAGE_MAGIC);
  if (magic !== ESP_IMAGE_MAGIC) {
    result.errors.push(
      `not an ESP32 firmware image (first byte 0x${magic
        .toString(16)
        .padStart(2, "0")}, expected 0xE9)`,
    );
    return result;
  }

  /* 2. Chip ID — must match the device the user picked. */
  const chipId = view.getUint16(OFF_CHIP_ID, /* littleEndian */ true);
  result.chipId = chipId;
  result.chipLabel = chipIdName(chipId);
  if (chipId !== cfg.chipId) {
    result.errors.push(
      `chip mismatch: image targets ${chipIdName(chipId)} ` +
        `(0x${chipId.toString(16).padStart(4, "0")}), ` +
        `but ${cfg.label} requires ${cfg.chipLabel} ` +
        `(0x${cfg.chipId.toString(16).padStart(4, "0")}). ` +
        `[firmware would also reject with NARBIS_OTA_ERR_CHIP_MISMATCH=0x07]`,
    );
    /* fall through — also report project_name if we can */
  }

  /* 3. App descriptor magic word. */
  const appMagic = view.getUint32(OFF_APP_DESC_MAGIC, true);
  if (appMagic !== APP_DESC_MAGIC) {
    result.errors.push(
      `no ESP-IDF app descriptor at offset 0x20 ` +
        `(magic 0x${appMagic.toString(16).padStart(8, "0")}, ` +
        `expected 0xABCD5432); cannot verify project name`,
    );
    return result;
  }

  /* 4. Version + project_name strings. */
  result.version = readCString(view, OFF_APP_DESC_VERSION, APP_DESC_STR_LEN);
  result.projectName = readCString(view, OFF_APP_DESC_NAME, APP_DESC_STR_LEN);

  if (!result.projectName.startsWith(cfg.projectNamePrefix)) {
    result.errors.push(
      `project name "${result.projectName}" does not start with ` +
        `"${cfg.projectNamePrefix}" — image is not built for ${cfg.label}`,
    );
  }

  result.ok = result.errors.length === 0;
  return result;
}
