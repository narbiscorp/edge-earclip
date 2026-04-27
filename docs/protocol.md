# Narbis earclip protocol

Single source of truth for the wire format and BLE surface of the Narbis earclip. The C definitions live in `protocol/narbis_protocol.h`; the TypeScript mirror is `protocol/narbis_protocol.ts`. `protocol/check_sync.py` keeps the two languages from drifting; `protocol/test/roundtrip.c` and `protocol/test/roundtrip.ts` jointly verify byte-level compatibility.

## Conventions

- All multi-byte integers are **little-endian**.
- All wire structs use `__attribute__((packed))`.
- No floating-point on the wire; fixed-point integers (`*_x10`, `*_x100`, `*_x1000`).
- No `bool`; use `uint8_t` (0 / 1).
- No bit fields; use bitmask `#define`s over `uint8_t` / `uint16_t`.
- No encryption / signing fields (deferred to v2).
- `NARBIS_PROTOCOL_VERSION = 1`.

## ESP-NOW frame

```
+----------------+------------------------+----------------+
| header (12 B)  | payload (payload_len)  | crc16 (2 B LE) |
+----------------+------------------------+----------------+
```

Total frame ≤ 250 B (ESP-NOW max). Overhead (header + CRC) = 14 B → up to 236 B of payload. CRC-16-CCITT-FALSE (`poly=0x1021`, `init=0xFFFF`, no reflect, no xor-out) computed over the header and payload; the CRC field itself is not included in its own input.

### Header (12 bytes)

| offset | size | name | notes |
|---:|---:|---|---|
| 0 | 1 | `msg_type` | `narbis_msg_type_t` |
| 1 | 1 | `device_id` | per-earclip ID, 0 = unset |
| 2 | 2 | `seq_num` | per-(device, msg_type) monotonic counter |
| 4 | 4 | `timestamp_ms` | earclip-local ms, free-running |
| 8 | 2 | `payload_len` | bytes of payload following this header |
| 10 | 1 | `protocol_version` | must equal `NARBIS_PROTOCOL_VERSION` |
| 11 | 1 | `reserved` | must be 0 |

## Message types

`narbis_msg_type_t` values are stable on the wire — never renumbered.

| value | name | direction | payload size |
|---:|---|---|---|
| 0x01 | `IBI` | earclip → host | 4 B |
| 0x02 | `RAW_PPG` | earclip → host | 4 B + 8·N (N ≤ 29) |
| 0x03 | `BATTERY` | earclip → host | 4 B |
| 0x04 | `SQI` | earclip → host | 12 B |
| 0x05 | `HEARTBEAT` | earclip → host | 12 B |
| 0x06 | `CONFIG_ACK` | earclip → host | 4 B |

### IBI payload (4 B)

| offset | size | field | units / range |
|---:|---:|---|---|
| 0 | 2 | `ibi_ms` | inter-beat interval, ms (300–2000 typ.) |
| 2 | 1 | `confidence_x100` | 0–100 → 0.00–1.00 |
| 3 | 1 | `flags` | `NARBIS_BEAT_FLAG_*` bitmask |

Beat-flag bits: `ARTIFACT=0x01`, `LOW_SQI=0x02`, `INTERPOLATED=0x04`, `LOW_CONFIDENCE=0x08`.

### RAW_PPG payload (variable)

| offset | size | field |
|---:|---:|---|
| 0 | 2 | `sample_rate_hz` |
| 2 | 2 | `n_samples` (≤ `NARBIS_RAW_PPG_MAX_SAMPLES = 29`) |
| 4 | 8·N | `samples[N]`: `{red:u32, ir:u32}` |

Frame budget: 12 (header) + 4 (raw header) + 29·8 (samples) + 2 (CRC) = 250 B exactly.

### BATTERY payload (4 B)

| offset | size | field | notes |
|---:|---:|---|---|
| 0 | 2 | `mv` | battery voltage (mV) |
| 2 | 1 | `soc_pct` | 0–100 |
| 3 | 1 | `charging` | 0 = idle, 1 = charging |

### SQI payload (12 B)

| offset | size | field |
|---:|---:|---|
| 0 | 2 | `sqi_x100` |
| 2 | 4 | `dc_red` |
| 6 | 4 | `dc_ir` |
| 10 | 2 | `perfusion_idx_x1000` |

### HEARTBEAT payload (12 B)

| offset | size | field |
|---:|---:|---|
| 0 | 4 | `uptime_s` |
| 4 | 4 | `free_heap` |
| 8 | 1 | `rssi_dbm` (signed) |
| 9 | 1 | `mode_byte` |
| 10 | 2 | `reserved` (= 0) |

`mode_byte` packs the three mode enums:

```
bits 0–1: transport_mode    (0 EDGE_ONLY, 1 HYBRID)
bits 2–3: ble_profile       (0 BATCHED,   1 LOW_LATENCY)
bits 4–5: data_format       (0 IBI_ONLY,  1 RAW_PPG, 2 IBI_PLUS_RAW)
bits 6–7: reserved          (= 0)
```

### CONFIG_ACK payload (4 B)

| offset | size | field | notes |
|---:|---:|---|---|
| 0 | 2 | `config_version` | echo of `narbis_runtime_config_t.config_version` after write |
| 2 | 1 | `status` | `narbis_config_ack_status_t` |
| 3 | 1 | `field_id` | offset in bytes of the field, or 0xFF for whole-struct |

`status`: `OK=0`, `RANGE_ERROR=1`, `UNKNOWN_FIELD=2`, `REQUIRES_REBOOT=3`.

## Internal: `beat_event_t`

Emitted by `beat_validator`, consumed by transport tasks. **Not serialized to the wire.** Carries extra context (peak amplitude, sample index for raw-PPG cross-reference) that doesn't survive the IBI conversion.

```
beat_event_t {
    uint32_t timestamp_ms;
    uint16_t ibi_ms;
    uint16_t prev_ibi_ms;
    uint8_t  confidence_x100;
    uint8_t  flags;
    uint16_t peak_amplitude;
    uint32_t sample_index;
}
```

## Runtime config

`narbis_runtime_config_t` (56 B packed) is persisted to NVS and writable via the BLE config-write characteristic. With the exception of `sample_rate_hz`, all fields apply at runtime without a reboot.

| field | type | default | notes |
|---|---|---:|---|
| `config_version` | u16 | 1 | NVS migration marker |
| `sample_rate_hz` | u16 | 200 | 50 / 100 / 200 / 400; reboot to apply |
| `led_red_ma_x10` | u16 | 70 | red LED current ×10 |
| `led_ir_ma_x10` | u16 | 70 | IR LED current ×10 |
| `agc_enabled` | u8 | 1 | 0 / 1 |
| `reserved_agc` | u8 | 0 | pad |
| `agc_update_period_ms` | u16 | 200 | AGC re-evaluation interval |
| `agc_target_dc_min` | u32 | — | lower DC target (ADC counts) |
| `agc_target_dc_max` | u32 | — | upper DC target (ADC counts) |
| `agc_step_ma_x10` | u16 | 5 | per-update LED current step ×10 |
| `bandpass_low_hz_x100` | u16 | 50 | 0.50 Hz |
| `bandpass_high_hz_x100` | u16 | 800 | 8.00 Hz |
| `elgendi_w1_ms` | u16 | 111 | systolic peak window |
| `elgendi_w2_ms` | u16 | 667 | beat window |
| `elgendi_beta_x1000` | u16 | 20 | offset coefficient ×1000 |
| `sqi_threshold_x100` | u16 | 50 | min SQI to emit IBI |
| `ibi_min_ms` | u16 | 300 | validator floor (≈200 BPM) |
| `ibi_max_ms` | u16 | 2000 | validator ceiling (≈30 BPM) |
| `ibi_max_delta_pct` | u8 | 30 | continuity threshold |
| `transport_mode` | u8 | 0 | `narbis_transport_mode_t` |
| `ble_profile` | u8 | 0 | `narbis_ble_profile_t` |
| `data_format` | u8 | 0 | `narbis_data_format_t` |
| `ble_batch_period_ms` | u16 | 500 | BATCHED mode flush interval |
| `partner_mac[6]` | u8[6] | 00:00:00:00:00:00 | ESP-NOW peer; all-zero = use Kconfig fallback |
| `espnow_channel` | u8 | 1 | 1–13 |
| `diagnostics_enabled` | u8 | 0 | 0 / 1 |
| `light_sleep_enabled` | u8 | 1 | 0 / 1 |
| `reserved_pwr` | u8 | 0 | pad |
| `battery_low_mv` | u16 | 3300 | low-battery threshold |

The config is serialized as the packed struct followed by a 16-bit CRC (same algorithm as packets) for a total wire size of 58 bytes.

## BLE surface

### Standard SIG services (used as-is)

| UUID | service |
|---|---|
| `0x180D` | Heart Rate Service |
| `0x180F` | Battery Service |
| `0x180A` | Device Information Service |

### Custom Narbis service

Primary service UUID and characteristic UUIDs are 128-bit, generated once by `protocol/generate_uuids.py`. See `protocol/uuids.ts` and the `NARBIS_*_UUID_*` macros in `protocol/narbis_protocol.h` for the canonical values.

| characteristic | properties | payload |
|---|---|---|
| `NARBIS_CHR_IBI` | notify | `narbis_ibi_payload_t` (per-beat or batched, see `ble_profile`) |
| `NARBIS_CHR_SQI` | notify | `narbis_sqi_payload_t` |
| `NARBIS_CHR_RAW_PPG` | notify | `narbis_raw_ppg_payload_t` (gated on `data_format`) |
| `NARBIS_CHR_BATTERY` | notify | `narbis_battery_payload_t` (richer than 0x180F) |
| `NARBIS_CHR_CONFIG` | read, notify | `narbis_runtime_config_t` + CRC16 |
| `NARBIS_CHR_CONFIG_WRITE` | write | whole `narbis_runtime_config_t` + CRC16, or `{u8 field_id, raw_field_bytes}` for single-field writes |
| `NARBIS_CHR_MODE` | write | `{u8 transport_mode, u8 ble_profile, u8 data_format}` |
| `NARBIS_CHR_OTA_CONTROL` | write | Nordic-style DFU; payload format owned by Stage 08 |
| `NARBIS_CHR_DIAGNOSTICS` | notify | `narbis_heartbeat_payload_t` (same struct as ESP-NOW heartbeat) |

## Verification

Run all of these before committing protocol changes. They're also the success criteria for Stage 01.

```
# 1. C compiles cleanly
gcc -c -fsyntax-only -Wall -Wextra protocol/narbis_protocol.c

# 2. C round-trip — also produces protocol/test/golden_packets.txt
cd protocol/test && mingw32-make test   # use `make test` on macOS/Linux

# 3. Drift checker
python protocol/check_sync.py

# 4. TypeScript type check
npx --yes -p typescript@5 tsc --noEmit \
  --strict --target es2020 --module nodenext --moduleResolution nodenext \
  protocol/narbis_protocol.ts protocol/uuids.ts

# 5. TypeScript round-trip (consumes golden_packets.txt from step 2)
npx --yes -p tsx@4 tsx protocol/test/roundtrip.ts
```

Steps 4 and 5 require Node.js LTS. Install via `winget install OpenJS.NodeJS.LTS` on Windows; if Node is already installed but not on PATH, add `C:\Program Files\nodejs` to PATH or open a fresh shell.
