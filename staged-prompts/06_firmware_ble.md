# Stage 06 — Firmware: BLE GATT services

## Task

Implement BLE GATT server with standard Heart Rate Service + Battery + Device Information + custom Narbis service.

## Prerequisites

Stage 05 complete. ESP-NOW works.

## What to build

1. **`firmware/main/transport_ble.c/h`** — top-level BLE:
   - NimBLE host init
   - Register all four services
   - Advertising name: "Narbis Earclip <last-3-bytes-of-MAC>"
   - MTU negotiation (request 247)
   - Connection event handlers
   - API:
     - `ble_transport_init()`
     - `ble_transport_set_profile(profile)` — BATCHED or LOW_LATENCY
     - `ble_transport_send_beat(beat)`
     - `ble_transport_send_raw_sample(sample)`

2. **`firmware/main/ble_service_hrs.c/h`** — Heart Rate Service (0x180D):
   - Heart Rate Measurement (0x2A37) notify
   - Format: flags + uint8/uint16 BPM + R-R intervals (1/1024 sec units)
   - Body Sensor Location (0x2A38) read = 0x05 (Ear)

3. **`firmware/main/ble_service_battery.c/h`** — Battery Service (0x180F):
   - Battery Level (0x2A19) read + notify

4. **`firmware/main/ble_service_dis.c/h`** — Device Information Service (0x180A):
   - Manufacturer: "Narbis Inc."
   - Model: "Earclip-001"
   - Hardware: "C6_proto_rev1"
   - Firmware: from build version string
   - Serial: device MAC

5. **`firmware/main/ble_service_narbis.c/h`** — custom service (UUID from protocol):
   - Mode Config (read/write) — `narbis_runtime_config_t` serialized
   - IBI Stream (notify) — beat events with SQI
   - Raw PPG Stream (notify) — raw samples (when data_format includes raw)
   - SQI Stream (notify) — periodic SQI updates
   - Diagnostic Streams (notify) — controlled by diag_streams_enabled bitmask
   - ESP-NOW Pairing (write only) — accepts 6-byte MAC, calls `espnow_transport_set_partner()`
   - Factory Reset (write only) — wipes NVS pairing

6. **Profile-aware notify scheduling**:
   - BATCHED: ring buffer of beats, flush every config.ble_batch_interval_ms
   - LOW_LATENCY: notify on each beat
   - Raw samples: chunk into MTU-sized notifications when subscribed

7. **Update main.c**:
   - On beat: send via ESP-NOW always; send via BLE if HYBRID and a client is subscribed
   - On raw sample: send via BLE only if data_format requires it AND subscribed
   - Update battery service every 30 seconds

## Implementation notes

- Slave latency: 4 for BATCHED, 0 for LOW_LATENCY
- Connection interval: 50–100ms BATCHED, 15–30ms LOW_LATENCY
- ESP-NOW + BLE coexistence: trust ESP-IDF coex layer (already enabled in sdkconfig)

## Success criteria

- nRF Connect (or LightBlue) on phone:
  1. Scans, finds "Narbis Earclip"
  2. Connects, MTU 247
  3. Standard Heart Rate Service shows live HR
  4. Custom service is enumerable, characteristics visible
  5. Writing Mode Config changes behavior live
  6. Subscribing to Raw PPG shows continuous data in RAW_PPG mode
  7. Disconnect/reconnect works without firmware restart
- ESP-NOW continues to work simultaneously in HYBRID mode

## Do not

- Skip MTU negotiation
- Use indications when notifications work
- Add bonding (v2)
- Add OTA characteristic yet (Stage 08)

## When done

Report BLE throughput in raw streaming mode, notification latency in LOW_LATENCY mode, any coexistence issues.
