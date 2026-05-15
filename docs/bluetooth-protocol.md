# Narbis Bluetooth Protocol — iOS / Apple Watch Integration Guide

> **Audience.** Engineers building iOS 13+ and watchOS 6+ apps that talk to the **Narbis Edge** glasses and the **Narbis Earclip** over BLE using Apple's Core Bluetooth framework.
>
> **Scope.** Scanning, connecting, GATT discovery, command writes, notification parsing, OTA firmware update, troubleshooting. Includes Swift snippets you can paste into a project.
>
> **Out of scope.** HRV math (compute on the client), pairing/bonding (neither device requires encryption today; that's a v2 item).
>
> **Related.** [`docs/protocol.md`](./protocol.md) is historical background; [`docs/path-b-implementation-brief.md`](./path-b-implementation-brief.md) and [`docs/path-b-relay-handoff.md`](./path-b-relay-handoff.md) document the current relay architecture in detail.

> ### 🆕 Path B (config_version 3) — read this first
>
> The architecture changed substantially in 2025. Important consequences for iOS:
>
> - **ESP-NOW is gone.** The earclip is BLE-only. Wi-Fi is no longer brought up.
> - **The Edge is now dual-role.** It is still a BLE peripheral (talks to your iOS app on `0x00FF`) **and** is now also a BLE central that connects to the earclip and **relays** earclip data through to you on the same `0x00FF` service via four new frame types (`0xF4`–`0xF7`). See [§4.6](#46-the-edge-as-relay-path-b).
> - **The earclip is multi-central.** Your iOS app and the Edge can be connected to it simultaneously. Each central writes its role on connect to a new **PEER_ROLE characteristic** (see [§3.7](#37-peer_role--e987719a)) so the earclip knows which conn-update profile to apply.
> - **Mode is now 2-axis.** The old `transport_mode` field is gone — only `ble_profile` and `data_format` remain. `narbis_runtime_config_t` shrank from 56 to **48 bytes** (50 B on the wire including CRC).
> - **New Edge opcodes** `0xC1` (forget earclip), `0xC3` (relay config write to earclip), `0xC4` (toggle raw-PPG relay) — see [§4.3](#43-control-characteristic-0xff01--command-opcodes).
>
> **Two valid integration patterns** for an iOS app:
> 1. **Direct, two-connection** — connect to both the earclip and the Edge separately. Best if you want raw earclip data with no extra hop.
> 2. **Single-connection via Edge** — connect only to the Edge; receive relayed earclip IBI/battery/config/raw/diagnostics on `0xFF03` frames `0xF4`–`0xFA`. Simpler from a CoreBluetooth state-management standpoint.

---

## Table of contents

1. [The two devices at a glance](#1-the-two-devices-at-a-glance)
2. [Scanning & connecting](#2-scanning--connecting)
3. [Earclip BLE — full reference](#3-earclip-ble--full-reference) (incl. 🆕 [§3.7 PEER_ROLE](#37-peer_role--e987719a))
4. [Edge glasses BLE — full reference](#4-edge-glasses-ble--full-reference) (incl. 🆕 [§4.6 The Edge as relay](#46-the-edge-as-relay-path-b))
5. [Configuring the earclip from iOS](#5-configuring-the-earclip-from-ios)
6. [OTA — shared between both devices](#6-ota--shared-between-both-devices)
7. [iOS / Core Bluetooth gotchas](#7-ios--core-bluetooth-gotchas)
8. [Troubleshooting matrix](#8-troubleshooting-matrix)
9. [Reference data](#9-reference-data)

---

## 1. The two devices at a glance

| Aspect | Narbis Edge (glasses) | Narbis Earclip |
|---|---|---|
| Advertised name | `Narbis_Edge` (exact match) | `Narbis Earclip <mac>` (prefix match) |
| MCU | ESP32 classic | ESP32-C6 |
| BLE stack | Bluedroid | NimBLE |
| BLE roles | **peripheral + central** (Path B: connects to earclip itself) | peripheral, **multi-central** (up to 3 simultaneous) |
| Custom primary service | none advertised | `a24080b2-8857-4785-b3ba-a43b66af4f28` (128-bit) |
| Standard SIG services | none | HRS `0x180D`, Battery `0x180F`, DIS `0x180A` |
| OTA service UUID | `0x00FF` (chars `0xFF01`–`0xFF04`) | `0x00FF` (chars `0xFF01`–`0xFF03`) |
| Encryption / bonding | none | none |
| Negotiated MTU | requests 517 | requests 247 |
| Connection interval (typical) | 20–30 ms, slave latency 1, 20 s timeout | per-central, picked from the role byte: DASHBOARD → LOW_LATENCY (15–30 ms), GLASSES → BATCHED (50–100 ms) |
| Earclip ↔ Edge link | **BLE central role** (Edge is the central; earclip is peripheral). ESP-NOW removed in Path B. | Same — earclip is the peripheral |

> ### ⚠️ Critical gotcha — UUID collision
>
> Both devices expose **service UUID `0x00FF`** but with **different characteristic sets**:
> - **Earclip** uses `0x00FF` purely for OTA: `0xFF01` Control, `0xFF02` Data, `0xFF03` Status.
> - **Edge** uses `0x00FF` for everything: `0xFF01` Control & all commands, `0xFF02` OTA Data, `0xFF03` Status & log/coherence/health notifications, `0xFF04` PPG stream.
>
> **Always disambiguate by advertised name.** Do not assume device type from `0x00FF` alone, and do not pass `0x00FF` to `scanForPeripherals(withServices:)` expecting it to filter usefully — it will match both devices, and on iOS some advertisements omit the service UUID entirely.

---

## 2. Scanning & connecting

### 2.1 Project setup

Add to your `Info.plist`:

```xml
<key>NSBluetoothAlwaysUsageDescription</key>
<string>Narbis uses Bluetooth to connect to your glasses and earclip.</string>
```

### 2.2 Central manager

```swift
import CoreBluetooth

final class NarbisCentral: NSObject, CBCentralManagerDelegate {
    private(set) var central: CBCentralManager!
    private(set) var edge: CBPeripheral?
    private(set) var earclip: CBPeripheral?

    override init() {
        super.init()
        // Pass a restoreIdentifier if you want background-state restoration.
        central = CBCentralManager(delegate: self, queue: nil, options: nil)
    }

    func centralManagerDidUpdateState(_ c: CBCentralManager) {
        guard c.state == .poweredOn else { return }
        // Pass nil so we see *every* peripheral; we filter by name below.
        c.scanForPeripherals(withServices: nil, options: [
            CBCentralManagerScanOptionAllowDuplicatesKey: false
        ])
    }

    func centralManager(_ c: CBCentralManager,
                        didDiscover p: CBPeripheral,
                        advertisementData ad: [String: Any],
                        rssi: NSNumber) {
        let name = p.name ?? (ad[CBAdvertisementDataLocalNameKey] as? String) ?? ""

        if name == "Narbis_Edge" && edge == nil {
            edge = p
            c.connect(p, options: [
                CBConnectPeripheralOptionNotifyOnDisconnectionKey: true
            ])
        } else if name.hasPrefix("Narbis Earclip") && earclip == nil {
            earclip = p
            c.connect(p, options: [
                CBConnectPeripheralOptionNotifyOnDisconnectionKey: true
            ])
        }

        if edge != nil && earclip != nil { c.stopScan() }
    }
}
```

### 2.3 Discovery

After `centralManager(_:didConnect:)` fires, call `discoverServices(nil)`. Both devices have small GATT tables — just discover everything.

```swift
func centralManager(_ c: CBCentralManager, didConnect p: CBPeripheral) {
    p.delegate = self
    p.discoverServices(nil)   // small GATT, just grab it all
}

func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
    p.services?.forEach { p.discoverCharacteristics(nil, for: $0) }
}
```

### 2.4 MTU — check it after discovery, not before

```swift
let writeNoRespMax = peripheral.maximumWriteValueLength(for: .withoutResponse)
let writeWithRespMax = peripheral.maximumWriteValueLength(for: .withResponse)
```

This value is final only **after** services are discovered. The Edge requests an ATT MTU of 517 and the earclip requests 247, but iOS may cap lower — read the actual value before you start chunking OTA pages.

### 2.5 Reconnection

Both devices auto-resume advertising on disconnect. From your `centralManager(_:didDisconnectPeripheral:error:)` delegate, just call `central.connect(peripheral, options: ...)` again.

> **Edge-only quirk:** the glasses tear down their advertising entirely after **5 minutes** with no client connected. The user has to wake the device (magnet tap on the temple) to start advertising again. Surface this in your UX rather than silently retrying forever.

---

## 3. Earclip BLE — full reference

The earclip exposes four services: one custom Narbis service with eight characteristics, and three standard SIG services (Heart Rate, Battery, Device Information). OTA is covered separately in [§6](#6-ota--shared-between-both-devices).

All multi-byte fields are **little-endian on the wire**. Structs are byte-packed (no padding).

### 3.1 Custom Narbis service — `a24080b2-8857-4785-b3ba-a43b66af4f28`

The single best filter for "this is an earclip" is the presence of this 128-bit service after connect. Every dashboard data path uses one of its characteristics.

| Characteristic | UUID | Properties | Wire size | Notes |
|---|---|---|---|---|
| IBI | `78ef492f-66be-438d-a91e-ddfdb441b7bb` | notify | 4 B | One inter-beat interval |
| SQI | `2b614c61-bcdf-4a3f-a7e8-3b5a860c0347` | notify | 12 B | Signal-quality summary |
| RAW_PPG | `6bacca91-7017-40fa-bb91-4ebf28a65a99` | notify | 4 + 8·N B (N ≤ 29) | Sample batch |
| BATTERY | `b59d3ba1-78d1-4260-93c2-7e9e02329777` | notify | 4 B | Richer than `0x2A19` |
| CONFIG | `553abc98-6406-4e37-b9fd-34df85b2b6c1` | read + notify | **50 B** | Config + 16-bit CRC (Path B: was 58 B) |
| CONFIG_WRITE | `129fbe56-cbd6-4f52-957b-d80834d6abf3` | write | **50 B** | Config + 16-bit CRC |
| MODE | `71db6de8-5bff-480f-8db1-0d01c90d17d0` | write | **2 B** | Quick mode swap (legacy 3-B form still accepted, first byte ignored) |
| **PEER_ROLE** | `e987719a-26a6-48d4-b8e9-128994e62e6c` | write | 1 B | **🆕 Path B.** Central announces its role; earclip picks the conn-update profile. See [§3.7](#37-peer_role--e987719a) |
| DIAGNOSTICS | `31d99572-bf8a-4658-828e-4f7c138ca722` | notify | variable | Optional debug stream |

#### 3.1.1 IBI — `78ef492f-…`

| Offset | Size | Field | Type | Notes |
|---|---|---|---|---|
| 0 | 2 | `ibi_ms` | u16 LE | Inter-beat interval; typical 300–2000 ms |
| 2 | 1 | `confidence_x100` | u8 | 0–100 → 0.00–1.00 |
| 3 | 1 | `flags` | u8 | bitmask (below) |

Flag bits:

```
0x01  ARTIFACT          beat is suspect
0x02  LOW_SQI           SQI below configured threshold at this beat
0x04  INTERPOLATED      filled in by validator (rare)
0x08  LOW_CONFIDENCE    confidence_x100 < 50
```

Notify cadence depends on the `ble_profile` config field:
- **`LOW_LATENCY` (1)** — one notification per beat (~1 Hz at rest).
- **`BATCHED` (0)** — accumulated then flushed every `ble_batch_period_ms` (default 500 ms).

```swift
struct NarbisIBI {
    let ibiMs: UInt16
    let confidence: UInt8   // 0…100
    let flags: UInt8

    init?(_ data: Data) {
        guard data.count == 4 else { return nil }
        ibiMs      = UInt16(data[0]) | (UInt16(data[1]) << 8)
        confidence = data[2]
        flags      = data[3]
    }

    var bpm: Double { 60_000.0 / Double(ibiMs) }
}
```

#### 3.1.2 SQI — `2b614c61-…`

| Offset | Size | Field | Type | Notes |
|---|---|---|---|---|
| 0 | 2 | `sqi_x100` | u16 LE | 0–100 → 0.00–1.00 |
| 2 | 4 | `dc_red` | u32 LE | Red-channel DC level, ADC counts |
| 6 | 4 | `dc_ir` | u32 LE | IR-channel DC level, ADC counts |
| 10 | 2 | `perfusion_idx_x1000` | u16 LE | Perfusion index × 1000 |

Useful as a "is the earclip on the ear and well-coupled?" indicator. Below `sqi_x100 < 30` you should warn the user.

#### 3.1.3 RAW_PPG — `6bacca91-…`

Variable-length notification, gated on the `data_format` config field (see [§3.5](#35-the-3-axis-mode-model)). The earclip emits this only when `data_format` is `RAW_PPG (1)` or `IBI_PLUS_RAW (2)`.

Header (4 B):

| Offset | Size | Field | Type |
|---|---|---|---|
| 0 | 2 | `sample_rate_hz` | u16 LE |
| 2 | 2 | `n_samples` | u16 LE (≤ 29) |

Then `n_samples` × 8 B:

| Offset | Size | Field | Type |
|---|---|---|---|
| +0 | 4 | `red` | u32 LE (ADC counts) |
| +4 | 4 | `ir` | u32 LE (ADC counts) |

Maximum payload: 4 + 29·8 = **236 B**. Fits inside the negotiated 247-B MTU comfortably.

```swift
struct NarbisRawSample { let red: UInt32; let ir: UInt32 }

struct NarbisRawPPG {
    let sampleRateHz: UInt16
    let samples: [NarbisRawSample]

    init?(_ data: Data) {
        guard data.count >= 4 else { return nil }
        sampleRateHz = UInt16(data[0]) | (UInt16(data[1]) << 8)
        let n = Int(UInt16(data[2]) | (UInt16(data[3]) << 8))
        guard n <= 29, data.count == 4 + n * 8 else { return nil }
        samples = (0..<n).map { i in
            let off = 4 + i * 8
            let red = data.subdata(in: off..<off+4).withUnsafeBytes { $0.load(as: UInt32.self) }
            let ir  = data.subdata(in: off+4..<off+8).withUnsafeBytes { $0.load(as: UInt32.self) }
            return NarbisRawSample(red: red, ir: ir)
        }
    }
}
```

#### 3.1.4 BATTERY — `b59d3ba1-…`

| Offset | Size | Field | Type | Notes |
|---|---|---|---|---|
| 0 | 2 | `mv` | u16 LE | Battery voltage in millivolts |
| 2 | 1 | `soc_pct` | u8 | 0–100 |
| 3 | 1 | `charging` | u8 | 0 = not charging, 1 = charging |

Use this rather than the standard `0x2A19` if you want the millivolts and charging-state bits.

#### 3.1.5 CONFIG — `553abc98-…`

Read or subscribe to this to get the full live `narbis_runtime_config_t`. Wire layout is the **48-byte** packed struct followed by a 2-byte CRC-16-CCITT-FALSE (poly `0x1021`, init `0xFFFF`, no reflect, no xor-out) for a total of **50 B** (`NARBIS_CONFIG_WIRE_SIZE`).

> **Path B note:** the struct shrank from 56 B to 48 B in `config_version 3` because `transport_mode`, `partner_mac[6]`, and `espnow_channel` were removed when ESP-NOW was deleted.

The struct field-by-field is in [§3.6](#36-the-runtime-config-struct).

The earclip notifies on this characteristic **after every successful CONFIG_WRITE or MODE write** so subscribed clients see fresh config without polling.

#### 3.1.6 CONFIG_WRITE — `129fbe56-…`

Write 50 B (full 48-B config + 2-B CRC) to apply settings. The firmware validates ranges, applies in place, persists to NVS, then notifies on the CONFIG characteristic.

If the CRC is bad or any field is out of range the firmware returns a BLE ATT error code on the write — your `peripheral(_:didWriteValueFor:error:)` callback will receive a non-nil `error`.

End-to-end Swift example is in [§5](#5-configuring-the-earclip-from-ios).

#### 3.1.7 MODE — `71db6de8-…`

Cheap 2-byte write to swap the two mode axes without touching the rest of the config.

| Offset | Size | Field | Type |
|---|---|---|---|
| 0 | 1 | `ble_profile` | `0` BATCHED, `1` LOW_LATENCY |
| 1 | 1 | `data_format` | `0` IBI_ONLY, `1` RAW_PPG, `2` IBI_PLUS_RAW |

```swift
func setLiveLowLatencyIBI(on p: CBPeripheral, mode chr: CBCharacteristic) {
    let bytes: [UInt8] = [/*LOW_LATENCY*/ 1, /*IBI_ONLY*/ 0]
    p.writeValue(Data(bytes), for: chr, type: .withResponse)
}
```

> **Legacy compatibility.** The earclip still accepts a 3-byte write (the old `[transport_mode, ble_profile, data_format]` form) but ignores the first byte. New clients should write 2 bytes.

#### 3.1.8 DIAGNOSTICS — `31d99572-…`

Optional debug stream gated by the master `diagnostics_enabled` flag and the `diagnostics_mask` bitmask in the runtime config. Frame format:

```
[seq:u16 LE][n:u8] then n × [stream_id:u8, len:u8, payload:len B]
```

Stream IDs:

```
0x01  PRE_FILTER     raw DC-removed PPG samples
0x02  POST_FILTER    bandpass-filtered samples
0x04  PEAK_CAND      Elgendi peak candidates pre-validator
0x08  AGC_EVENT      per-AGC-step LED current changes
0x10  FIFO_OCCUP     MAX3010x FIFO occupancy
```

Skip this characteristic unless you're building a tuning UI.

### 3.7 PEER_ROLE — `e987719a-26a6-48d4-b8e9-128994e62e6c`

🆕 **New in Path B.** A 1-byte write characteristic. Each connecting central writes its role on connect, and the earclip uses that single byte to pick the BLE conn-update profile for *that specific connection*.

| Value | Symbol | Profile applied |
|---|---|---|
| `0` | UNKNOWN | (no change — earclip uses its compiled default) |
| `1` | DASHBOARD | `LOW_LATENCY` — 15–30 ms interval, latency 0, notify every beat. **Use this from your iOS / watchOS app.** |
| `2` | GLASSES | `BATCHED` — 50–100 ms interval, latency 4, batched notifies. The Edge uses this when it connects as a central. |

The role write is **not persisted** by the earclip — every central must re-announce on every connect.

```swift
// Right after services are discovered, write your role *first*.
let role: UInt8 = 1   // DASHBOARD
peripheral.writeValue(Data([role]), for: chPeerRole, type: .withResponse)
```

> Why it matters: on a multi-central earclip (you + the Edge), you want one set of conn parameters tuned for live UI updates and a different set tuned for power-efficient relay. PEER_ROLE lets each peer get its own profile rather than fighting over a single global setting.

### 3.2 Heart Rate Service — `0x180D`

Standard SIG implementation; works with any off-the-shelf HRM library.

| Characteristic | UUID | Properties | Notes |
|---|---|---|---|
| Heart Rate Measurement | `0x2A37` | notify + read | SIG flags + BPM + R-R intervals |
| Body Sensor Location | `0x2A38` | read | Returns `0x05` (Ear) |

#### Heart Rate Measurement format

```
[flags:u8]
[bpm:u8 or u16 — depending on flag bit 0]
[energy_expended:u16]?  if flag bit 3 set
[rr_interval:u16]…      if flag bit 4 set; one or more, units = 1/1024 s
```

Flag bits:

```
bit 0  HR value format: 0 = u8, 1 = u16
bit 1–2  sensor contact state
bit 3  energy expended present
bit 4  R-R interval(s) present
```

The earclip emits BPM as `u8` and includes one or more R-R intervals. R-R intervals are in **1/1024-second units**, so convert to milliseconds with `rr_ms = rr_raw * 1000 / 1024`.

In `LOW_LATENCY` profile you see one notification per beat with one R-R interval. In `BATCHED` profile you see one notification every `ble_batch_period_ms` carrying up to 9 R-R intervals.

```swift
struct HRMeasurement {
    let bpm: Int
    let rrMs: [Int]

    init?(_ data: Data) {
        guard data.count >= 2 else { return nil }
        let flags = data[0]
        let isU16 = (flags & 0x01) != 0
        var i = 1
        if isU16 {
            guard data.count >= 3 else { return nil }
            bpm = Int(UInt16(data[1]) | (UInt16(data[2]) << 8))
            i = 3
        } else {
            bpm = Int(data[1])
            i = 2
        }
        if (flags & 0x08) != 0 { i += 2 }   // skip energy expended
        var rr: [Int] = []
        if (flags & 0x10) != 0 {
            while i + 1 < data.count {
                let raw = Int(UInt16(data[i]) | (UInt16(data[i+1]) << 8))
                rr.append(raw * 1000 / 1024)
                i += 2
            }
        }
        rrMs = rr
    }
}
```

### 3.3 Battery Service — `0x180F`

| Characteristic | UUID | Properties | Notes |
|---|---|---|---|
| Battery Level | `0x2A19` | read + notify | Single `u8` percent (0–100) |

If you want voltage and charging state, prefer the custom Narbis BATTERY characteristic ([§3.1.4](#314-battery--b59d3ba1)).

### 3.4 Device Information Service — `0x180A`

All read-only strings.

| Characteristic | UUID | Value |
|---|---|---|
| Manufacturer Name | `0x2A29` | `Narbis Inc.` |
| Model Number | `0x2A24` | `Earclip-001` |
| Hardware Revision | `0x2A27` | `C6_proto_rev1` |
| Firmware Revision | `0x2A26` | populated from app descriptor at boot, e.g. `1.0.3` |
| Serial Number | `0x2A25` | BLE MAC in hex, e.g. `A1B2C3D4E5F6` |

Read the firmware revision before doing OTA so you can decide whether the user is already up-to-date.

### 3.5 The 2-axis mode model (post Path B)

Two orthogonal config axes determine what the earclip emits. The old `transport_mode` axis was removed when ESP-NOW was deleted.

```
ble_profile     BATCHED (0)   | LOW_LATENCY (1)
                Notify cadence on IBI / HRM characteristics.
                NOTE: this is the global default; PEER_ROLE overrides
                it on a per-connection basis (see §3.7).

data_format     IBI_ONLY (0)  | RAW_PPG (1) | IBI_PLUS_RAW (2)
                Whether RAW_PPG notifications fire.
```

Common iOS pairings (write `[ble_profile, data_format]` to MODE):

| Use case | Mode pair |
|---|---|
| Live BPM display | `LOW_LATENCY, IBI_ONLY` |
| Background HRV recording | `BATCHED, IBI_ONLY` |
| Raw waveform view (tuning) | `BATCHED, RAW_PPG` |
| Both at once | `LOW_LATENCY, IBI_PLUS_RAW` |

> In practice you usually leave the global `ble_profile` alone and let PEER_ROLE pick the right one for your connection. The MODE write is mainly useful for swapping `data_format` on the fly.

### 3.6 The runtime config struct

The full `narbis_runtime_config_t` is **48 bytes packed** (Path B / `config_version 3`), followed by 2 bytes of CRC = **50 bytes on the wire** (`NARBIS_CONFIG_WIRE_SIZE`). Field offsets are exact (`__attribute__((packed))`, no padding except the explicit `reserved_agc` byte).

> **Migration note.** Pre-Path-B firmware emitted a 58-byte payload with `transport_mode`, `partner_mac[6]`, and `espnow_channel` fields. If you have to support both, branch on the `config_version` field (offset 0): `1` or `2` = legacy 58-B layout, `3` = current 50-B layout.

| Offset | Size | Field | Default | Range / values | Notes |
|---|---|---|---|---|---|
| 0 | 2 | `config_version` | 3 | u16 LE | `3` for current Path B firmware |
| 2 | 2 | `sample_rate_hz` | 200 | 50, 100, 200, 400 | **Reboot to apply** |
| 4 | 2 | `led_red_ma_x10` | 70 | 0–510 (×10 mA) | Default 7.0 mA |
| 6 | 2 | `led_ir_ma_x10` | 70 | 0–510 (×10 mA) | Default 7.0 mA |
| 8 | 1 | `agc_enabled` | 1 | 0 / 1 | |
| 9 | 1 | `reserved_agc` | 0 | — | Padding; write 0 |
| 10 | 2 | `agc_update_period_ms` | 200 | u16 LE | |
| 12 | 4 | `agc_target_dc_min` | (firmware) | u32 LE, ADC counts | |
| 16 | 4 | `agc_target_dc_max` | (firmware) | u32 LE, ADC counts | |
| 20 | 2 | `agc_step_ma_x10` | (firmware) | u16 LE (×10 mA) | |
| 22 | 2 | `bandpass_low_hz_x100` | 50 | u16 LE (×100 Hz) | 0.50 Hz default |
| 24 | 2 | `bandpass_high_hz_x100` | 800 | u16 LE (×100 Hz) | 8.00 Hz default; must be > low |
| 26 | 2 | `elgendi_w1_ms` | 111 | u16 LE | Systolic peak window |
| 28 | 2 | `elgendi_w2_ms` | 667 | u16 LE | Beat window; must be > w1 |
| 30 | 2 | `elgendi_beta_x1000` | 20 | u16 LE (×1000) | Offset coefficient, default 0.020 |
| 32 | 2 | `sqi_threshold_x100` | 50 | u16 LE (×100) | Min SQI to emit IBI |
| 34 | 2 | `ibi_min_ms` | 300 | u16 LE | Validator floor (~200 BPM) |
| 36 | 2 | `ibi_max_ms` | 2000 | u16 LE | Validator ceiling (~30 BPM) |
| 38 | 1 | `ibi_max_delta_pct` | 30 | 0–100 | Continuity threshold |
| 39 | 1 | `ble_profile` | 0 (BATCHED) | 0, 1 | Global default; PEER_ROLE overrides per-connection |
| 40 | 1 | `data_format` | 0 (IBI_ONLY) | 0, 1, 2 | See §3.5 |
| 41 | 2 | `ble_batch_period_ms` | 500 | u16 LE | BATCHED-mode flush interval |
| 43 | 1 | `diagnostics_enabled` | 1 | 0 / 1 | Master gate for DIAGNOSTICS char |
| 44 | 1 | `light_sleep_enabled` | 1 | 0 / 1 | |
| 45 | 1 | `diagnostics_mask` | 0 | bitmask | See §3.1.8 |
| 46 | 2 | `battery_low_mv` | 3300 | u16 LE | Below this → low-battery indication |
| **48** | 2 | **CRC16** | — | u16 LE | CRC-16-CCITT-FALSE over bytes 0..47 |

> **Removed in Path B (do not look for them):** `transport_mode` (offset 39 in old layout), `partner_mac[6]` (offset 44), `espnow_channel` (offset 50). All ESP-NOW state is gone — the earclip-Edge link is now BLE only.

Swift mirror (Path B / `config_version 3`):

```swift
struct NarbisRuntimeConfig: Equatable {
    var configVersion: UInt16 = 3
    var sampleRateHz: UInt16 = 200
    var ledRedMaX10: UInt16 = 70
    var ledIrMaX10:  UInt16 = 70
    var agcEnabled: UInt8 = 1
    var agcUpdatePeriodMs: UInt16 = 200
    var agcTargetDcMin: UInt32 = 0
    var agcTargetDcMax: UInt32 = 0
    var agcStepMaX10: UInt16 = 0
    var bandpassLowHzX100:  UInt16 = 50
    var bandpassHighHzX100: UInt16 = 800
    var elgendiW1Ms: UInt16 = 111
    var elgendiW2Ms: UInt16 = 667
    var elgendiBetaX1000: UInt16 = 20
    var sqiThresholdX100: UInt16 = 50
    var ibiMinMs: UInt16 = 300
    var ibiMaxMs: UInt16 = 2000
    var ibiMaxDeltaPct: UInt8 = 30
    var bleProfile:    UInt8 = 0   // BATCHED
    var dataFormat:    UInt8 = 0   // IBI_ONLY
    var bleBatchPeriodMs: UInt16 = 500
    var diagnosticsEnabled: UInt8 = 1
    var lightSleepEnabled:  UInt8 = 1
    var diagnosticsMask: UInt8 = 0
    var batteryLowMv: UInt16 = 3300
}
```

CRC-16-CCITT-FALSE in Swift (mirrors `narbis_crc16_ccitt_false()` in `protocol/narbis_protocol.c`):

```swift
func narbisCRC16(_ bytes: Data) -> UInt16 {
    var crc: UInt16 = 0xFFFF
    for b in bytes {
        crc ^= UInt16(b) << 8
        for _ in 0..<8 {
            if (crc & 0x8000) != 0 {
                crc = (crc << 1) ^ 0x1021
            } else {
                crc <<= 1
            }
        }
    }
    return crc
}
```

> **Validation rules the firmware enforces.** Writes are rejected if any of these fail: `sample_rate_hz` is one of {50,100,200,400}; LED currents ≤ 510; `bandpass_low < bandpass_high`; `elgendi_w1 < elgendi_w2`; `ibi_min < ibi_max`; mode enums in range; `espnow_channel` 1–13; `battery_low_mv` 2800–4200.

---

## 4. Edge glasses BLE — full reference

The Edge advertises one custom service, **`0x00FF`**, with four characteristics (`0xFF01`–`0xFF04`). There are no standard SIG services. The device does not advertise its service UUID in the GAP payload reliably — filter by name `Narbis_Edge`.

### 4.1 Advertising / connection parameters

| Setting | Value |
|---|---|
| Device name | `Narbis_Edge` (exact) |
| Advertising interval | 100–200 ms |
| Adv type | connectable + scannable (`ADV_IND`) |
| TX power (advertising) | −6 dBm |
| TX power (connected) | −12 dBm |
| Adv flags | GENERAL_DISCOVERABLE + BR/EDR_NOT_SUPPORTED |
| Idle teardown | After 5 minutes with no client connected, the BLE stack shuts down completely (radio off). Re-armed on magnet tap or wake. |
| Requested MTU | 517 |
| Connection interval | 20–30 ms |
| Slave latency | 1 |
| Supervision timeout | 20 s (long, because OTA partition erase can block for up to 19 s) |
| Pairing / encryption | none |

### 4.2 Service `0x00FF` — characteristic map

| Characteristic | UUID | Properties | Direction | Purpose |
|---|---|---|---|---|
| Control | `0xFF01` | read + write | client → device | All commands; see §4.3 |
| OTA Data | `0xFF02` | write + write-no-response | client → device | OTA payload chunks; see §6 |
| Status | `0xFF03` | read + notify (uses indicate internally) | device → client | Multiplexed by leading byte: ADC stats, log, coherence, health, OTA status |
| PPG Stream | `0xFF04` | read + notify | device → client | Batched PPG samples + beat info |

Both `0xFF03` and `0xFF04` have a CCCD descriptor (`0x2902`) that you must enable with `setNotifyValue(true, for:)`.

### 4.3 Control characteristic `0xFF01` — command opcodes

Most commands are a 2-byte write `[opcode, arg]`. A 1-byte legacy form exists where the byte is interpreted as a static-mode duty (0–255 → 0–100 %).

The firmware **silently clamps out-of-range arguments and never sends a NACK**. Validate client-side and always wrap a command write in a Swift timeout if you need to detect failure.

| Opcode | Name | Arg | Persisted? | Notes |
|---|---|---|---|---|
| `0xA2` | Set brightness | 0–100 (%) | yes (NVS) | |
| `0xA4` | Set session duration | 1–60 (minutes) | yes | |
| `0xA5` | Static LED mode | 0–100 (duty %) | no | |
| `0xA6` | Strobe LED mode | any | no | starts strobe ISR |
| `0xA7` | Sleep now | any | no | enters deep sleep |
| `0xA8` | OTA START | `0x00` | no | see §6 |
| `0xA9` | OTA FINISH | `0x00` | no | see §6 |
| `0xAA` | OTA CANCEL | `0x00` | no | see §6 |
| `0xAB` | Strobe frequency | 1–50 (Hz) | yes | |
| `0xAC` | Strobe duty | 10–90 (%) | yes | |
| `0xAD` | OTA Page Confirm | `0x01` commit / `0x00` resend | no | see §6 |
| `0xB0` | Breathe LED mode | any | no | |
| `0xB1` | Breathe BPM | 1–30 | yes | |
| `0xB2` | Breathe inhale ratio | 10–90 (%) | yes | |
| `0xB3` | Breathe hold-top | 0–50 (×100 ms) | yes | |
| `0xB4` | Breathe hold-bottom | 0–50 (×100 ms) | yes | |
| `0xB5` | Breathe waveform | 0 sine, 1 linear | yes | |
| `0xB6` | Pulse-on-beat mode | any | no | needs earclip beats via ESP-NOW |
| `0xB7` | PPG program | 0–3 | no | 0 heartbeat, 1 coh-breathe, 2 coh-lens, 3 coh-breathe-strobe |
| `0xB8` | Coherence difficulty | 0–3 | yes | easy / medium / hard / expert |
| `0xB9` | Adaptive pacer | 0/1 | yes | |
| `0xBF` | Factory reset | any | n/a | wipes the `narbis_prefs` NVS namespace |
| `0xC0` | ADC scan diagnostic | 0/1 | no | dumps all ADC channels via log packets |
| **`0xC1`** | **Forget earclip** 🆕 | any (ignored) | no | Path B. Wipes the `narbis_pair` NVS entry, drops the central connection to the earclip, starts a fresh general scan. Visual feedback: 3 fast lens-opacity pulses. Same effect as 5 short magnet taps. |
| **`0xC3`** | **Relay config write** 🆕 | 50 B payload | no | Path B. Bytes after the opcode are forwarded verbatim as a CONFIG_WRITE to the paired earclip via the Edge's central role. The 50-byte payload is the same `narbis_runtime_config_t` + CRC16 layout the earclip expects on its own CONFIG_WRITE characteristic ([§3.6](#36-the-runtime-config-struct)). The earclip replies via CONFIG notify, which the Edge re-emits as a `0xF4` frame ([§4.4.5](#445-relayed-earclip-config-0xf4--50-b)). |
| **`0xC4`** | **Toggle raw-PPG relay** 🆕 | `0` disable / non-zero enable | no | Path B. Subscribes/unsubscribes the Edge's central from the earclip's RAW_PPG characteristic. While enabled, raw earclip samples are forwarded as `0xF5` frames on `0xFF03` ([§4.4.6](#446-relayed-earclip-raw-ppg-0xf5--variable)). Default: enabled at boot. |
| `0xD0` | Manual detector reset | any | no | clears beat detection state |

```swift
func edgeSetBrightness(_ pct: UInt8, on p: CBPeripheral, ctrl chr: CBCharacteristic) {
    let bytes: [UInt8] = [0xA2, min(pct, 100)]
    p.writeValue(Data(bytes), for: chr, type: .withResponse)
}

func edgeStartBreathe(bpm: UInt8, on p: CBPeripheral, ctrl chr: CBCharacteristic) {
    p.writeValue(Data([0xB0, 0]),       for: chr, type: .withResponse)  // enter breathe mode
    p.writeValue(Data([0xB1, bpm]),     for: chr, type: .withResponse)  // set BPM
}
```

### 4.4 Status characteristic `0xFF03` — notification multiplexer

The Edge multiplexes several packet types onto the same characteristic, distinguished by the **first byte**.

| Type byte | Cadence | Length | Purpose |
|---|---|---|---|
| `0xF0` | every 500 ms | 11 B | Raw ADC stats (min / max / mean of last window) |
| `0xF1` | on demand | 1 + N B (N ≤ 48) | Firmware log strings (printf output) |
| `0xF2` | every 1000 ms | 18 B | Coherence packet (HRV bands + score) |
| `0xF3` | every 1000 ms | 22 B | Health telemetry (uptime, heap, jitter, errors, LED state) — see §4.4.4 |
| **`0xF4`** 🆕 | event-driven | 1 + 50 B | Relayed earclip CONFIG payload — see §4.4.5 |
| **`0xF5`** 🆕 | event-driven | 1 + variable | Relayed earclip RAW_PPG batch — see §4.4.6 |
| **`0xF6`** 🆕 | on connect / disconnect / 30 s | 2 B | Earclip relay link state — see §4.4.7 |
| **`0xF7`** 🆕 | event-driven | 1 + variable | Relayed earclip diagnostics — see §4.4.8 |
| **`0xF8`** 🆕 | event-driven | 5 B | Relayed earclip battery (binary) — see §4.4.9 |
| **`0xF9`** 🆕 | event-driven (~1 Hz per beat) | 5 B | Relayed earclip IBI (binary) — see §4.4.10 |
| **`0xFA`** 🆕 | every 1000 ms | 7 B | Link-quality telemetry (RSSI, MTU, drops) — see §4.4.11 |
| `0x01`–`0x08` | event-driven | 3–7 B | OTA status — see §6 |

Always subscribe to `0xFF03` before sending any OTA opcode, otherwise you'll miss the READY / PAGE_CRC / ERROR responses you need to drive the protocol. The relay frames `0xF4`–`0xFA` are also delivered on this same characteristic, so a single subscription covers everything.

#### 4.4.1 ADC stats (`0xF0`) — 11 B

| Offset | Size | Field | Notes |
|---|---|---|---|
| 0 | 1 | `0xF0` | Type byte |
| 1 | 2 | `min` | u16 LE, ADC counts (0–4095) |
| 3 | 2 | `max` | u16 LE |
| 5 | 2 | `mean` | u16 LE |
| 7 | 1 | `count` | Samples in window (≤ 25) |
| 8 | 3 | reserved | 0 |

If `min == 0` or `max ≈ 4095`, the PPG sensor is disconnected or saturated. If `(max − min) < 200`, no useful signal.

#### 4.4.2 Log string (`0xF1`) — variable

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | `0xF1` |
| 1..N | up to 48 | ASCII string (NUL-terminated or truncated) |

Useful for debugging. The firmware emits a hello on subscribe, a heartbeat every 5 s, and ad-hoc events.

#### 4.4.3 Coherence packet (`0xF2`) — 18 B

| Offset | Size | Field | Notes |
|---|---|---|---|
| 0 | 1 | `0xF2` | |
| 1 | 1 | `coherence` | 0–100, % |
| 2 | 2 | `resp_peak_mhz` | u16 LE, milliherz |
| 4 | 2 | `vlf_power` | u16 LE |
| 6 | 2 | `lf_power` | u16 LE |
| 8 | 2 | `hf_power` | u16 LE |
| 10 | 2 | `total_power` | u16 LE |
| 12 | 1 | `lf_norm_pct` | 0–100 |
| 13 | 1 | `hf_norm_pct` | 0–100 |
| 14 | 2 | `lf_hf_ratio_fp8_8` | u16 LE; divide by 256 for the decimal ratio |
| 16 | 1 | `n_ibis_used` | 0–120 |
| 17 | 1 | reserved | 0 |

The Edge derives this from earclip beats it received over ESP-NOW, so this packet is meaningful only when an earclip is paired and emitting. If `n_ibis_used == 0`, no useful HRV analysis yet.

#### 4.4.4 Health telemetry (`0xF3`) — 22 B

| Offset | Size | Field | Notes |
|---|---|---|---|
| 0 | 1 | `0xF3` | |
| 1 | 4 | `uptime_s` | u32 LE |
| 5 | 4 | `heap_free` | u32 LE |
| 9 | 4 | `heap_min` | u32 LE; minimum free heap since boot — leak detector |
| 13 | 2 | `ppg_stack_hwm_words` | u16 LE; `0xFFFF` = >65535 |
| 15 | 2 | `ble_send_errors` | u16 LE; saturates at `0xFFFF` |
| 17 | 2 | `jitter_max_us` | u16 LE; reset every 5 s |
| 19 | 1 | `jitter_ticks_over` | u8; reset every 5 s |
| 20 | 1 | `led_mode` 🆕 | u8 — `LED_MODE_*` enum (0 = off, 1 = static, 2 = strobe, 3 = breathe, 4 = pulse-on-beat, 5 = coherence-lens, 6 = breathe+strobe). Mirror of the lens-driver state machine. |
| 21 | 1 | `led_duty` 🆕 | u8 — effective PWM duty 0–255 (0–100%). Snapshot of the actual lens output at emit time, not the requested duty. Useful for "is the lens doing what I asked?" overlays. |

A spike in `ble_send_errors` means the iOS side is overwhelming the device — slow your writes. `led_mode` + `led_duty` were added in glasses fw v4.15.4 (PR #28); older firmware emits a 20-byte frame without these two bytes.

#### 4.4.5 Relayed earclip CONFIG (`0xF4`) — 51 B

🆕 **Path B.** Forwarded verbatim from the earclip's CONFIG characteristic when its value changes (or in response to a `0xC3` write you sent).

| Offset | Size | Field | Notes |
|---|---|---|---|
| 0 | 1 | `0xF4` | Type byte |
| 1 | 48 | `narbis_runtime_config_t` | Earclip config struct ([§3.6](#36-the-runtime-config-struct)) |
| 49 | 2 | `crc16` | CRC-16-CCITT-FALSE over bytes 1..48 |

The 50-byte tail is **identical** to what you'd read directly from the earclip's CONFIG characteristic — same struct layout, same CRC. Reuse your earclip CONFIG parser.

#### 4.4.6 Relayed earclip RAW_PPG (`0xF5`) — variable

🆕 **Path B.** Forwarded from the earclip's RAW_PPG characteristic. Only emitted when raw-PPG relay is enabled (see opcode `0xC4`; default is enabled at boot).

| Offset | Size | Field | Notes |
|---|---|---|---|
| 0 | 1 | `0xF5` | Type byte |
| 1 | 2 | `sample_rate_hz` | u16 LE |
| 3 | 2 | `n_samples` | u16 LE, ≤ 29 |
| 5 | 8·N | samples | Each `[red:u32 LE, ir:u32 LE]` |

Maximum payload: 1 + 4 + 29·8 = **237 B**. The 1-byte type prefix is the only difference vs. the earclip's direct RAW_PPG notification ([§3.1.3](#313-raw_ppg--6bacca91)).

#### 4.4.7 Relay link state (`0xF6`) — 2 B

🆕 **Path B.** Tells you whether the Edge's central role currently has a healthy connection to the earclip. Emitted:
- once when an iOS client connects to the Edge (so you know the current state immediately),
- on every earclip connect / disconnect transition,
- every 30 s as a heartbeat.

| Offset | Size | Field | Values |
|---|---|---|---|
| 0 | 1 | `0xF6` | Type byte |
| 1 | 1 | `linked` | `0` = relay lost (Edge is searching for / has lost the earclip), `1` = relay linked (earclip data is flowing) |

```swift
// In peripheral(_:didUpdateValueFor:error:) for the Edge's 0xFF03:
if data.count == 2 && data[0] == 0xF6 {
    let earclipReachable = data[1] == 1
    UI.setEarclipBadge(connected: earclipReachable)
}
```

#### 4.4.8 Relayed earclip diagnostics (`0xF7`) — variable

🆕 **Path B.** Forwarded earclip DIAGNOSTICS frames (see [§3.1.8](#318-diagnostics--31d99572)). Only fires when the user has enabled diagnostic streams in the earclip config — usually a no-op.

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | `0xF7` |
| 1..N | variable | The full earclip diagnostic frame (`[seq:u16, n:u8] then n × [stream_id:u8, len:u8, payload]`) |

#### 4.4.9 Relayed earclip BATTERY (`0xF8`) — 5 B

🆕 **Path B (binary).** Structured battery snapshot. Mirrors the earclip's `narbis_battery_payload_t` ([§3.1.4](#314-battery--b59d3ba1)) with a 1-byte type prefix. Emitted whenever the earclip's BATTERY characteristic notifies — typically every 30 s.

| Offset | Size | Field | Notes |
|---|---|---|---|
| 0 | 1 | `0xF8` | Type byte |
| 1 | 2 | `mv` | u16 LE — battery voltage, millivolts |
| 3 | 1 | `soc_pct` | u8 — state of charge, 0–100 |
| 4 | 1 | `charging` | u8 — 0 = discharging, 1 = charging |

Prefer this over parsing the human-readable `0xF1` log line (`"earclip batt soc=… mv=…"`) — same data, ~6× less air-time, no regex.

#### 4.4.10 Relayed earclip IBI (`0xF9`) — 5 B

🆕 **Path B (binary).** One inter-beat-interval observation, forwarded every time the earclip's IBI characteristic notifies (~1 Hz at resting HR). Mirrors `narbis_ibi_payload_t` ([§3.1.1](#311-ibi--78ef492f)) with a 1-byte type prefix.

| Offset | Size | Field | Notes |
|---|---|---|---|
| 0 | 1 | `0xF9` | Type byte |
| 1 | 2 | `ibi_ms` | u16 LE — inter-beat interval, milliseconds (300–2000 typ.) |
| 3 | 1 | `confidence_x100` | u8 — 0–100 → 0.00–1.00 confidence (NCC × Kalman) |
| 4 | 1 | `flags` | u8 — `NARBIS_BEAT_FLAG_*` bitmask (bit 0 = artifact, see §3.1.1) |

```swift
case 0xF9:
    guard data.count >= 5 else { break }
    let ibiMs = UInt16(data[1]) | (UInt16(data[2]) << 8)
    let conf  = data[3]                     // 0–100
    let flags = data[4]                     // bit 0 = artifact
    if flags & 0x01 == 0 && conf >= 40 {
        hrvPipeline.pushBeat(ibiMs: ibiMs, confidence: conf)
    }
```

Fires unconditionally per detected beat — apply the confidence gate / artifact filter client-side as needed. Confidence threshold is also configurable on the earclip itself via the `sqi_threshold_x100` config field ([§3.6](#36-the-runtime-config-struct)).

#### 4.4.11 Link quality (`0xFA`) — 7 B

🆕 **v4.15.3+.** 1 Hz BLE link-quality snapshot for both hops the Edge participates in. Web Bluetooth doesn't expose RSSI to dashboard JS, so the Edge measures it server-side and ships it up. Use it to drive a "signal strength" UI pill on the iOS / web side.

| Offset | Size | Field | Notes |
|---|---|---|---|
| 0 | 1 | `0xFA` | Type byte |
| 1 | 1 | `earclip_rssi` | i8 — glasses ↔ earclip link RSSI, dBm. `0x7F` (= 127) sentinel = no link |
| 2 | 1 | `dashboard_rssi` | i8 — glasses ↔ dashboard link RSSI, dBm. `0x7F` sentinel = no link |
| 3 | 2 | `mtu` | u16 LE — current ATT MTU on the dashboard link (0 if no link) |
| 5 | 2 | `drops` | u16 LE — clamped `ble_send_errors`, cumulative notify failures (saturates at `0xFFFF`) |

The dashboard-side RSSI on this frame is the Edge's view of the client — it should always be present when you're receiving the frame. The earclip-side RSSI is `0x7F` whenever the relay link is down (matches `0xF6 linked=0`).

```swift
case 0xFA:
    guard data.count >= 7 else { break }
    let ecRssi   = Int8(bitPattern: data[1])  // i8
    let dashRssi = Int8(bitPattern: data[2])
    let mtu      = UInt16(data[3]) | (UInt16(data[4]) << 8)
    let drops    = UInt16(data[5]) | (UInt16(data[6]) << 8)
    ui.setEarclipBars(ecRssi == 0x7F ? nil : Int(ecRssi))
    ui.setEdgeBars(dashRssi == 0x7F ? nil : Int(dashRssi))
    diagnostics.mtu = mtu
    diagnostics.notifyDrops = drops
```

### 4.5 PPG stream characteristic `0xFF04`

Batched samples with embedded beat detection. The firmware ships **format `0x03`** (current, since v4.14.9). An older format `0x02` exists in legacy firmware and is documented at the end for back-compat.

#### Format `0x03` — header (6 B)

| Offset | Size | Field | Notes |
|---|---|---|---|
| 0 | 1 | `0x03` | Type byte |
| 1 | 1 | `n_samples` | typically 10, ≤ 10 |
| 2 | 4 | `base_timestamp_ms` | u32 LE; time of `samples[0]` from `esp_timer` |

#### Per-sample (8 B each, `n_samples` times)

| Offset | Size | Field | Notes |
|---|---|---|---|
| +0 | 2 | `raw_adc` | u16 LE, 12-bit value (0–4095) |
| +2 | 2 | `sample_index` | u16 LE; absolute, wraps at 65536 (≈21.8 min @ 50 Hz) |
| +4 | 1 | `flags` | bit 0 = beat detected, bit 1 = in-block state |
| +5 | 2 | `ibi_ms` | u16 LE; interval since last beat, 0 if none yet |
| +7 | 1 | `bpm` | u8; current BPM estimate, 0 if < 2 beats |

Total notification size with N=10: 6 + 80 = 86 B. Cadence ≈ 200 ms (every 10 samples at 50 Hz).

Reconstruct per-sample timestamps client-side: `ts[i] = base_timestamp_ms + i * 20` (50 Hz nominal, no per-sample jitter field).

```swift
struct EdgeSample {
    let raw: UInt16
    let index: UInt16
    let flags: UInt8
    let ibiMs: UInt16
    let bpm: UInt8
    var beatDetected: Bool { flags & 0x01 != 0 }
}

struct EdgePPGBatch {
    let baseTimestampMs: UInt32
    let samples: [EdgeSample]

    init?(_ data: Data) {
        guard data.count >= 6, data[0] == 0x03 else { return nil }
        let n = Int(data[1])
        guard data.count == 6 + n * 8 else { return nil }
        baseTimestampMs = data.subdata(in: 2..<6).withUnsafeBytes { $0.load(as: UInt32.self) }
        samples = (0..<n).map { i in
            let off = 6 + i * 8
            let raw   = UInt16(data[off])   | (UInt16(data[off+1]) << 8)
            let index = UInt16(data[off+2]) | (UInt16(data[off+3]) << 8)
            let flags = data[off+4]
            let ibi   = UInt16(data[off+5]) | (UInt16(data[off+6]) << 8)
            let bpm   = data[off+7]
            return EdgeSample(raw: raw, index: index, flags: flags, ibiMs: ibi, bpm: bpm)
        }
    }
}
```

#### Legacy format `0x02` (older firmware only)

13 B per sample, no batching:

```
[0x02][raw:u16 LE][idx:u16 LE][ts:u32 LE][flags:u8][ibi:u16 LE][bpm:u8]
```

Detect by reading the type byte; both share characteristic `0xFF04`.

### 4.6 The Edge as relay (Path B)

🆕 **New architecture.** The Edge is no longer just a peripheral — it also runs a Bluedroid **central** that scans for, pairs with, and persistently reconnects to the earclip. Once linked, the Edge transparently forwards earclip notifications to whichever phone is connected to it.

```
                                  ┌─────────────────┐
                                  │  iOS / watchOS  │
                                  └────────┬────────┘
                                           │ BLE (peripheral role on Edge)
                                           │   • 0xFF01 commands (incl. 0xC1/C3/C4)
                                           │   • 0xFF03 status + relayed 0xF4/F5/F6/F7
                                           │   • 0xFF04 native PPG stream
                                           │
                                  ┌────────▼────────┐
                                  │  Narbis Edge    │
                                  │  ESP32 dual-role│
                                  └────────┬────────┘
                                           │ BLE (central role on Edge,
                                           │      writes PEER_ROLE = GLASSES = 2)
                                           │
                                  ┌────────▼────────┐
                                  │ Narbis Earclip  │
                                  │  ESP32-C6       │
                                  │  (multi-central)│
                                  └─────────────────┘
```

**Pairing.** First boot or after a `0xC1` (or 5 magnet-taps), the Edge scans generally for the earclip's NARBIS service UUID, picks the strongest hit, and stores the MAC in NVS. Subsequent boots do a fast directed scan for that MAC (5 s), falling back to general scan after two misses.

**What the Edge subscribes to.** When linked, the Edge keeps live subscriptions to the earclip's IBI, BATTERY, CONFIG, RAW_PPG (if the iOS side enabled it via `0xC4`), and DIAGNOSTICS characteristics. Every notification is relayed to the iOS-facing `0xFF03` with the appropriate type byte:

| Earclip characteristic | Relay frame on `0xFF03` |
|---|---|
| IBI       | `0xF9` (binary, 5 B — §4.4.10) **and** `0xF1` text log mirror |
| BATTERY   | `0xF8` (binary, 5 B — §4.4.9) **and** `0xF1` text log mirror |
| CONFIG    | `0xF4` (§4.4.5) |
| RAW_PPG   | `0xF5` (§4.4.6) — opt-in via `0xC4` |
| DIAGNOSTICS | `0xF7` (§4.4.8) |

In addition the Edge emits its own `0xF6` relay-link-state, `0xFA` link-quality, and `0xF3` health frames so the iOS / web client can render connection-strength UI without managing a second BLE link.

**Per-beat IBI is fully relayed (since glasses fw v4.15.2 / PR #25).** Earlier guidance in this doc said the Edge consumed earclip IBI internally without forwarding it; that was true under the original Path B but is no longer the case. Subscribe to `0xFF03`, watch for `0xF9`, and you get every detected beat with confidence + flags. The earclip-direct option (Pattern A below) is now only needed if you want the raw IBI characteristic without the Edge in the path at all (e.g. for timing-sensitive HRV recording during a glasses OTA).

#### iOS integration choice

| Pattern | When to use it | Trade-offs |
|---|---|---|
| **A. Direct (two connections)** — connect to both the earclip and the Edge separately. | You want lowest-latency raw IBI for your own HRV pipeline; you want full control of earclip config. | More CoreBluetooth state to manage; user sees two devices in the system Bluetooth picker if they ever pair. |
| **B. Single connection via Edge** — connect only to the Edge; consume `0xF4`/`0xF5`/`0xF6`/`0xF7` from `0xFF03`. | You're building a companion app that mainly drives Edge sessions; raw earclip-side data is enough via the relay. | One fewer connection to manage. Slight extra latency on relayed frames (one BLE hop). Earclip config writes go through the Edge via `0xC3` (still landing as a CONFIG_WRITE on the earclip end). |

```swift
// Pattern B: read the relay state and decide whether to expect earclip data.
func peripheral(_ p: CBPeripheral, didUpdateValueFor c: CBCharacteristic, error: Error?) {
    guard c.uuid == CBUUID(string: "FF03"), let data = c.value, !data.isEmpty else { return }
    switch data[0] {
    case 0xF6:  // relay state
        let linked = data.count >= 2 && data[1] == 1
        appState.earclipReachable = linked
    case 0xF4:  // relayed earclip CONFIG (50 B after the type byte)
        let payload = data.subdata(in: 1..<data.count)
        appState.earclipConfig = parseEarclipConfig(payload)
    case 0xF5:  // relayed RAW_PPG
        let payload = data.subdata(in: 1..<data.count)
        appState.appendRawPPG(parseRawPPG(payload))
    case 0xF7:  // relayed diagnostics
        break   // ignore unless you're tuning
    case 0xF8:  // relayed earclip BATTERY (binary, 5 B)
        guard data.count >= 5 else { break }
        let mv = UInt16(data[1]) | (UInt16(data[2]) << 8)
        let soc = data[3], charging = data[4] != 0
        appState.earclipBattery = (mv: mv, socPct: soc, charging: charging)
    case 0xF9:  // relayed earclip IBI (binary, 5 B)
        guard data.count >= 5 else { break }
        let ibiMs = UInt16(data[1]) | (UInt16(data[2]) << 8)
        let conf = data[3], flags = data[4]
        if flags & 0x01 == 0 { hrvPipeline.pushBeat(ibiMs: ibiMs, conf: conf) }
    case 0xFA:  // link quality (RSSI + MTU + drops)
        guard data.count >= 7 else { break }
        let ec = Int8(bitPattern: data[1]), dash = Int8(bitPattern: data[2])
        ui.setSignalBars(earclip: ec == 0x7F ? nil : Int(ec),
                         edge:    dash == 0x7F ? nil : Int(dash))
    default:
        // 0xF0/F1/F2/F3 are the Edge's own packets; 0x01-0x08 are OTA.
        break
    }
}

// Forward an earclip config write via the Edge:
func writeEarclipConfigViaEdge(_ payload50B: Data) {
    var msg = Data([0xC3])
    msg.append(payload50B)             // 50 B = 48 struct + 2 CRC, same as earclip's CONFIG_WRITE
    edgePeripheral.writeValue(msg, for: edgeControl, type: .withResponse)
}

// Toggle raw-PPG relay on demand:
func setRawRelay(_ on: Bool) {
    edgePeripheral.writeValue(Data([0xC4, on ? 1 : 0]), for: edgeControl, type: .withResponse)
}

// Ask the Edge to forget its earclip pairing:
func forgetEarclip() {
    edgePeripheral.writeValue(Data([0xC1, 0]), for: edgeControl, type: .withResponse)
}
```

---

## 5. Configuring the earclip from iOS

End-to-end example: write PEER_ROLE first, then read CONFIG, change one field, write CONFIG_WRITE.

```swift
// Assume you have already discovered:
//   chPeerRole:    CBCharacteristic for e987719a-… (write)
//   chConfig:      CBCharacteristic for 553abc98-… (read + notify)
//   chConfigWrite: CBCharacteristic for 129fbe56-… (write)

// 0. ALWAYS write your role first (Path B). 1 = DASHBOARD → LOW_LATENCY profile.
peripheral.writeValue(Data([1]), for: chPeerRole, type: .withResponse)

// 1. Read current config (50 B = 48 B struct + 2 B CRC).
peripheral.readValue(for: chConfig)

// 2. In peripheral(_:didUpdateValueFor:error:), parse and modify:
func peripheral(_ p: CBPeripheral, didUpdateValueFor c: CBCharacteristic, error: Error?) {
    guard c.uuid == CBUUID(string: "553abc98-6406-4e37-b9fd-34df85b2b6c1"),
          let data = c.value, data.count == 50 else { return }

    // Verify CRC (last 2 bytes are CRC over first 48).
    let body = data.subdata(in: 0..<48)
    let receivedCRC = UInt16(data[48]) | (UInt16(data[49]) << 8)
    guard narbisCRC16(body) == receivedCRC else {
        print("CONFIG CRC mismatch")
        return
    }

    var cfg = decodeConfig(body)            // your byte-by-byte decoder
    cfg.dataFormat = 2                       // IBI_PLUS_RAW
    cfg.bleProfile = 1                       // LOW_LATENCY

    let newBody = encodeConfig(cfg)          // your byte-by-byte encoder, 48 B
    let newCRC  = narbisCRC16(newBody)
    var payload = Data(newBody)
    payload.append(UInt8(newCRC & 0xFF))
    payload.append(UInt8(newCRC >> 8))

    p.writeValue(payload, for: chConfigWrite, type: .withResponse)
}
```

For just changing the data format / profile, the 2-byte MODE write is much cheaper:

```swift
peripheral.writeValue(Data([1, 2]), for: chMode, type: .withResponse)
//                          ^  ^
//                          |  data_format = IBI_PLUS_RAW
//                          ble_profile   = LOW_LATENCY
```

The earclip will notify on the CONFIG characteristic with the updated 50-byte payload after either write succeeds — subscribe to it once at startup so your view layer stays in sync.

---

## 6. OTA — shared between both devices

The wire protocol is **identical** on Edge and earclip — the earclip's OTA was deliberately ported from Edge so a single iOS updater handles both. The earclip adds three safety gates (battery, chip-ID, re-entry) on top.

Always disambiguate by name first; the OTA service UUID `0x00FF` lives on both devices.

### 6.1 Service & characteristics

| Role | UUID | Properties | Notes |
|---|---|---|---|
| Service | `0x00FF` | — | Same UUID on both devices |
| Control | `0xFF01` | read + write | Opcodes (this is also the Edge command char — same UUID) |
| Data | `0xFF02` | write + write-no-response | Firmware bytes in chunks ≤ 240 B |
| Status | `0xFF03` | read + notify (indicate on Edge) | Status frames 3–7 B |

### 6.2 Constants

| Constant | Value |
|---|---|
| Page size | 4096 B (one flash erase block) |
| Recommended chunk size | **240 B** (safe for both — earclip can take 244 with MTU 247, Edge caps at 240) |
| Page CRC | CRC32 little-endian (computed by device, sent in PAGE_CRC notification) |

### 6.3 Opcodes (write to `0xFF01` as `[opcode, param]`)

| Opcode | Name | Param | Meaning |
|---|---|---|---|
| `0xA8` | START | `0x00` | Enter OTA mode; device responds with `READY` |
| `0xA9` | FINISH | `0x00` | Flush, set boot partition, reboot |
| `0xAA` | CANCEL | `0x00` | Abort transfer |
| `0xAD` | PAGE_CONFIRM | `0x01` commit / `0x00` resend | Driven by client after verifying PAGE_CRC |

### 6.4 Status notifications (read from `0xFF03`)

| First byte | Name | Length | Payload |
|---|---|---|---|
| `0x01` | READY | 4 B | `01 00 00 00` |
| `0x03` | SUCCESS | 4 B | `03 00 00 00` — reboot is imminent, expect disconnect |
| `0x04` | ERROR | 4 B | `04 <err> 00 00` |
| `0x05` | CANCELLED | 4 B | `05 00 00 00` |
| `0x06` | PAGE_CRC | 7 B | `06 page_hi page_lo crc32_le[4]` — client must verify and ack |
| `0x07` | PAGE_OK | 3 B | `07 page_hi page_lo` — page committed to flash |
| `0x08` | PAGE_RESEND | 3 B | `08 page_hi page_lo` — restart this page |

### 6.5 Error codes (byte 1 of an `0x04 ERROR` notification)

| Code | Name | Both? | Meaning |
|---|---|---|---|
| `0x01` | BEGIN | both | `esp_ota_begin()` failed |
| `0x02` | WRITE | both | `esp_ota_write()` failed during page commit |
| `0x03` | END | both | `esp_ota_end()` or `set_boot_partition()` failed |
| `0x04` | NOT_IN_OTA | both | Data received outside an OTA session |
| `0x05` | NO_PARTITION | both | `esp_ota_get_next_update_partition()` returned NULL |
| `0x06` | LOW_BATTERY | earclip only | SoC < 30 % — charge before OTA |
| `0x07` | CHIP_MISMATCH | earclip only | Image is not for ESP32-C6 |
| `0x08` | ALREADY_IN_OTA | earclip only | START received during an OTA session |

> Always handle the earclip-only codes even when targeting Edge — they simply won't fire on Edge. Future-proofing is cheap.

### 6.6 State machine

```
   client                              device
   ──────                              ──────
   subscribe to STATUS  ─────────────►
   write [0xA8, 0x00]   ─────────────►
                        ◄──────── notify [0x01 …]   READY

   ┌── for each 4096-B page ──────────┐
   │  write data in 240-B chunks  ──► │
   │  (write-no-response, ≤17 chunks)
   │                  ◄──── notify [0x06, page#, crc32]
   │  verify CRC32
   │  write [0xAD, 0x01]   ─────────► │     (commit)
   │                  ◄──── notify [0x07, page#]
   │  …or if CRC mismatched:          │
   │  write [0xAD, 0x00]   ─────────► │     (request resend)
   │                  ◄──── notify [0x08, page#]
   └──────────────────────────────────┘

   write [0xA9, 0x00]   ─────────────►
                        ◄──────── notify [0x03 …]   SUCCESS
   (device reboots; you'll get a disconnect)
```

### 6.7 Firmware image header — pre-flight validation

Before sending the first byte to OTA, validate the `.bin` you're about to ship matches the device. The header is in the first 32 bytes of the image:

| Offset | Size | Field | Expected value |
|---|---|---|---|
| 0x00 | 1 | image magic | `0xE9` |
| 0x01 | 1 | segment_count | — |
| 0x0C | 2 | `chip_id` (LE) | `0x0000` for ESP32 (Edge), `0x000D` for ESP32-C6 (earclip) |

The `app_desc` magic `0xABCD5432` lives 32 bytes into the first segment payload (typically around offset 0x20–0x40 in the file), followed by a 32-byte version string. See `ota-additions/firmware_validator.js` for a working JavaScript implementation you can port to Swift.

### 6.8 Swift sketch — OTA loop

```swift
// Prerequisites:
//   subscribed to chStatus (0xFF03)
//   chControl, chData, chStatus discovered
//   chunkSize = 240
//   pageSize  = 4096

var pageBuf = Data(capacity: 4096)
var pageNum: UInt16 = 0
var pendingPageCRC: UInt32?

// Sender side
func startOTA(image: Data) {
    pageNum = 0
    sendPage(image: image, offset: 0)
    peripheral.writeValue(Data([0xA8, 0x00]), for: chControl, type: .withResponse)
}

func sendPage(image: Data, offset: Int) {
    let end = min(offset + 4096, image.count)
    var chunkOffset = offset
    while chunkOffset < end {
        let chunkEnd = min(chunkOffset + 240, end)
        let chunk = image.subdata(in: chunkOffset..<chunkEnd)
        peripheral.writeValue(chunk, for: chData, type: .withoutResponse)
        chunkOffset = chunkEnd
    }
    // Now wait for [0x06, page_hi, page_lo, crc32_le[4]] on chStatus.
}

// Receiver side — peripheral(_:didUpdateValueFor:error:) for chStatus:
func handleOTAStatus(_ data: Data) {
    guard let type = data.first else { return }
    switch type {
    case 0x01: print("OTA READY")
    case 0x06:  // PAGE_CRC
        let pageHi = data[1], pageLo = data[2]
        let pageNumber = UInt16(pageHi) << 8 | UInt16(pageLo)
        let crc = data.subdata(in: 3..<7).withUnsafeBytes { $0.load(as: UInt32.self) }
        if crc == myComputedCRC32(forPage: pageNumber) {
            peripheral.writeValue(Data([0xAD, 0x01]), for: chControl, type: .withResponse)
        } else {
            peripheral.writeValue(Data([0xAD, 0x00]), for: chControl, type: .withResponse)
        }
    case 0x07: // PAGE_OK — advance to next page
        let pageNumber = UInt16(data[1]) << 8 | UInt16(data[2])
        sendPage(image: image, offset: (Int(pageNumber) + 1) * 4096)
    case 0x08: // PAGE_RESEND
        let pageNumber = UInt16(data[1]) << 8 | UInt16(data[2])
        sendPage(image: image, offset: Int(pageNumber) * 4096)
    case 0x03: print("OTA SUCCESS — device rebooting")
    case 0x04:
        let err = data.count > 1 ? data[1] : 0
        print("OTA ERROR: \(err)")
    case 0x05: print("OTA CANCELLED")
    default: break
    }
}
```

> **Do NOT treat a 5–10 second silence on `0xFF03` mid-OTA as a stall.** When the Edge erases its update partition, the radio can be blocked for **up to 19 seconds**. The 20-second supervision timeout is set for exactly this reason. Don't call `cancelPeripheralConnection` until you've waited at least 25 s with no progress.

---

## 7. iOS / Core Bluetooth gotchas

### 7.1 GATT caching

iOS aggressively caches discovered services per peripheral identifier. Neither device mutates its GATT table at runtime, so this is fine — but if you ever ship a firmware that adds characteristics, you'll need to bump the device's `serviceChanged` indication or instruct users to forget the device in iOS Settings.

### 7.2 MTU is final after discovery

`maximumWriteValueLength(for:)` returns the post-negotiation value only after `didDiscoverServices` fires. Don't read it earlier — you'll get the safe-default 20.

### 7.3 Indicate vs notify

The Edge's `0xFF03` uses **indicate** internally (every notification is ACKed by iOS before the next is sent). Pace OTA writes accordingly: keep at most one in-flight indicate at a time. The earclip uses **notify** — back-pressure is the OS's job, but don't hammer CONFIG_WRITE faster than ~10 Hz.

### 7.4 CCCD subscription order matters for Edge OTA

You must subscribe to `0xFF03` **before** sending an OTA opcode, otherwise you'll miss `READY`, all `PAGE_CRC` notifications, and the final `SUCCESS`/`ERROR`. There's no way to recover the protocol from the middle. The same characteristic also carries the new relay frames (`0xF4`–`0xF7`) so subscribing once covers both flows.

### 7.4a Always write PEER_ROLE early on the earclip

🆕 **Path B.** When connecting to the earclip, write `0x01` (DASHBOARD) to PEER_ROLE **before** you enable any notifications, otherwise you'll start receiving notifications under the global default `BATCHED` profile (slow, 50–100 ms intervals) and the conn-update from your role write will arrive a few hundred ms later. Doing it first means your very first IBI lands at LOW_LATENCY pacing.

### 7.5 No NACKs from either device

Neither device sends an explicit failure response for an out-of-range command — it just silently clamps or drops. Wrap every write in a Swift timeout / response correlator.

### 7.6 Edge advertising teardown

After 5 minutes of no client connection the Edge powers down its BLE radio entirely. Surface this in your UX: "Tap your glasses to wake them" rather than spinning a connect retry forever.

### 7.7 Reconnection

Both devices auto-resume advertising on disconnect. Just call `central.connect(_:options:)` again from `centralManager(_:didDisconnectPeripheral:error:)`. Use exponential backoff (1, 2, 4, 8, 16, 30 seconds) — the same cadence the dashboard uses.

### 7.8 Background / state restoration

If you build a background-scanning app, set `CBCentralManagerOptionRestoreIdentifierKey`. Implement `centralManager(_:willRestoreState:)` and re-attach delegates to the restored peripherals. Both devices behave identically across foreground and background — there are no special "background-only" advertisements.

### 7.9 watchOS

watchOS 6+ supports Core Bluetooth identically (you'll need the `bluetooth-central` background mode in your `WKExtension` plist). Connection parameter ranges are tighter on Apple Watch than iPhone — test on real hardware. Our supervision timeout of 20 s on Edge is well within watchOS limits.

---

## 8. Troubleshooting matrix

| Symptom | Likely cause | Fix |
|---|---|---|
| Can't see Edge in scan | 5-minute idle teardown after disconnect | User taps the magnet on the glasses to re-arm advertising |
| Both devices appear with the same service UUID | They share `0x00FF` for OTA | Disambiguate by `peripheral.name` |
| OTA fails immediately on earclip with err `0x06` | Battery SoC < 30 % | Charge the earclip before retry |
| OTA fails on earclip with err `0x07` | Wrong `.bin` (Edge image targeted at earclip) | Validate the chip-id field (offset `0x0C`) before sending |
| Connection drops mid-OTA | iOS cancelled before partition erase finished | Don't call `cancelPeripheralConnection` for at least 25 s after last progress |
| MODE write succeeds but format unchanged | Wrote to the wrong characteristic UUID | Verify you're using `71db6de8-…` (earclip-only) — not `0xFF01` |
| Notifications stop after a few seconds | Forgot to enable the CCCD | `peripheral.setNotifyValue(true, for: chr)` for every notify char |
| Garbled CONFIG read | Skipped CRC verification | Validate the last 2 B with CRC-16-CCITT-FALSE; it should match a CRC over the first 56 B |
| Coherence packets always show `n_ibis_used = 0` | Edge isn't linked to the earclip | Check the latest `0xF6` relay-state frame on `0xFF03`; if `linked=0`, send `0xC1` and let the Edge re-pair, or get the earclip into range |
| `0xF4`/`0xF5` frames never arrive even with `0xF6 linked=1` | Earclip has no skin contact / no signal | Confirm with earclip BATTERY notify or SQI; raw stream needs `0xC4 1` to be enabled |
| New iOS app gets stuck at BATCHED cadence even after writing PEER_ROLE | Wrote PEER_ROLE *after* enabling notifies | Re-order: write `[0x01]` to PEER_ROLE first, then `setNotifyValue(true, …)` on IBI |
| Earclip CONFIG read returns 50 B but parser expects 58 B | Pre-Path-B parser, post-Path-B firmware | Branch on `config_version` (offset 0): `≤2` legacy 56-B layout, `3` current 48-B layout |
| Health telemetry `ble_send_errors` climbing | Client overflowing the device's send queue | Slow down command writes; check for tight write loops |
| `firmware_revision` reads as empty string | Read before discovery completed | Read inside `didDiscoverCharacteristicsFor:` callback, not on `didConnect` |
| RAW_PPG never fires | `data_format` is `IBI_ONLY` | Write MODE to set `data_format = 1` or `2` |

---

## 9. Reference data

### 9.1 All UUIDs at a glance

```
EARCLIP — Custom Narbis service
  Service        a24080b2-8857-4785-b3ba-a43b66af4f28
  IBI            78ef492f-66be-438d-a91e-ddfdb441b7bb   notify
  SQI            2b614c61-bcdf-4a3f-a7e8-3b5a860c0347   notify
  RAW_PPG        6bacca91-7017-40fa-bb91-4ebf28a65a99   notify
  BATTERY        b59d3ba1-78d1-4260-93c2-7e9e02329777   notify
  CONFIG         553abc98-6406-4e37-b9fd-34df85b2b6c1   read + notify   (50 B in Path B)
  CONFIG_WRITE   129fbe56-cbd6-4f52-957b-d80834d6abf3   write           (50 B in Path B)
  MODE           71db6de8-5bff-480f-8db1-0d01c90d17d0   write           (2 B in Path B)
  PEER_ROLE      e987719a-26a6-48d4-b8e9-128994e62e6c   write           🆕 Path B (1 B)
  DIAGNOSTICS    31d99572-bf8a-4658-828e-4f7c138ca722   notify

EARCLIP — Standard SIG services
  Heart Rate Service                  0x180D
    Heart Rate Measurement            0x2A37   notify + read
    Body Sensor Location              0x2A38   read
  Battery Service                     0x180F
    Battery Level                     0x2A19   read + notify
  Device Information Service          0x180A
    Manufacturer Name                 0x2A29   read
    Model Number                      0x2A24   read
    Hardware Revision                 0x2A27   read
    Firmware Revision                 0x2A26   read
    Serial Number                     0x2A25   read

EDGE — Single custom service (Path B)
  Service                             0x00FF
    Control                           0xFF01   read + write
                                               opcodes 0xA2..0xD0 inc.
                                               🆕 0xC1/0xC3/0xC4 (relay control)
    OTA Data                          0xFF02   write + write-no-response
    Status (multiplexed)              0xFF03   read + notify (indicate)
                                               own packets 0xF0..0xF3
                                               🆕 relay packets 0xF4..0xF7
                                               OTA codes 0x01..0x08
    PPG Stream                        0xFF04   read + notify

OTA — Shared between Edge and Earclip (same UUIDs)
  Service                             0x00FF
    Control                           0xFF01
    Data                              0xFF02
    Status                            0xFF03
```

### 9.2 Wire conventions

- Endianness: **little-endian** everywhere.
- Structs: byte-packed, no padding except where explicitly named (`reserved_*`).
- Booleans: `u8` with values `0` or `1` — never a C `bool`.
- Fixed-point: scaled integers (`_x10`, `_x100`, `_x1000`) — no float in any wire format.
- CRC for config and ESP-NOW frames: **CRC-16-CCITT-FALSE** (poly `0x1021`, init `0xFFFF`, no reflect, no xor-out).
- CRC for OTA pages: **CRC-32** little-endian.

### 9.3 Authoritative sources

| What | Where |
|---|---|
| Earclip UUIDs (TS) | [`protocol/uuids.ts`](../protocol/uuids.ts) |
| Earclip UUIDs (C) + all wire structs + opcodes + PEER_ROLE enum | [`protocol/narbis_protocol.h`](../protocol/narbis_protocol.h) |
| CRC-16 reference implementation | [`protocol/narbis_protocol.c`](../protocol/narbis_protocol.c) lines 23–37 |
| Earclip GATT registration (incl. PEER_ROLE handler) | [`firmware/main/ble_service_narbis.c`](../firmware/main/ble_service_narbis.c) |
| Earclip OTA state machine + safety gates | [`firmware/main/ble_ota.c`](../firmware/main/ble_ota.c) |
| Earclip multi-central transport / per-slot role / conn-update profiles | [`firmware/main/transport_ble.c`](../firmware/main/transport_ble.c) |
| Battle-tested payload parsers (TS) | [`dashboard/src/ble/parsers.ts`](../dashboard/src/ble/parsers.ts) |
| Path B architecture overview | [`docs/path-b-implementation-brief.md`](./path-b-implementation-brief.md) |
| Path B relay handoff details | [`docs/path-b-relay-handoff.md`](./path-b-relay-handoff.md) |
| **Edge firmware (current, Path B, multi-file project)** | `C:\NARBIS APP\Oct_4_25\Clone\edge-firmware\v4\Code-Glasses\` — `main/main.c` plus components `narbis_ble_central` and `narbis_protocol` |
| Edge firmware (legacy monolith, kept for reference only) | [`EDGE/EDGE FIRMWARE/main_v4_14_38 (1).c`](../EDGE/EDGE%20FIRMWARE/main_v4_14_38%20(1).c) |
| Firmware image header validator (JS reference) | [`ota-additions/firmware_validator.js`](../ota-additions/firmware_validator.js) |
| ESP-NOW protocol (historical only — Path B removed it) | [`docs/protocol.md`](./protocol.md) |

### 9.4 Edge firmware line-number index (current Path B build)

In `C:\NARBIS APP\Oct_4_25\Clone\edge-firmware\v4\Code-Glasses\main\main.c`:

| Topic | Lines |
|---|---|
| Service / characteristic UUIDs | 1563–1567 |
| Advertising parameters | 4263–4310 |
| 5-tap "forget earclip" gesture | 3670–3686 |
| Command opcode dispatch (incl. 0xC1/C3/C4) | 3862–4198 |
| OTA state machine | 3684–4258 |
| `0xF0`/`0xF1`/`0xF2`/`0xF3` builders | 3012–3151, 5473–5523 |
| `0xF4`/`0xF5`/`0xF6`/`0xF7` relay frame emission | 5816–5860, 4700–4709, 5775–5783 |

In `components/narbis_ble_central/`:

| Topic | Where |
|---|---|
| Central state machine + scan/pair/discover/subscribe | `narbis_ble_central.c` |
| Public callback registration API | `include/narbis_ble_central.h` lines 32–105 |
| Earclip-side characteristic UUIDs the central discovers | mirrored in `components/narbis_protocol/narbis_protocol.h` |
