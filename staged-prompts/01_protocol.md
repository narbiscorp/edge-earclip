# Stage 01 — Protocol definitions

## Task

Build the shared protocol definitions in `protocol/`. This is the foundation everything depends on.

## Read first

- `CLAUDE.md` (project root)

## What to build

Create the following files under `protocol/`:

1. **`protocol/narbis_protocol.h`** — single C header used by all firmware. Include:
   - Protocol version macro `NARBIS_PROTOCOL_VERSION = 1`
   - Conventions: little-endian, `__attribute__((packed))`, no `bool` (use uint8_t), no bit fields
   - ESP-NOW packet definitions:
     - `narbis_msg_type_t` enum: IBI, RAW_PPG, BATTERY, SQI, HEARTBEAT, CONFIG_ACK
     - `narbis_packet_t` struct with msg_type, device_id, seq_num, timestamp_ms, payload union, crc16
     - Per-message-type payload structs
   - BLE service UUIDs (use real generated 128-bit UUIDs)
   - BLE characteristic UUIDs for the Narbis custom service
   - `narbis_runtime_config_t` struct with all sensor / DSP / transport parameters from the design discussion
   - Transport mode enums: `narbis_transport_mode_t`, `narbis_ble_profile_t`, `narbis_data_format_t`
   - Beat event struct: `beat_event_t`
   - Heavy comments — every field explains its purpose, range, and units

2. **`protocol/narbis_protocol.c`** — minimal helpers:
   - CRC-16-CCITT-FALSE implementation
   - `narbis_packet_serialize()` and `narbis_packet_deserialize()`
   - `narbis_config_serialize()` and `narbis_config_deserialize()`

3. **`protocol/narbis_protocol.ts`** — TypeScript types matching the C structs exactly. Include:
   - Same enum values as C
   - Type-safe interface for each struct
   - DataView-based serialization helpers (since TS doesn't have packed structs)
   - Matching CRC-16 implementation

4. **`protocol/uuids.ts`** — exports the same BLE UUIDs as TypeScript constants

5. **`protocol/generate_uuids.py`** — small helper that generates random v4 UUIDs in both C macro format and TypeScript constant format. Use this once to populate the actual UUIDs in the header and TS file.

6. **`protocol/check_sync.py`** — verifies every struct in the C header has a matching TS interface and vice versa. Run before commits.

7. **`docs/protocol.md`** — human-readable spec describing each message type, characteristic, and config field.

## Success criteria

- C header parses cleanly (no syntax errors) — verify with `gcc -c -fsyntax-only protocol/narbis_protocol.c`
- TypeScript file passes `tsc --noEmit`
- `python protocol/check_sync.py` runs without error
- A small round-trip test (in `protocol/test/`) packs a packet in C, unpacks it in TS, and vice versa, with all fields preserved
- All UUIDs in C and TS are identical strings

## Do not

- Use floating-point in wire formats (use fixed-point integers like `freq_hz_x100`)
- Add encryption fields yet (v2)
- Add OTA-specific structs (Nordic DFU has its own protocol)
- Add platform-specific code

## When done

List every file created and confirm round-trip serialization works.
