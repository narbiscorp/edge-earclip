/*
 * uuids.ts — BLE UUID constants for the Narbis earclip.
 *
 * These MUST match the corresponding NARBIS_*_UUID_STR macros in
 * narbis_protocol.h byte-for-byte. Regenerate both blocks atomically
 * with `python protocol/generate_uuids.py` if you ever rotate them.
 *
 * Standard SIG services (used as-is, not redefined here):
 *   0x180D  Heart Rate Service
 *   0x180F  Battery Service
 *   0x180A  Device Information Service
 */

// Custom Narbis service (primary)
export const NARBIS_SVC_UUID = "a24080b2-8857-4785-b3ba-a43b66af4f28";

// IBI notify (per-beat or batched, depending on ble_profile)
export const NARBIS_CHR_IBI_UUID = "78ef492f-66be-438d-a91e-ddfdb441b7bb";

// SQI notify (signal quality indicator)
export const NARBIS_CHR_SQI_UUID = "2b614c61-bcdf-4a3f-a7e8-3b5a860c0347";

// Raw PPG notify (gated on data_format)
export const NARBIS_CHR_RAW_PPG_UUID = "6bacca91-7017-40fa-bb91-4ebf28a65a99";

// Custom battery notify (richer than standard 0x180F)
export const NARBIS_CHR_BATTERY_UUID = "b59d3ba1-78d1-4260-93c2-7e9e02329777";

// Current runtime config — read + notify
export const NARBIS_CHR_CONFIG_UUID = "553abc98-6406-4e37-b9fd-34df85b2b6c1";

// Config write (whole struct or single field)
export const NARBIS_CHR_CONFIG_WRITE_UUID = "129fbe56-cbd6-4f52-957b-d80834d6abf3";

// Mode write (3-axis: transport / ble_profile / data_format)
export const NARBIS_CHR_MODE_UUID = "71db6de8-5bff-480f-8db1-0d01c90d17d0";

// OTA service — Edge-compatible 16-bit UUIDs (ported from existing Edge
// firmware; see narbis_protocol.h). Three characteristics: control point,
// data packets, status notifications. Page-based CRC32 transfer protocol.
export const NARBIS_OTA_SVC_UUID16         = 0x00ff;
export const NARBIS_OTA_CHR_CONTROL_UUID16 = 0xff01;
export const NARBIS_OTA_CHR_DATA_UUID16    = 0xff02;
export const NARBIS_OTA_CHR_STATUS_UUID16  = 0xff03;

// Diagnostics notify (free heap, uptime, RSSI, etc.)
export const NARBIS_CHR_DIAGNOSTICS_UUID = "31d99572-bf8a-4658-828e-4f7c138ca722";
