# Stage 10 — Dashboard: BLE connection and parsing

## Task

Web Bluetooth connection to the earclip and packet parsing.

## Prerequisites

Stage 09 complete. Earclip firmware Stage 06+ flashed (BLE services available).

## What to build

1. **`dashboard/src/ble/narbisDevice.ts`** — full earclip BLE wrapper:
   - `class NarbisDevice extends EventTarget`
   - `async connect()` — request device, GATT, discover services, set up notifications
   - `async disconnect()`
   - Events: connected, disconnected, beatReceived, rawSampleReceived, sqiReceived, batteryReceived, configChanged
   - `async writeConfig(config)`
   - Auto-reconnect with exponential backoff (max 30 sec)
   - MTU 247 negotiation

2. **`dashboard/src/ble/parsers.ts`** — binary parsers for:
   - `parseHeartRateMeasurement(data)` — standard HRS with R-R intervals
   - `parseNarbisIBI(data)` — single or batched
   - `parseRawPPG(data)` — chunked samples
   - `parseSQI(data)`
   - `parseBattery(data)`
   - `parseConfig(data)`
   - `serializeConfig(config)` — for writes
   - All matching layouts in `protocol/narbis_protocol.h`

3. **`dashboard/src/ble/polarH10.ts`** — H10 wrapper for reference:
   - Same interface where applicable
   - Subscribes to standard Heart Rate Measurement
   - Emits `beatReceived` events

4. **`dashboard/src/state/store.ts`** — populated:
   - Connection state for both earclip and H10
   - Live data buffers: rawSamples, beats, sqi, battery (ring buffers)
   - Current config
   - Connection error state

5. **`dashboard/src/state/streamBuffer.ts`**:
   - Fixed-capacity, time-windowed ring buffers
   - `push(timestamp, value)`, `getWindow(seconds)`

6. **`dashboard/src/components/ConnectionPanel.tsx`**:
   - "Connect Earclip" → `narbisDevice.connect()`
   - "Connect H10" → `polarH10.connect()`
   - Connection status indicators
   - Display name + battery
   - Disconnect buttons

7. **Temporary debug panel**:
   - Live counts: beats received, raw samples, SQI updates
   - Last beat: IBI, BPM, SQI, artifact flag
   - Battery level

## Implementation notes

- Web Bluetooth requires user gesture — Connect button click is the gesture
- `optionalServices` array in `requestDevice()` must include all UUIDs you'll discover
- DataView for binary parsing, little-endian
- Test on Chrome (most reliable)

## Success criteria

- Click Connect → BLE device picker
- Select Narbis Earclip → connection completes
- Beat counter increments at HR rate
- SQI values appear
- Battery displays
- H10 connects independently
- Disconnect doesn't crash
- Reconnect after firmware reboot works

## Do not

- Implement charts yet (Stage 11)
- Implement config UI yet (Stage 12)
- Add recording yet (Stage 13)

## When done

Report connection success rate, any reconnect edge cases, browser console errors (should be zero).
