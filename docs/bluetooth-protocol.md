# Narbis Bluetooth Protocol — App Integration Guide (iOS / Apple Watch / web)

> **Audience.** Engineers building apps that talk to the **Narbis Edge** glasses and the **Narbis Earclip** over BLE — iOS 13+ / watchOS 6+ via Core Bluetooth, or a web app via Web Bluetooth. The wire protocol is identical; the Swift snippets below port directly to `navigator.bluetooth` + `characteristic.writeValue()`.
>
> **Scope.** Scanning, connecting, GATT discovery, command writes, notification parsing, **driving the lens** ([§4.8](#48-driving-the-edge-lens)), OTA firmware update, troubleshooting. Includes Swift snippets you can paste into a project.
>
> **Architecture — read this first.** **All coherence + breathing-pacer processing runs app-side**, in every client (iOS *and* web), via the same Mode A/B/C engine — see [`coherence-engine.md`](./coherence-engine.md). The glasses are a **display**: the app does the HRV math and **drives the lens by commanding the firmware's breathe / static program** ([§4.8](#48-driving-the-edge-lens)), so the glasses render the smooth waveform locally while the app owns the algorithm. The older "forward beats to the Edge and let its firmware compute coherence + drive the lens" flow (`0xCA` + `0xB7`) still exists as the **legacy / Standard on-glasses mode** ([§4.7](#47-integration-patterns--where-coherence-runs)) but is **no longer the recommended path**.
>
> **Out of scope.** Pairing/bonding (neither device requires encryption today; that's a v2 item).
>
> **Related.** [`docs/coherence-engine.md`](./coherence-engine.md) documents the app-side Coherence Engine (the three modes, the HRV math, and the lens-drive path); [`docs/coherence-algorithm-reference.md`](./coherence-algorithm-reference.md) is the verbatim firmware coherence pipeline. [`docs/protocol.md`](./protocol.md) is historical background; [`docs/path-b-implementation-brief.md`](./path-b-implementation-brief.md) and [`docs/path-b-relay-handoff.md`](./path-b-relay-handoff.md) document the current relay architecture in detail.

> ### 📝 Changelog
>
> **2026-07-10 (second pass) — deeper adversarial verification, 20 further corrections.** Highlights, all verified against firmware source: (1) **`0xF2` byte 17 is `pacer_rate_q5` — quintets (BPM × 5)**, not a BPM; 30 = 6.0 BPM, range 15–50; forced to 30 each cycle when `0xB9 0` — §4.4.3/§4.3.1C. (2) **No `0xF2` frames at all until the first successful coherence compute** (every live frame has `n_ibis_used ≥ min_ibis`) — §4.4.3, §8. (3) **`0xB8` difficulty is now only a gamma curve (1.0/1.5/2.0/3.0) on the coh-lens opacity mapping** — the peak-window/score shaping was reverted in v4.14.26; args > 3 ignored — §4.3.1B. (4) **With `0xB9 0` the coherence pacer is hard-coded 6.0 BPM; `0xB1`/`0xB2` never affect the PPG programs** (fixed 40/60 split). (5) **A bare 1-byte `[0xB0]` is the legacy static-duty write (~69 % tint), not breathe** — always send the arg. (6) **`0xBA` is a required per-breath keep-alive** (exact-cycle override expires ~2 cycles after the last write) and firmware clamps `cycle_ms` to 2000–30000 ms — §4.3/§4.8.4. (7) **Edge `0xFF01` has no write-no-response property** — per-beat `0xCA` (and all control writes) must be write-with-response; Web Bluetooth `writeValueWithoutResponse()` throws `NotSupportedError`; only `0xFF02` OTA data supports WNR — §4.7.2/§7a + all snippets. (8) **Earclip pairing scan corrected**: directed 30-s windows + ~5-s backoff retried indefinitely; general scan only when no MAC is persisted — §4.6. (9) **`0xF1` payload max is 63 B, the log heartbeat is ~30 s**, and the subscribe-hello (`Narbis fw v<version> …`) is the Edge's only firmware-version probe — §4.4.2/§4.8.6. (10) **`0xF3` jitter counters are cumulative since boot** (5-s reset removed) — §4.4.4. (11) **"Silently clamps, never NACKs" is not universal**: `0xB7`/`0xB8` ignore out-of-range args, `0xE0` rejects the whole write — §4.3. (12) **New earclip FACTORY_RESET characteristic documented** (`c0e221b1-…`, 4-B magic `'NUKE'`, wipes NVS) — §3.1.9 — and **PEER_ROLE `0` is not a no-op** (applies BATCHED immediately) — §3.7. (13) **DETECTOR_STATS records lead with a u32 `timestamp_ms`** (parsers were off by 4 B) and emit under FIXED mode too — §3.1.8. (14) **§3.6 write-validation bounds listed in full** (template/NCC/Kalman/watchdog/alpha ranges). (15) OTA: **stop-and-wait is mandatory** (data during page-pending is dropped; a write must never straddle a 4096-B page boundary) and **`app_desc` sits at fixed file offset 0x20, `version[32]` at 0x30** — §6.4/§6.7. (16) Behavioral notes added: magnet gestures stay live while connected (only OTA blocks them); the lens **freezes on disconnect** (crash = wearer stuck dark); `0xA4` does not restart the session clock (`remaining ≈ minutes × 60 − uptime_s`); standalone magnet-tap programs render the NVS-persisted opcode values, not fixed defaults — §4.1.1/§4.8.1/§4.3/§8.
>
> **2026-07-10 — wire-level corrections from an adversarial firmware verification.** Eight fixes after line-by-line verification against glasses fw `main` and earclip fw `main`: (1) **§3.1.1/§3.5 — the custom Narbis IBI characteristic never batches**: it notifies once per beat in *both* `ble_profile` modes; `ble_batch_period_ms` / up-to-9-R-R batching applies only to the standard HRS `0x2A37` characteristic. (2) **§4.2/§7.3/§6.1/§9.1 — the Edge's `0xFF03` uses plain notify**, not "indicate internally" (`BLE_GATT_CHR_F_NOTIFY`, `ble_gatts_notify_custom()`); the "one in-flight indicate" OTA pacing rule is gone. (3) **§4.3 `0xC3` is currently unusable** — the glasses forward a v3-era **50-byte** config payload (`NARBIS_CONFIG_WIRE_SIZE = 50`), which a v4 earclip rejects (expects 74 B); write earclip config directly until the glasses relay is rebuilt against config v4. (4) **`0xFF04` (§4.5) and `0xF0` (§4.4.1) are not emitted on current glasses builds** — the on-glasses PPG front-end was removed; layouts kept for older firmware. (5) **§4.4.4 `0xF3` byte 21 `led_duty` is a 0–100 percentage**, not 0–255. (6) **§6.4 — the `0x06` PAGE_CRC frame packs the page number *and* the CRC32 big-endian** (Swift/JS unpack fixed), and status frame lengths corrected: on the Edge READY/SUCCESS/CANCELLED = 1 B and ERROR = 2 B, while the earclip zero-pads the same codes to 4 B — dispatch on the first byte (+ reserved PROGRESS `0x02` documented). Also noted: the final partial page gets no PAGE_CRC, and PAGE_RESEND rewinds the whole page. (7) New **§4.1.1 standalone programs & magnet gestures** — short-tap window is **0.15–4 s** (`HALL_SHORT_MIN_MS = 150`). (8) Additions: `0xA8` accepts an optional `[size u32 LE]` for an image-sized erase (Edge only — §4.3/§6.3), session auto-sleep semantics on `0xA4` (default 30 min from wake → deep sleep), stock builds heartbeat `0xF6 linked=0` every ~30 s (§4.4.7), and the Edge accepts a **single client** (advertising stops on connect — §4.1).
>
> **2026-07-08 — sync to current glasses fw main + Mode B/C rename.** Five corrections after re-auditing against glasses-firmware `main` (post-`4.15.6-strobe-sync`), earclip firmware, and the dashboard: (1) **Edge idle advertising teardown is now 2 minutes, not 5** (`BLE_IDLE_TIMEOUT_MS = 120000`), and teardown fully powers down the radio — §2.5, §4.1, §7.6, §8. (2) **Edge supervision timeout is now 32 s, not 20 s** (`supervision_timeout = 3200`, the BLE max — raised for the image-sized OTA erase window) — §1, §4.1, §6.8, §7.9. (3) **The Edge's earclip-central (relay) is compile-disabled on stock builds** — `EARCLIP_CENTRAL_ENABLED 0` eliminates the ~80 mA idle scan drain; §4.6's relay frames/opcodes are implemented but inert unless rebuilt with the flag on — §1, §4.6, §8. (4) **Mode names updated (#85–#90):** Mode B is now the **Static Pacer** (fixed 4.0–10.0 br/min, needs no accelerometer) and the resonance search runs only in **Mode C "Settle & Find"** — §3a and §4.7.1 corrected; **only Mode C requires the H10 accelerometer**. (5) **§3.6 versioning corrected:** the earclip does **not** reject config writes with `config_version < 4` — it ignores the writer's version byte and forces `4` on every accepted write; the `≥ 4` check runs when loading persisted blobs from NVS at boot.
>
> **2026-06-30 — Edge audit corrections (synced to glasses firmware `4.15.6-strobe-sync`).** Three Edge-side errors fixed after a line-by-line diff against the live firmware: (1) **§4.4.4 `0xF3` `led_mode` legend was wrong** — the real `led_mode_t` is `0` strobe, `1` static, `2` breathe, `3` breathe+strobe, `4` pulse-on-beat, `5` coherence-breathe, `6` coherence-breathe+strobe, `7` coherence-lens (there is **no** `off` value); a client decoding byte 20 against the old legend mislabeled every mode. (2) **Breathe+strobe now has an opcode** — `0xB0 0x01` (fw ≥ 4.15.6); the §4.3 opcode table and §4.8.5 are updated (previously documented as "no dedicated standalone opcode yet"). (3) **§6.2 OTA "Recommended chunk size" corrected `240 → 244 B`** (`MTU − 3` at the negotiated MTU 247), reconciling it with §2.4 / §6.8 and `NARBIS_OTA_CHUNK_SIZE = 244`. Earclip-side reference unchanged this pass.
>
> **2026-06-17 — coherence is app-side, period.** All coherence + breathing-pacer processing now runs **app-side** in every client (iOS *and* web) via the Mode A/B/C engine; the glasses are a **display** the app drives by commanding the firmware's breathe / static program plus the new **`0xBA` breathe-sync** opcode. New **[§4.8 "Driving the Edge lens"](#48-driving-the-edge-lens)** documents the lens-drive scheme (stream-vs-command, breathe + strobe ops), the **lens duty→opacity floor**, and the **breath-phase sync rule** — send `0xBA` / rate / depth **only at the breath-cycle boundary**, never mid-breath, because the firmware re-renders `wave × depth` every 10 ms from live params and a mid-breath change warps the waveform into a visible stutter. [§4.7](#47-integration-patterns--where-coherence-runs) reframed: app-side is standard; the `0xCA` on-glasses pipeline is legacy/Standard.
>
> **2026-06-16 — app-side Coherence Engine.** The dashboard can now run the full coherence + breathing-pacer algorithm app-side and drive the lens by **commanding the firmware's own breathe / static program** (`0xB0` + `0xB1` rate + `0xA2` depth, or `0xA5` static setpoint) instead of streaming per-tick PWM or routing through the `0xCA` built-in pipeline. New companion doc [`coherence-engine.md`](./coherence-engine.md) covers the architecture and the three modes (then named Follow / Resonance / Standard — **since renamed:** B is the Static Pacer, the resonance search lives in Mode C "Settle & Find"; see the 2026-07-08 entry); [§4.7](#47-integration-patterns--where-coherence-runs) frames app-side (recommended) vs the legacy on-glasses path.
>
> **2026-06-09 — audit + sync to current firmware.** Notable changes since the previous version of this doc:
>
> - **Polar H10 path is now first-class.** ~~iOS apps that pair their own H10 should send IBIs to the Edge via `0xCA` rather than computing coherence app-side.~~ **Superseded 2026-06-17 — coherence is now computed app-side (Mode A/B/C) in every client; the `0xCA` on-glasses pipeline is the legacy/Standard path ([§4.7](#47-integration-patterns--where-coherence-runs)).** The `0xCA` / `0xCB` / `0xB7` opcodes remain valid for that legacy path and for a firmware-coherence readout, but the app should drive the lens itself ([§4.8](#48-driving-the-edge-lens)).
> - **Edge BLE stack:** documentation corrected from `Bluedroid` → `NimBLE` (migration PR #22). No client-side impact — the GATT surface is identical.
> - **New Edge opcodes documented:** `0xC5` refresh earclip config, `0xCA` external-IBI injection (H10 path), `0xCB` set HR source (`0` = earclip, `1` = H10/external), `0xE0` live coherence-pipeline tuning. `0xC0` marked as reserved / no-op.
> - **New [§4.3.1 "Edge-side algorithm tuning"](#431-edge-side-algorithm-tuning) subsection** — full `narbis_coh_params_t` byte layout, defaults, ranges, FFT-bin grid reference, Swift mirror, and notes on `0xB8` difficulty preset + `0xB9` adaptive pacer.
> - **New [§4.7 "Driving the Edge from an external HR source"](#47-integration-patterns--where-coherence-runs) end-to-end Swift example** for the H10 path (per-connect setup + per-beat forward).
> - **Edge MTU corrected:** `247`, not `517`. Doc was wrong on this since the original draft — both Edge and earclip request the same MTU.
> - **Edge TX power corrected:** uniform **0 dBm** across ADV / SCAN / CONN (was previously tiered `−6 dBm` ADV / `−12 dBm` CONN). Roughly 4× connected range at +1 mA idle.
> - **§3.1.8 diagnostics bitmask:** added `0x20 DETECTOR_STATS` (adaptive-detector per-beat snapshot, v4 / Path C only).
> - **`0xB6` pulse-on-beat note:** clarified it works with `0xCA`-injected H10 beats too, not just earclip beats via the relay.
> - **`0xF2` coherence frame, byte 17:** was documented as `reserved`, is now ~~`pacer_bpm`~~ (current adaptive-pacer target, PR #31 / #32). Length is still 18 B. **(Corrected 2026-07-10: the field is `pacer_rate_q5` — quintets, BPM × 5, not a plain BPM — [§4.4.3](#443-coherence-packet-0xf2--18-b).)**
> - **Earclip `narbis_runtime_config_t`:** bumped from Path B (`config_version 3`, 48-byte struct, 50-byte wire) to Path C (`config_version 4`, 72-byte struct, 74-byte wire) with 16 new adaptive-detector + Layer-E auxiliary fields appended. First 48 bytes are byte-identical between v3 and v4 — partial v3 reads still work. ~~v4 firmware rejects writes with `config_version < 4`~~ **(Corrected 2026-07-08: the firmware ignores the writer-supplied version byte and forces `config_version = 4` on every accepted write; the `≥ 4` check runs at NVS load, not on writes.)** See [§3.6](#36-the-runtime-config-struct).
> - **Relayed CONFIG frame `0xF4`:** grew from 51 B (1 + 50) to 75 B (1 + 74) as a consequence of the v4 struct.
> - **§9.4 firmware index:** replaced stale Edge `main.c` line numbers with function-name anchors so the table doesn't rot every commit.

> ### 🆕 Path B → Path C (`config_version` 3 → 4) — read this first
>
> The architecture changed substantially in 2025. Important consequences for iOS:
>
> - **ESP-NOW is gone.** The earclip is BLE-only. Wi-Fi is no longer brought up.
> - **The Edge is now dual-role.** It is still a BLE peripheral (talks to your iOS app on `0x00FF`) **and** is now also a BLE central that connects to the earclip and **relays** earclip data through to you on the same `0x00FF` service via new frame types (`0xF4`–`0xFA`). See [§4.6](#46-the-edge-as-relay-path-b). **⚠️ 2026-07: the central/relay is compile-disabled on stock builds** (`EARCLIP_CENTRAL_ENABLED 0`) — see the note at the top of §4.6.
> - **The earclip is multi-central.** Your iOS app and the Edge can be connected to it simultaneously. Each central writes its role on connect to a new **PEER_ROLE characteristic** (see [§3.7](#37-peer_role--e987719a)) so the earclip knows which conn-update profile to apply.
> - **Mode is now 2-axis.** The old `transport_mode` field is gone — only `ble_profile` and `data_format` remain. `narbis_runtime_config_t` shrank from 56 → 48 bytes in Path B (`config_version 3`) and has since **grown to 72 bytes** in Path C (`config_version 4`) with the adaptive-detector knobs (NCC template, Kalman gate, watchdog). Wire size with CRC is **74 B**. The first 48 bytes are identical to Path B; defaults make the new fields no-ops (`detector_mode = FIXED`) so legacy Path-B-aware clients still interoperate. See [§3.6](#36-the-runtime-config-struct).
> - **New Edge opcodes** `0xC1` (forget earclip), `0xC3` (relay config write to earclip), `0xC4` (toggle raw-PPG relay), `0xC5` (refresh earclip config), `0xCA` (external-IBI injection for Polar H10), `0xCB` (set HR source), `0xE0` (coherence-pipeline tuning) — see [§4.3](#43-control-characteristic-0xff01--command-opcodes).
>
> **Two valid integration patterns** for an iOS app:
> 1. **Direct, two-connection** — connect to both the earclip and the Edge separately. Best if you want raw earclip data with no extra hop.
> 2. **Single-connection via Edge** — connect only to the Edge; receive relayed earclip IBI/battery/config/raw/diagnostics on `0xFF03` frames `0xF4`–`0xFA`. Simpler from a CoreBluetooth state-management standpoint — but **requires a relay-enabled firmware build** ([§4.6](#46-the-edge-as-relay-path-b)); stock builds ship with the relay off.

---

## Table of contents

1. [The two devices at a glance](#1-the-two-devices-at-a-glance)
2. [Scanning & connecting](#2-scanning--connecting)
3. [Earclip BLE — full reference](#3-earclip-ble--full-reference) (incl. 🆕 [§3.7 PEER_ROLE](#37-peer_role--e987719a) · 🆕 [§3a Polar H10 data source](#3a-polar-h10--app-side-data-source))
4. [Edge glasses BLE — full reference](#4-edge-glasses-ble--full-reference) (incl. 🆕 [§4.6 The Edge as relay](#46-the-edge-as-relay-path-b) · 🆕 [§4.7 Integration patterns](#47-integration-patterns--where-coherence-runs) · 🆕 [§4.8 Driving the lens](#48-driving-the-edge-lens))
5. [Configuring the earclip from iOS](#5-configuring-the-earclip-from-ios)
6. [OTA — shared between both devices](#6-ota--shared-between-both-devices)
7. [iOS / Core Bluetooth gotchas](#7-ios--core-bluetooth-gotchas) (incl. 🆕 [§7a Web Bluetooth](#7a-web-bluetooth-gotchas))
8. [Troubleshooting matrix](#8-troubleshooting-matrix)
9. [Reference data](#9-reference-data)

---

## 1. The two devices at a glance

| Aspect | Narbis Edge (glasses) | Narbis Earclip |
|---|---|---|
| Advertised name | `Narbis_Edge` (exact match) | `Narbis Earclip <mac>` (prefix match) |
| MCU | ESP32 classic | ESP32-C6 |
| BLE stack | NimBLE | NimBLE |
| BLE roles | **peripheral + central** (Path B: connects to earclip itself) — ⚠️ central **compile-disabled on stock builds** ([§4.6](#46-the-edge-as-relay-path-b)) | peripheral, **multi-central** (up to 3 simultaneous) |
| Custom primary service | none advertised | `a24080b2-8857-4785-b3ba-a43b66af4f28` (128-bit) |
| Standard SIG services | none | HRS `0x180D`, Battery `0x180F`, DIS `0x180A` |
| OTA service UUID | `0x00FF` (chars `0xFF01`–`0xFF04`) | `0x00FF` (chars `0xFF01`–`0xFF03`) |
| Encryption / bonding | none | none |
| Negotiated MTU | requests 247 | requests 247 |
| Connection interval (typical) | 20–30 ms, slave latency 1, 32 s timeout | per-central, picked from the role byte: DASHBOARD → LOW_LATENCY (15–30 ms), GLASSES → BATCHED (50–100 ms) |
| Earclip ↔ Edge link | **BLE central role** (Edge is the central; earclip is peripheral). ESP-NOW removed in Path B. **Compile-disabled on stock builds** ([§4.6](#46-the-edge-as-relay-path-b)). | Same — earclip is the peripheral |

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

**✅ Exact working JS (Web Bluetooth — the Narbis dashboard's `connect()` methods).** There is no background scan list in Web Bluetooth: `requestDevice()` opens the browser's device chooser and must be called from a **user gesture** (a click/tap — see [§7a](#7a-web-bluetooth-gotchas)). You connect one device per call, with its own filter:

```js
// Edge glasses — dashboard/src/ble/edgeDevice.ts
const EDGE_SVC = '000000ff-0000-1000-8000-00805f9b34fb';
const edge = await navigator.bluetooth.requestDevice({
  filters: [{ name: 'Narbis_Edge' }, { services: [EDGE_SVC] }],
  optionalServices: [EDGE_SVC],
});

// Earclip — dashboard/src/ble/narbisDevice.ts
const NARBIS_SVC = 'a24080b2-8857-4785-b3ba-a43b66af4f28';
const earclip = await navigator.bluetooth.requestDevice({
  filters: [{ services: [NARBIS_SVC] }, { namePrefix: 'Narbis Earclip' }],
  optionalServices: [NARBIS_SVC, 0x180d, 0x180f, 0x180a],
});

// Polar H10 — dashboard/src/ble/polarH10.ts (HR + the PMD accelerometer service)
const PMD_SVC = 'fb005c80-02e7-f387-1cad-8acd2d8df0c8';
const h10 = await navigator.bluetooth.requestDevice({
  filters: [{ services: [0x180d] }, { namePrefix: 'Polar' }],
  optionalServices: [0x180d, PMD_SVC],
});
```

> ⚠️ **`optionalServices` is mandatory in Web Bluetooth.** Every service you later call `getPrimaryService()` on must appear in a filter **or** `optionalServices`, or the call throws `SecurityError`. This is the #1 Web-Bluetooth footgun — see [§7a](#7a-web-bluetooth-gotchas).

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

**✅ Exact working JS (`dashboard/src/ble/narbisDevice.ts` — `openSession()`).** Web Bluetooth discovers on demand: connect the GATT server, get the service, then each characteristic:

```js
const server = await device.gatt.connect();
const svc = await server.getPrimaryService(NARBIS_SVC); // must be in optionalServices (see §2.2)
const [chIbi, chSqi, chRaw, chBatt, chCfg, chCfgWrite, chMode] = await Promise.all([
  svc.getCharacteristic(NARBIS_CHR_IBI_UUID),
  svc.getCharacteristic(NARBIS_CHR_SQI_UUID),
  svc.getCharacteristic(NARBIS_CHR_RAW_PPG_UUID),
  svc.getCharacteristic(NARBIS_CHR_BATTERY_UUID),
  svc.getCharacteristic(NARBIS_CHR_CONFIG_UUID),
  svc.getCharacteristic(NARBIS_CHR_CONFIG_WRITE_UUID),
  svc.getCharacteristic(NARBIS_CHR_MODE_UUID),
]);
// Subscribe to a notify characteristic:
chIbi.addEventListener('characteristicvaluechanged', (e) => onIbi(e.target.value /* DataView */));
await chIbi.startNotifications();
```

### 2.4 MTU — check it after discovery, not before

```swift
let writeNoRespMax = peripheral.maximumWriteValueLength(for: .withoutResponse)
let writeWithRespMax = peripheral.maximumWriteValueLength(for: .withResponse)
```

This value is final only **after** services are discovered. Both devices request an ATT MTU of 247, but iOS may cap lower — read the actual value before you start chunking OTA pages.

> **JS note:** Web Bluetooth has **no MTU API** — `writeValue()` chunks for you, and the dashboard simply caps OTA chunks at a fixed 244 B (`CHUNK_SIZE` in `webapp/ota/index.html`). There is nothing to read; just keep writes ≤ 244 B and let the browser handle fragmentation.

### 2.5 Reconnection

Both devices auto-resume advertising on disconnect. From your `centralManager(_:didDisconnectPeripheral:error:)` delegate, just call `central.connect(peripheral, options: ...)` again.

> **Edge-only quirk:** the glasses tear down their advertising entirely after **2 minutes** with no client connected (`BLE_IDLE_TIMEOUT_MS = 120000`; was 5 minutes before fw main 2026-07) — and the teardown fully powers down the radio. The user has to wake the device (magnet tap on the temple) to start advertising again. Surface this in your UX rather than silently retrying forever.

---

## 3. Earclip BLE — full reference

The earclip exposes four services: one custom Narbis service with ten characteristics, and three standard SIG services (Heart Rate, Battery, Device Information). OTA is covered separately in [§6](#6-ota--shared-between-both-devices).

All multi-byte fields are **little-endian on the wire**. Structs are byte-packed (no padding).

### 3.1 Custom Narbis service — `a24080b2-8857-4785-b3ba-a43b66af4f28`

The single best filter for "this is an earclip" is the presence of this 128-bit service after connect. Every dashboard data path uses one of its characteristics.

| Characteristic | UUID | Properties | Wire size | Notes |
|---|---|---|---|---|
| IBI | `78ef492f-66be-438d-a91e-ddfdb441b7bb` | notify | 4 B | One inter-beat interval |
| SQI | `2b614c61-bcdf-4a3f-a7e8-3b5a860c0347` | notify | 12 B | Signal-quality summary |
| RAW_PPG | `6bacca91-7017-40fa-bb91-4ebf28a65a99` | notify | 4 + 8·N B (N ≤ 29) | Sample batch |
| BATTERY | `b59d3ba1-78d1-4260-93c2-7e9e02329777` | notify | 4 B | Richer than `0x2A19` |
| CONFIG | `553abc98-6406-4e37-b9fd-34df85b2b6c1` | read + notify | **74 B** | Config + 16-bit CRC (v4 / Path C; was 50 B in v3 / Path B, 58 B before that) |
| CONFIG_WRITE | `129fbe56-cbd6-4f52-957b-d80834d6abf3` | write | **74 B** | Config + 16-bit CRC |
| MODE | `71db6de8-5bff-480f-8db1-0d01c90d17d0` | write | **2 B** | Quick mode swap (legacy 3-B form still accepted, first byte ignored) |
| **PEER_ROLE** | `e987719a-26a6-48d4-b8e9-128994e62e6c` | write | 1 B | **🆕 Path B.** Central announces its role; earclip picks the conn-update profile. See [§3.7](#37-peer_role--e987719a) |
| DIAGNOSTICS | `31d99572-bf8a-4658-828e-4f7c138ca722` | notify | variable | Optional debug stream |
| **FACTORY_RESET** | `c0e221b1-1633-0f9d-364a-7e47a8d9c411` | write | 4 B | ⚠️ Destructive — magic `'NUKE'` wipes NVS ([§3.1.9](#319-factory_reset--c0e221b1)) |

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

Notify cadence: **one notification per beat (~1 Hz at rest) in *both* `ble_profile` modes** — this characteristic never batches. The firmware pushes every accepted `beat_event_t` straight out with no profile check (`ble_service_narbis_push_ibi()`), and the `ble_batch_period_ms` flush interval is routed to the standard HRS `0x2A37` characteristic only (`config_manager.c` → `ble_service_hrs_set_batch_period()`). If you want batched R-R delivery, subscribe to HRS ([§3.2](#32-heart-rate-service--0x180d)); if you want per-beat delivery regardless of the configured profile, this characteristic is the one.

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

**✅ Exact working JS (`dashboard/src/ble/parsers.ts`):**

```js
function parseNarbisIBI(dv /* DataView */) {
  if (dv.byteLength < 4) throw new Error(`narbis IBI payload too short: ${dv.byteLength}`);
  return {
    ibi_ms:          dv.getUint16(0, true),
    confidence_x100: dv.getUint8(2),
    flags:           dv.getUint8(3),
  };
}
const bpm = ibi_ms > 0 ? Math.round(60000 / ibi_ms) : 0;
```

#### 3.1.2 SQI — `2b614c61-…`

| Offset | Size | Field | Type | Notes |
|---|---|---|---|---|
| 0 | 2 | `sqi_x100` | u16 LE | 0–100 → 0.00–1.00 |
| 2 | 4 | `dc_red` | u32 LE | Red-channel DC level, ADC counts |
| 6 | 4 | `dc_ir` | u32 LE | IR-channel DC level, ADC counts |
| 10 | 2 | `perfusion_idx_x1000` | u16 LE | Perfusion index × 1000 |

Useful as a "is the earclip on the ear and well-coupled?" indicator. Below `sqi_x100 < 30` you should warn the user.

**✅ Exact working JS (`dashboard/src/ble/parsers.ts`):**

```js
function parseSQI(dv /* DataView */) {
  if (dv.byteLength < 12) throw new Error(`SQI payload too short: ${dv.byteLength}`);
  return {
    sqi_x100:            dv.getUint16(0, true),
    dc_red:              dv.getUint32(2, true),
    dc_ir:               dv.getUint32(6, true),
    perfusion_idx_x1000: dv.getUint16(10, true),
  };
}
```

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

**✅ Exact working JS (`dashboard/src/ble/parsers.ts`):**

```js
function parseRawPPG(dv /* DataView */) {
  if (dv.byteLength < 4) throw new Error(`raw PPG header too short: ${dv.byteLength}`);
  const sample_rate_hz = dv.getUint16(0, true);
  const n_samples = dv.getUint16(2, true);
  const expected = 4 + n_samples * 8;
  if (dv.byteLength < expected) throw new Error(`raw PPG truncated: have ${dv.byteLength}, need ${expected}`);
  const samples = [];
  let off = 4;
  for (let i = 0; i < n_samples; i++) {
    const red = dv.getUint32(off, true); off += 4;
    const ir  = dv.getUint32(off, true); off += 4;
    samples.push({ red, ir });
  }
  return { sample_rate_hz, n_samples, samples };
}
```

#### 3.1.4 BATTERY — `b59d3ba1-…`

| Offset | Size | Field | Type | Notes |
|---|---|---|---|---|
| 0 | 2 | `mv` | u16 LE | Battery voltage in millivolts |
| 2 | 1 | `soc_pct` | u8 | 0–100 |
| 3 | 1 | `charging` | u8 | 0 = not charging, 1 = charging |

Use this rather than the standard `0x2A19` if you want the millivolts and charging-state bits.

**✅ Exact working JS (`dashboard/src/ble/parsers.ts`):**

```js
function parseNarbisBattery(dv /* DataView */) {
  if (dv.byteLength < 4) throw new Error(`narbis battery payload too short: ${dv.byteLength}`);
  return { mv: dv.getUint16(0, true), soc_pct: dv.getUint8(2), charging: dv.getUint8(3) };
}
```

#### 3.1.5 CONFIG — `553abc98-…`

Read or subscribe to this to get the full live `narbis_runtime_config_t`. Wire layout is the **72-byte** packed struct followed by a 2-byte CRC-16-CCITT-FALSE (poly `0x1021`, init `0xFFFF`, no reflect, no xor-out) for a total of **74 B** (`NARBIS_CONFIG_WIRE_SIZE`).

> **Versioning note.** The struct shrank from 56 B → 48 B in `config_version 3` (Path B) when `transport_mode`, `partner_mac[6]`, and `espnow_channel` were removed (ESP-NOW deleted), then grew from 48 B → 72 B in `config_version 4` (Path C) with the 16 adaptive-detector + Layer-E auxiliary fields appended. The first 48 bytes are identical to Path B, so an iOS client only reading the Path B prefix still gets correct values for everything it knew about.

The struct field-by-field is in [§3.6](#36-the-runtime-config-struct).

The earclip notifies on this characteristic **after every successful CONFIG_WRITE or MODE write** so subscribed clients see fresh config without polling.

#### 3.1.6 CONFIG_WRITE — `129fbe56-…`

Write 74 B (full 72-B config + 2-B CRC) to apply settings. The firmware validates ranges, applies in place, persists to NVS, then notifies on the CONFIG characteristic.

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

**✅ Exact working JS (`dashboard/src/ble/narbisDevice.ts` — `writeMode()`):**

```js
async function writeMode(chMode, profile, format) {
  const buf = new Uint8Array([profile & 0xff, format & 0xff]); // [1, 0] = LOW_LATENCY + IBI_ONLY
  await chMode.writeValueWithResponse(buf);
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
0x01  PRE_FILTER       raw DC-removed PPG samples
0x02  POST_FILTER      bandpass-filtered samples
0x04  PEAK_CAND        Elgendi peak candidates pre-validator
0x08  AGC_EVENT        per-AGC-step LED current changes
0x10  FIFO_OCCUP       MAX3010x FIFO occupancy at each drain
0x20  DETECTOR_STATS   🆕 v4 (Path C) — adaptive-detector snapshot per accepted beat.
                       Record layout (packed): timestamp_ms u32 LE FIRST, then
                       ncc_x1000 i16, alpha_x1000 u16, kalman_x_ms u16,
                       kalman_r_ms2 u16, beats_learned u32, ncc_rejects u16,
                       kalman_rejects u16, watchdog_resets u16,
                       beats_in_template u8, detector_mode u8.
                       ⚠️ The leading u32 timestamp was previously undocumented —
                       a parser that starts at ncc_x1000 is off by 4 bytes.
                       Emitted under BOTH detector modes (the snapshot fires on
                       every accepted beat regardless; the trailing mode byte
                       tells you which pipeline produced it) — the stats fields
                       are only *meaningful* under ADAPTIVE (1).
```

Skip this characteristic unless you're building a tuning UI.

#### 3.1.9 FACTORY_RESET — `c0e221b1-…`

> ### ⚠️ Destructive — do not wire this to anything casual
>
> Write-only, exactly **4 bytes**: the magic `'NUKE'` (`0x454B554E` as u32 LE, i.e. bytes `4E 55 4B 45` = ASCII `NUKE`). A valid write **wipes the earclip's NVS** — runtime config, calibration, everything — and the device reverts to compiled-in defaults on the next boot. Any other value or length is rejected. There is no confirmation step and no undo. Keep it behind a long-press + confirm UI if you expose it at all.

### 3.7 PEER_ROLE — `e987719a-26a6-48d4-b8e9-128994e62e6c`

🆕 **New in Path B.** A 1-byte write characteristic. Each connecting central writes its role on connect, and the earclip uses that single byte to pick the BLE conn-update profile for *that specific connection*.

| Value | Symbol | Profile applied |
|---|---|---|
| `0` | UNKNOWN | ⚠️ **Not a no-op** — applies the `BATCHED` conn profile immediately, same as `2`. Writing `0` to "reset" a connection demotes a LOW_LATENCY client to BATCHED. Don't write it; if you have nothing to announce, write nothing. |
| `1` | DASHBOARD | `LOW_LATENCY` — 15–30 ms interval, latency 0, notify every beat. **Use this from your iOS / watchOS app.** |
| `2` | GLASSES | `BATCHED` — 50–100 ms interval, latency 4, batched notifies. The Edge uses this when it connects as a central. |

The role write is **not persisted** by the earclip — every central must re-announce on every connect.

```swift
// Right after services are discovered, write your role *first*.
let role: UInt8 = 1   // DASHBOARD
peripheral.writeValue(Data([role]), for: chPeerRole, type: .withResponse)
```

**✅ Exact working JS (`dashboard/src/ble/narbisDevice.ts` — `openSession()`):**

```js
const NARBIS_PEER_ROLE_DASHBOARD = 0x01;
// Pre-Path-B earclips lack this characteristic, so wrap in try/catch and continue
// (they fall back to BATCHED, which is fine).
try {
  const chPeerRole = await svc.getCharacteristic(NARBIS_CHR_PEER_ROLE_UUID);
  await chPeerRole.writeValueWithResponse(new Uint8Array([NARBIS_PEER_ROLE_DASHBOARD]));
} catch (err) { /* optional on older firmware */ }
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

In `LOW_LATENCY` profile you see one notification per beat with one R-R interval. In `BATCHED` profile you see one notification every `ble_batch_period_ms` carrying up to 9 R-R intervals. **This batching is specific to this standard characteristic** — the custom Narbis IBI characteristic ([§3.1.1](#311-ibi--78ef492f)) notifies once per beat in both profiles.

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

**✅ Exact working JS (`dashboard/src/ble/parsers.ts` — used for the earclip *and* the Polar H10, same standard char):**

```js
function parseHeartRateMeasurement(dv /* DataView */) {
  const flags = dv.getUint8(0);
  let off = 1;
  let bpm;
  if (flags & 0x01) { bpm = dv.getUint16(off, true); off += 2; }   // bit0: u16 vs u8
  else              { bpm = dv.getUint8(off);         off += 1; }
  const rrIntervals_ms = [];
  if (flags & 0x10) {                                              // bit4: RR present
    while (off + 2 <= dv.byteLength) {
      const raw = dv.getUint16(off, true); off += 2;
      rrIntervals_ms.push(Math.round((raw * 1000) / 1024));        // 1/1024 s → ms
    }
  }
  return { bpm, rrIntervals_ms };
}
```

> **Swift-vs-JS note:** the JS deliberately omits the energy-expended skip (bit 3) the Swift does — neither the earclip nor the H10 sets that flag, so it never matters in practice. If you target a generic HRM that might, keep the Swift's `if (flags & 0x08) i += 2` skip. **For the Polar H10 RR path, also reconstruct per-beat timestamps — see [§3a.2](#3a2-rr-from-the-standard-hr-service--beat-timestamp-reconstruction).**

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
                Notify cadence on the standard HRS 0x2A37 characteristic
                ONLY (batched R-R flush vs. per-beat). The custom Narbis
                IBI characteristic (§3.1.1) notifies once per beat in
                BOTH modes — it never batches.
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

The full `narbis_runtime_config_t` is **72 bytes packed** (Path C / `config_version 4`), followed by 2 bytes of CRC = **74 bytes on the wire** (`NARBIS_CONFIG_WIRE_SIZE`). Field offsets are exact (`__attribute__((packed))`, no padding except the explicit `reserved_agc` byte).

> **Migration note.** Three layouts have shipped:
> - `config_version 1`/`2` — pre-Path-B, **58-byte** payload with `transport_mode`, `partner_mac[6]`, `espnow_channel`.
> - `config_version 3` — Path B, **50-byte** payload (ESP-NOW fields removed).
> - `config_version 4` — Path C (current), **74-byte** payload (adaptive-detector + Layer-E auxiliary fields appended).
>
> The first 48 bytes of v3 and v4 are **byte-identical**. An iOS client that only knows v3 can still safely read everything it understands by ignoring bytes 48..71. The version byte is **firmware-owned**: on a CONFIG_WRITE the firmware ignores whatever `config_version` the writer sent and forces it to `4` before persisting (a v3-style write is accepted, not rejected — write validation only range-checks the fields). The `config_version ≥ 4` check runs at NVS **load**: a persisted v1/v2/v3 blob is rejected at boot and the firmware falls back to defaults.

| Offset | Size | Field | Default | Range / values | Notes |
|---|---|---|---|---|---|
| 0 | 2 | `config_version` | 4 | u16 LE | Firmware-owned: writer's value is ignored and forced to `4` on every accepted write |
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
| 34 | 2 | `ibi_min_ms` | 300 | u16 LE | Validator floor (~200 BPM); also Elgendi refractory |
| 36 | 2 | `ibi_max_ms` | 2000 | u16 LE | Validator ceiling (~30 BPM) |
| 38 | 1 | `ibi_max_delta_pct` | 30 | 0–100 | Continuity threshold |
| 39 | 1 | `ble_profile` | 0 (BATCHED) | 0, 1 | Global default; PEER_ROLE overrides per-connection |
| 40 | 1 | `data_format` | 0 (IBI_ONLY) | 0, 1, 2 | See §3.5 |
| 41 | 2 | `ble_batch_period_ms` | 500 | u16 LE | BATCHED-mode flush interval — applies to the HRS `0x2A37` characteristic only; the custom IBI char never batches ([§3.1.1](#311-ibi--78ef492f)) |
| 43 | 1 | `diagnostics_enabled` | 1 | 0 / 1 | Master gate for DIAGNOSTICS char |
| 44 | 1 | `light_sleep_enabled` | 1 | 0 / 1 | |
| 45 | 1 | `diagnostics_mask` | 0 | bitmask | See §3.1.8 |
| 46 | 2 | `battery_low_mv` | 3300 | u16 LE | Below this → low-battery indication |
|  |  | *—— end of Path B / v3 prefix; v4 fields start here ——* |  |  |  |
| 48 | 1 | `detector_mode` 🆕 | 0 (FIXED) | 0 = FIXED, 1 = ADAPTIVE | `narbis_detector_mode_t`. **FIXED makes every field below a no-op** — sticks to the proven Elgendi pipeline. Set to ADAPTIVE to enable Kalman+NCC. |
| 49 | 1 | `template_max_beats` 🆕 | 10 | u8 | Rolling NCC template depth |
| 50 | 1 | `template_warmup_beats` 🆕 | 4 | u8 | Beats before NCC gate activates |
| 51 | 1 | `kalman_warmup_beats` 🆕 | 5 | u8 | Beats before Kalman gate activates |
| 52 | 2 | `template_window_ms` 🆕 | 200 | u16 LE | Matched-filter window length, ms |
| 54 | 2 | `ncc_min_x1000` 🆕 | 500 | u16 LE (×1000) | NCC admit threshold (0.500 default) |
| 56 | 2 | `ncc_learn_min_x1000` 🆕 | 750 | u16 LE (×1000) | NCC template-learning threshold (must be ≥ `ncc_min_x1000`) |
| 58 | 2 | `kalman_q_ms2` 🆕 | 400 | u16 LE | Process noise variance, ms² |
| 60 | 2 | `kalman_r_ms2` 🆕 | 2500 | u16 LE | Measurement noise baseline, ms² |
| 62 | 1 | `kalman_sigma_x10` 🆕 | 30 | u8 (×10) | IBI gate width, σ ×10 (3.0σ default) |
| 63 | 1 | `watchdog_max_consec_rejects` 🆕 | 5 | u8 | Consecutive rejects → full detector reset |
| 64 | 2 | `watchdog_silence_ms` 🆕 | 4000 | u16 LE | Silence → full detector reset, ms |
| 66 | 2 | `alpha_min_x1000` 🆕 | 10 | u16 LE (×1000) | Adaptive-α floor (0.010 default) |
| 68 | 2 | `alpha_max_x1000` 🆕 | 500 | u16 LE (×1000) | Adaptive-α ceiling (0.500 default; must be > `alpha_min_x1000`) |
| 70 | 1 | `elgendi_loose_mode` 🆕 | 0 | 0 / 1 | Relax Elgendi β and NCC admit by 50% for motion tolerance. Repurposed from the former `agc_adaptive_step` byte (same offset, same range) |
| 71 | 1 | `refractory_ibi_pct` 🆕 | 60 | 0–100 | Refractory window upper bound, % of last IBI |
| **72** | 2 | **CRC16** | — | u16 LE | CRC-16-CCITT-FALSE over bytes 0..71 |

> **Removed in Path B (do not look for them):** `transport_mode` (offset 39 in old layout), `partner_mac[6]` (offset 44), `espnow_channel` (offset 50). All ESP-NOW state is gone — the earclip-Edge link is now BLE only.

> **Write validation — the full enforced bounds.** Beyond the ranges in the table, `validate_config()` rejects the whole write (no partial apply) unless **all** of these hold: `ncc_min_x1000 ≤ 1000`, `ncc_learn_min_x1000 ≤ 1000` (and ≥ `ncc_min_x1000`), `alpha_min_x1000 ≥ 1`, `alpha_max_x1000 ≤ 1000` (and > `alpha_min_x1000`), `ibi_min_ms ≥ 1` (and < `ibi_max_ms`), `template_max_beats` 1–16, `template_window_ms` 80–1000, `kalman_sigma_x10` 5–100, `watchdog_silence_ms` 500–60000, `kalman_q_ms2 ≠ 0`, `kalman_r_ms2 ≠ 0`, `watchdog_max_consec_rejects ≥ 1`. Pre-validate client-side — a rejected CONFIG_WRITE produces no CONFIG notify, so a UI that waits for the echo will hang.

Swift mirror (Path C / `config_version 4`):

```swift
struct NarbisRuntimeConfig: Equatable {
    var configVersion: UInt16 = 4
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
    // ---- v4 adaptive detector ----
    var detectorMode: UInt8 = 0          // FIXED (= legacy Elgendi pipeline)
    var templateMaxBeats: UInt8 = 10
    var templateWarmupBeats: UInt8 = 4
    var kalmanWarmupBeats: UInt8 = 5
    var templateWindowMs: UInt16 = 200
    var nccMinX1000: UInt16 = 500
    var nccLearnMinX1000: UInt16 = 750
    var kalmanQMs2: UInt16 = 400
    var kalmanRMs2: UInt16 = 2500
    var kalmanSigmaX10: UInt8 = 30
    var watchdogMaxConsecRejects: UInt8 = 5
    var watchdogSilenceMs: UInt16 = 4000
    var alphaMinX1000: UInt16 = 10
    var alphaMaxX1000: UInt16 = 500
    // ---- v4 Layer-E auxiliary ----
    var elgendiLooseMode: UInt8 = 0
    var refractoryIbiPct: UInt8 = 60
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

**✅ Exact working JS (`protocol/narbis_protocol.ts` — `serializeConfig()`; this produces the exact 74 B the dashboard writes to CONFIG_WRITE / §5):**

```js
// CRC-16-CCITT-FALSE (poly 0x1021, init 0xFFFF) — the only non-obvious part of the wire format:
function narbisCrc16(buf, len) {
  let crc = 0xFFFF;
  for (let i = 0; i < len; i++) {
    crc ^= buf[i] << 8;
    for (let b = 0; b < 8; b++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc & 0xFFFF;
}
// serializeConfig(cfg): into a 74-byte buffer, write each field little-endian at its §3.6-table
// offset (one DataView.setUintN per row, in table order), then the CRC over bytes 0..71:
//   view.setUint16(72, narbisCrc16(buf, 72), true);
// Full serializeConfig() + deserializeConfig() (the inverse, for the CONFIG read/notify) are in
// protocol/narbis_protocol.ts.
```

> **Validation rules the firmware enforces.** Writes are rejected if any of these fail: `sample_rate_hz` is one of {50,100,200,400}; LED currents ≤ 510; `bandpass_low < bandpass_high`; `elgendi_w1 < elgendi_w2`; `ibi_min < ibi_max`; mode enums in range; `battery_low_mv` 2800–4200; `detector_mode` is `FIXED (0)` or `ADAPTIVE (1)`; `ncc_min_x1000 ≤ ncc_learn_min_x1000`; `alpha_min_x1000 < alpha_max_x1000`. Check `firmware/main/config_manager.c` for the canonical range list.

---

## 3a. Polar H10 — app-side data source

> **Why this section exists.** In app-side mode (the standard — [§4.7.1](#471-app-side-coherence--recommended-mode-abc)) the app computes coherence itself, so it reads the sensor **directly**. The Polar H10 is the reference sensor. **Mode C cannot run without the H10's accelerometer** (the independent respiration channel that verifies the resonance search against the Mayer wave) — an app that reads only heart rate will silently fail Mode C. Modes A and B need beats only (the accelerometer is optional there, feeding the breath–heart cross-coherence readout).

### 3a.1 What each mode needs

| Mode | Inputs the engine consumes | H10 services |
|---|---|---|
| **A — Follow** | RR intervals | HR `0x180D` / `0x2A37` |
| **B — Static Pacer** | RR intervals (fixed paced rate you set — no search) | HR `0x180D` / `0x2A37` |
| **C — Settle & Find (resonance search)** | RR **+ accelerometer** | HR `0x180D` **+ PMD `fb005c80-…`** |

Connect to the H10, subscribe to the **standard Heart Rate Service** for RR ([§3a.2](#3a2-rr-from-the-standard-hr-service--beat-timestamp-reconstruction)), and for **Mode C** also start the **PMD accelerometer stream** ([§3a.3](#3a3-accelerometer-via-the-pmd-service-mode-c)). The earclip can substitute as the RR source (its IBI characteristic, [§3.1.1](#311-ibi--78ef492f)) but has **no accelerometer** — Mode C requires the H10.

> **Apple Watch caveat.** watchOS / HealthKit does **not** expose reliable beat-to-beat RR intervals to third-party apps, nor an accelerometer-respiration stream equivalent to the H10's PMD. Treat "Apple Watch as HR source" as experimental for **Modes A/B** — and it is **not** a drop-in for Mode C (no accelerometer-respiration stream to verify the search).

```js
// dashboard/src/ble/polarH10.ts — connect (both HR + PMD in optionalServices so both are reachable):
const PMD_SVC = 'fb005c80-02e7-f387-1cad-8acd2d8df0c8';
const device = await navigator.bluetooth.requestDevice({
  filters: [{ services: [0x180d] }, { namePrefix: 'Polar' }],
  optionalServices: [0x180d, PMD_SVC],
});
```

### 3a.2 RR from the standard HR service + beat-timestamp reconstruction

Subscribe to `0x180D` / `0x2A37` and parse it with the **same parser as the earclip** ([§3.2](#32-heart-rate-service--0x180d)): `rr_ms = raw * 1000 / 1024`.

> ⚠️ **HR notifications carry RR but no timestamps**, and the coherence engine needs a time per beat. The naïve "sum RR backwards from the notify time" draws a **backwards-Z** tachogram under BLE jitter (a late notification's first beat lands before the previous one's last). Walk a **monotonic forward clock** from an anchor instead:

```js
// dashboard/src/ble/polarH10.ts — walkPolarBeatClock (condensed; full version adds drift-snap + re-anchor)
function walkPolarBeatClock(prev, receiveTs, rrs) {            // prev = last emitted beat time, or null
  if (rrs.length === 0) return { beatTimestamps: [], next: prev };
  const reanchor = prev == null || receiveTs - prev > 10_000;  // big gap → re-anchor
  let cursor = reanchor ? receiveTs - rrs.reduce((a, b) => a + b, 0) : prev;
  const out = rrs.map((rr) => (cursor += rr));                 // walk FORWARD → monotonic by construction
  return { beatTimestamps: out, next: out[out.length - 1] };   // (full impl also snaps forward on dropped notifies)
}
```

### 3a.3 Accelerometer via the PMD service (Mode C)

The H10 exposes its accelerometer through Polar's **PMD (Polar Measurement Data)** service — **not** the HR characteristic. Three characteristics:

| Role | UUID |
|---|---|
| PMD Service | `fb005c80-02e7-f387-1cad-8acd2d8df0c8` |
| Control point (write + indicate) | `fb005c81-02e7-f387-1cad-8acd2d8df0c8` |
| Data (notify) | `fb005c82-02e7-f387-1cad-8acd2d8df0c8` |

**Start sequence** (request→response on the control point; subscribe to **both** control-indicate and data-notify *before* writing):
1. **Get settings:** write `[0x01, 0x02]` (GET_SETTINGS, ACC) → response lists supported rates / ranges / resolutions.
2. **Start:** write `[0x02, 0x02, 0x00,0x01,<rate u16 LE>, 0x01,0x01,<res u16 LE>, 0x02,0x01,<range u16 LE>]` (the dashboard prefers **50 Hz / ±8 g / 16-bit**, falling back to an offered combo). Control responses begin `0xF0`; **status byte (offset 3) `0` = OK**.
3. **Stop:** write `[0x03, 0x02]`.

**Data frame:** `[0]=0x02` (ACC) · `[1..8]` u64 LE device timestamp (ns) · `[9]` frame type (**bit 7 = delta-compressed**) · `[10..]` payload. For raw frames (the H10's default in this config) the payload is consecutive `int16` LE x/y/z triplets in **milli-g** (≈1000 = 1 g). The engine takes the vector magnitude and band-passes it for the respiration estimate.

```js
// dashboard/src/ble/polarH10.ts — raw-frame ACC parse (condensed; delta-frame branch is in the file)
function parseAccFrame(dv /* DataView */) {
  if (dv.byteLength < 16 || dv.getUint8(0) !== 0x02) return [];
  if (dv.getUint8(9) & 0x80) return parseDeltaFrame(dv);   // bit 7 = delta-compressed → full impl in polarH10.ts
  const p = new Uint8Array(dv.buffer, dv.byteOffset + 10, dv.byteLength - 10);
  const i16 = (o) => ((p[o] | (p[o + 1] << 8)) << 16) >> 16;  // signed LE
  const out = [];
  for (let i = 0; i + 6 <= p.length; i += 6) out.push({ x: i16(i), y: i16(i + 2), z: i16(i + 4) });
  return out;
}
```

> **The control-point handshake is the part people get wrong.** Subscribe to the control point's *indications* before writing; send GET_SETTINGS first (don't assume a combo the device might reject with status 5); and **omit the CHANNELS TLV** (ACC is implicitly 3-axis — a malformed channels field is the classic "invalid parameter" rejection). The full, hardened `startAccStream()` is in `dashboard/src/ble/polarH10.ts`.

---

## 4. Edge glasses BLE — full reference

The Edge advertises one custom service, **`0x00FF`**, with four characteristics (`0xFF01`–`0xFF04`). There are no standard SIG services. The device does not advertise its service UUID in the GAP payload reliably — filter by name `Narbis_Edge`.

### 4.1 Advertising / connection parameters

| Setting | Value |
|---|---|
| Device name | `Narbis_Edge` (exact) |
| Advertising interval | 100–200 ms |
| Adv type | connectable + scannable (`ADV_IND`) |
| TX power | **0 dBm uniform** (all TX types: ADV / SCAN / CONN). Bumped from the prior tiered `−6 dBm` adv / `−12 dBm` connected scheme to maximize range at ~+1 mA idle cost. Roughly 4× connected range and 2× advertising range vs. the old scheme. |
| Adv flags | GENERAL_DISCOVERABLE + BR/EDR_NOT_SUPPORTED |
| Idle teardown | After **2 minutes** with no client connected (`BLE_IDLE_TIMEOUT_MS = 120000`), the BLE stack shuts down completely (full radio power-down). Re-armed on magnet tap or wake. |
| Requested MTU | **247** (`ble_att_set_preferred_mtu(247)`). Older revisions of this doc said 517 — that was never accurate. |
| Connection interval | 20–30 ms |
| Slave latency | 1 |
| Supervision timeout | **32 s** — the BLE-spec max (`supervision_timeout = 3200`; raised from 20 s because the OTA begin now erases an image-sized region, which can block the radio well past 19 s) |
| Client connections | **1** — advertising stops the moment a client connects and resumes on disconnect, so a second client can never join mid-session (unlike the multi-central earclip) |
| Pairing / encryption | none |

#### 4.1.1 Standalone programs & magnet gestures

The glasses work without any app. A short magnet tap (**0.15–4 s**; `HALL_SHORT_MIN_MS = 150`, lowered from 300 ms in fw 4.14.33) on the temple cycles three sensor-free programs; the lens signals the new program with N slow fade-dark pulses:

| Program | Behavior |
|---|---|
| 1 — Breathe | 6 BPM sine, lens tint follows the waveform (boot default) |
| 2 — Breathe + Strobe | 10 Hz strobe, dark-phase duty modulated by the breathing waveform |
| 3 — Strobe | Plain 10 Hz strobe |

Hold the magnet closed **≥ 5 s** for deep sleep. (On relay-enabled builds, 5 short taps also trigger "forget earclip" — [§4.6](#46-the-edge-as-relay-path-b).)

Two app-facing consequences:

- **Program parameters are the NVS-persisted opcode values, not fixed constants.** The 6 BPM / 10 Hz figures above are the compiled defaults; a persisted `0xB1` (breathe BPM), `0xAB` (strobe rate), `0xAC`, `0xB2`–`0xB5` or `0xA2` write changes what the no-app magnet-tap programs render from then on.
- **Gestures stay live while a client is connected** — only OTA blocks them. A short tap mid-session overwrites whatever lens program your app commanded (the wearer can "change the channel" under you), and a ≥ 5 s hold deep-sleeps the glasses outright. Watch `0xF3 led_mode` to detect it and re-assert your program if needed.

### 4.2 Service `0x00FF` — characteristic map

| Characteristic | UUID | Properties | Direction | Purpose |
|---|---|---|---|---|
| Control | `0xFF01` | read + write | client → device | All commands; see §4.3 |
| OTA Data | `0xFF02` | write + write-no-response | client → device | OTA payload chunks; see §6 |
| Status | `0xFF03` | read + notify | device → client | Multiplexed by leading byte: log, coherence, health, relay, OTA status. Plain notify (`BLE_GATT_CHR_F_NOTIFY`, emitted via `ble_gatts_notify_custom()`) — earlier revisions of this doc claimed it "used indicate internally"; it does not, and there is no per-frame ACK ([§7.3](#73-indicate-vs-notify)) |
| PPG Stream | `0xFF04` | read + notify | device → client | Batched PPG samples + beat info — **not emitted on current builds** ([§4.5](#45-ppg-stream-characteristic-0xff04)) |

Both `0xFF03` and `0xFF04` have a CCCD descriptor (`0x2902`) that you must enable with `setNotifyValue(true, for:)`.

### 4.3 Control characteristic `0xFF01` — command opcodes

Most commands are a 2-byte write `[opcode, arg]`. A 1-byte legacy form exists where the byte is interpreted as a static-mode duty (0–255 → 0–100 %).

The firmware **never sends a NACK**, but out-of-range handling is not uniform: most opcodes **silently clamp** the argument into range, while `0xB7` and `0xB8` **ignore** an out-of-range argument entirely (emitting an `OOR` line on `0xF1`), and `0xE0` **rejects the whole write** on any validation failure. Validate client-side and always wrap a command write in a Swift timeout if you need to detect failure.

| Opcode | Name | Arg | Persisted? | Notes |
|---|---|---|---|---|
| `0xA2` | Set brightness | 0–100 (%) | yes (NVS) | |
| `0xA4` | Set session duration | 1–60 (minutes) | yes | Session auto-sleep: the timer runs from wake and is **not restarted by this write** — `0xA4` only changes the duration against the already-running clock; at expiry the glasses enter **deep sleep** (default **30 min**, persisted). `0xF3 uptime_s` shares (approximately) the same origin, so `remaining ≈ minutes × 60 − uptime_s`. Re-wake by magnet tap. |
| `0xA5` | Static LED mode | 0–100 (duty %) | no | |
| `0xA6` | Strobe LED mode | any | no | starts strobe ISR |
| `0xA7` | Sleep now | any | no | enters deep sleep |
| `0xA8` | OTA START | `0x00` or `[size:u32 LE]` | no | Optional 4-byte image size (`[0xA8][size u32 LE]`, 5 B total): the device erases only the sectors the image needs at OTA begin instead of the full slot, shortening the radio-blocking erase. Legacy `[0xA8, 0x00]` (2 B) → full-slot erase. See §6 |
| `0xA9` | OTA FINISH | `0x00` | no | see §6 |
| `0xAA` | OTA CANCEL | `0x00` | no | see §6 |
| `0xAB` | Strobe frequency | 1–50 (Hz) | yes | |
| `0xAC` | Strobe duty | 10–90 (%) | yes | |
| `0xAD` | OTA Page Confirm | `0x01` commit / `0x00` resend | no | see §6 |
| `0xB0` | Breathe LED mode | `0x00` breathe / `0x01` breathe+strobe | no | `0x00` = plain breathe; `0x01` = breathe+strobe, phase-locked to `0xBA`/`0xB1`/`0xB2` (fw ≥ 4.15.6). Toggling the arg preserves breathe phase. ⚠️ Always send the arg byte: a bare 1-byte `[0xB0]` is **not** breathe — it hits the legacy single-byte duty path (§4.3 preamble) and sets a **static tint** of 0xB0/255 ≈ 69 %. |
| `0xB1` | Breathe BPM | 1–30 | yes | |
| `0xB2` | Breathe inhale ratio | 10–90 (%) | yes | |
| `0xB3` | Breathe hold-top | 0–50 (×100 ms) | yes | |
| `0xB4` | Breathe hold-bottom | 0–50 (×100 ms) | yes | |
| `0xB5` | Breathe waveform | 0 sine, 1 linear | yes | |
| `0xB6` | Pulse-on-beat mode | any | no | Lens pulses once per detected beat. Needs beats reaching the Edge's coherence pipeline — either via the BLE relay from the earclip (see [§4.6](#46-the-edge-as-relay-path-b)) or via `0xCA` external-IBI injection (e.g. iOS forwarding Polar H10 R-R intervals). |
| `0xB7` | PPG program | 0–3 | no | 0 heartbeat, 1 coh-breathe, 2 coh-lens, 3 coh-breathe-strobe |
| `0xB8` | Coherence difficulty | 0–3 | yes | easy / medium / hard / expert |
| `0xB9` | Adaptive pacer | 0/1 | yes | |
| **`0xBA`** | **Breathe sync** 🆕 | 3 B payload | no | App-side lens phase-lock (firmware ≥ 4.15.5). 4 B on the wire: `[0xBA][cycle_ms:u16 LE][inhale_pct:u8]`. Restarts the `LED_MODE_BREATHE` cosine at the moment of the write (= the app's on-screen inhale boundary) and renders at the exact cycle length sent, so the glasses lens, the on-screen breathing cue, and the audio chime share one clock. Firmware clamps `cycle_ms` to **2000–30000 ms** and `inhale_pct` to 10–90 — silently. **This is a required per-breath keep-alive, not a one-shot anchor**: the exact-cycle override auto-expires ~2 cycles after the last write, after which the lens falls back to the integer-BPM `0xB1` rate — so send it at *every* breath boundary (and on Mode A/B/C start / glasses-connect), **only at the boundary, never mid-breath** — full rationale + Swift in [§4.8.4](#484-phase-sync--the-one-rule-write-only-at-the-breath-boundary). A firmware lens slew-rate limiter fades any re-anchor (~250 ms) so resyncs never snap. Ignored by firmware < 4.15.5 (unknown opcode), so it's safe to always send. |
| `0xBF` | Factory reset | any | n/a | wipes the `narbis_prefs` NVS namespace |
| `0xC0` | *(reserved)* | — | — | Listed in firmware's internal opcode comment table but has no dispatcher case — do not use |
| **`0xC1`** | **Forget earclip** 🆕 | any (ignored) | no | Path B. Wipes the `narbis_pair` NVS entry, drops the central connection to the earclip, starts a fresh general scan. Visual feedback: 3 fast lens-opacity pulses. Same effect as 5 short magnet taps. |
| **`0xC3`** | **Relay config write** 🆕 | 50 B payload (v3-era) | no | Path B — **⚠️ currently unusable.** The glasses firmware still builds against the **v3-era** config (`NARBIS_CONFIG_WIRE_SIZE = 50` in its bundled `narbis_protocol` component): it requires exactly 50 bytes after the opcode (51 B total; shorter writes are logged and dropped) and forwards those 50 bytes verbatim as a CONFIG_WRITE to the paired earclip. Current earclip firmware accepts only the **74-byte v4** payload ([§3.6](#36-the-runtime-config-struct)) and rejects the relayed 50-byte write with an invalid-size error — so this opcode cannot deliver a config to a v4 earclip until the glasses relay is rebuilt against config v4. Write earclip config directly via its own CONFIG_WRITE characteristic instead ([§5](#5-configuring-the-earclip-from-ios)). (Moot on stock builds anyway — the relay is compile-disabled, [§4.6](#46-the-edge-as-relay-path-b).) On success the earclip would reply via CONFIG notify, which the Edge re-emits as a `0xF4` frame ([§4.4.5](#445-relayed-earclip-config-0xf4--75-b)). |
| **`0xC4`** | **Toggle raw-PPG relay** 🆕 | `0` disable / non-zero enable | no | Path B. Subscribes/unsubscribes the Edge's central from the earclip's RAW_PPG characteristic. While enabled, raw earclip samples are forwarded as `0xF5` frames on `0xFF03` ([§4.4.6](#446-relayed-earclip-raw-ppg-0xf5--variable)). Default: enabled at boot. |
| **`0xC5`** | **Refresh earclip config** 🆕 | any (ignored) | no | Path B. Triggers a one-shot CONFIG read on the Edge's central role; the resulting earclip CONFIG notify is re-emitted to the dashboard as a `0xF4` frame ([§4.4.5](#445-relayed-earclip-config-0xf4--75-b)). Dashboard sends this automatically ~2 s after the relay goes UP if no `0xF4` arrived, and exposes it as a manual "reload from earclip" button. Restored in PR #29 after the NimBLE migration dropped the original handler. |
| **`0xCA`** | **External-IBI injection** 🆕 | 4 B payload | no | Path B / Polar H10 path. 5 B total on the wire: `[0xCA][ibi_ms:u16 LE][confidence:u8 0–100][flags:u8 NARBIS_BEAT_FLAG_*]`. **Legacy / Standard on-glasses path only** ([§4.7.2](#472-legacy--standard-on-glasses-mode-0xca--0xb7)) — forwards an external HR source's beats into the Edge's **firmware** coherence pipeline so the on-glasses PPG programs respond identically regardless of beat source. App-side clients (the standard) compute coherence themselves and do **not** send this. Beats with `confidence < g_coh_params.conf_threshold` or `flags & ARTIFACT` are silently dropped. |
| **`0xCB`** | **Set HR source** 🆕 | 0 = earclip / 1 = H10 | no | Path B. `0` resumes the Edge's BLE central scan / connect to the earclip; `1` pauses it so the glasses don't pull earclip beats while the app is the HR authority — whether the app computes coherence itself (the standard — [§4.7.1](#471-app-side-coherence--recommended-mode-abc)) or feeds the firmware via `0xCA` on the legacy path ([§4.7.2](#472-legacy--standard-on-glasses-mode-0xca--0xb7)). Not persisted — re-assert on every glasses connect. |
| `0xD0` | Manual detector reset | any | no | clears beat detection state |
| **`0xE0`** | **Coherence pipeline tuning** 🆕 | 12 B payload | yes (NVS) | 13 B total on the wire: `[0xE0]` + packed `narbis_coh_params_t` (LF peak window, band bin ranges, confidence gate, score multiplier — see `protocol/narbis_protocol.h`). Lets the dashboard tweak the coherence algorithm without a reflash. Validation rejects out-of-grid bins and inverted lo/hi pairs so a buggy write can't lock the algorithm into a non-recoverable state. New params apply on the next coherence compute (≤ 1 s). |

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

**✅ Exact working JS (`dashboard/src/ble/edgeDevice.ts`).** Every opcode goes through one helper (the real one chains writes onto a serial promise queue so concurrent writes never collide — condensed here):

```js
async function sendCtrlCommand(chCtrl, opcode, payload /* Uint8Array | undefined */) {
  const total = Math.max(2, 1 + (payload?.length ?? 0)); // firmware drops writes < 2 B → pad to 2
  const buf = new Uint8Array(total);
  buf[0] = opcode & 0xff;
  if (payload?.length) buf.set(payload, 1);
  await chCtrl.writeValueWithResponse(buf);
}
// examples:
sendCtrlCommand(chCtrl, 0xA2, new Uint8Array([Math.min(pct, 100)]));            // brightness
sendCtrlCommand(chCtrl, 0xB0);                                                  // enter breathe → [0xB0,0x00]
sendCtrlCommand(chCtrl, 0xB1, new Uint8Array([Math.max(1, Math.min(30, bpm))])); // breathe BPM
```

### 4.3.1 Edge-side algorithm tuning

> ### ⚠️ Legacy / Standard mode only
> These knobs tune the **firmware's own** coherence pipeline, which is **idle in app-side mode** (the standard — [§4.7.1](#471-app-side-coherence--recommended-mode-abc), where the app computes coherence; these writes then have **no effect on what you see**). They matter only on the legacy / Standard on-glasses path ([§4.7.2](#472-legacy--standard-on-glasses-mode-0xca--0xb7)). App-side clients tune their **own** engine instead — see [`coherence-engine.md`](./coherence-engine.md).

The Edge exposes three families of runtime knobs over `0xFF01` for **the firmware's on-glasses coherence pipeline** and the lens-driver feel. All three persist to NVS so a power cycle preserves what the user picked.

> **Where the algorithm lives.** On the legacy / Standard on-glasses path, beat detection lives on whichever source produces the IBIs (the earclip's Elgendi/NCC/Kalman pipeline, or the H10 via `0xCA`), and **coherence + lens tinting run in the Edge firmware** — so the knobs below change *that path's* behaviour identically regardless of beat source. In **app-side mode** (the standard) the app owns coherence and the lens, and these knobs do nothing.

#### A. `0xE0` — coherence pipeline params (12-byte struct)

Single write that replaces the entire `narbis_coh_params_t`. Wire format: `[0xE0]` + 12 raw struct bytes = **13 B total**. No CRC, no length prefix. On success the new params apply on the next coherence compute (≤ 1 s) and persist to NVS. On any validation failure the firmware silently drops the write and emits a `0xE0 reject: out-of-range` line on `0xF1`.

> **FFT bin grid.** Every `*_lo` / `*_hi` field is an FFT bin index on a **fixed 4 Hz × 256-point grid** (`df = 4/256 = 0.015625 Hz/bin`). The grid is compile-time — resizing it would require dynamic FFT buffers. Useful conversions:
>
> | Frequency | Bin |
> |---|---|
> | 0.016 Hz | 1 (typical VLF lower edge) |
> | 0.04 Hz | 3 (VLF / LF boundary) |
> | 0.10 Hz | 6.4 (mid-LF, resonant breathing) |
> | 0.15 Hz | 10 (LF / HF boundary) |
> | 0.40 Hz | 26 (upper HF) |
> | ~2 Hz | 127 (Nyquist) |

| Offset | Size | Field | Default | Range | What it controls |
|---|---|---|---|---|---|
| 0 | 1 | `min_ibis` | 20 | 5–120 | Minimum collected beats before coherence is computed. Higher = smoother but slower to first valid reading. |
| 1 | 1 | `conf_threshold` | 50 | 0–100 | Beats with `confidence < this` are dropped at the `0xCA` / earclip-IBI entry points. Applies to both H10 and earclip paths. |
| 2 | 1 | `vlf_band_lo` | 1 | 0–127 | VLF band integration, inclusive lo |
| 3 | 1 | `vlf_band_hi` | 2 | ≥ `vlf_band_lo`, ≤ 127 | VLF hi |
| 4 | 1 | `lf_band_lo` | 3 | 0–127 | LF band integration, inclusive lo |
| 5 | 1 | `lf_band_hi` | 9 | ≥ `lf_band_lo`, ≤ 127 | LF hi |
| 6 | 1 | `hf_band_lo` | 10 | 0–127 | HF band integration, inclusive lo |
| 7 | 1 | `hf_band_hi` | 25 | ≥ `hf_band_lo`, ≤ 127 | HF hi |
| 8 | 1 | `lf_peak_lo` | 3 | 0–127 | LF peak-search window (Lehrer/Vaschillo numerator), inclusive lo |
| 9 | 1 | `lf_peak_hi` | 9 | ≥ `lf_peak_lo`, ≤ 127 | LF peak hi |
| 10 | 1 | `peak_halfwidth` | 0 | 0–8 | `0` = single-bin peak; `N` = sum the peak ± N bins inclusive |
| 11 | 1 | `coh_multiplier` | 100 | 10–255 | Score scaling. 100 maps the peak/total ratio onto a nominal 0–100 score. (Was 250 pre-v4.14.31 — old presets that hard-coded 250 will under-shoot now.) |

Swift mirror + write helper:

```swift
struct EdgeCohParams: Equatable {
    var minIbis: UInt8 = 20
    var confThreshold: UInt8 = 50
    var vlfBandLo: UInt8 = 1,  vlfBandHi: UInt8 = 2
    var lfBandLo:  UInt8 = 3,  lfBandHi:  UInt8 = 9
    var hfBandLo:  UInt8 = 10, hfBandHi:  UInt8 = 25
    var lfPeakLo:  UInt8 = 3,  lfPeakHi:  UInt8 = 9
    var peakHalfwidth: UInt8 = 0
    var cohMultiplier: UInt8 = 100
}

func writeCohParams(_ p: EdgeCohParams, on perif: CBPeripheral, ctrl: CBCharacteristic) {
    let bytes: [UInt8] = [
        0xE0,
        p.minIbis, p.confThreshold,
        p.vlfBandLo, p.vlfBandHi,
        p.lfBandLo,  p.lfBandHi,
        p.hfBandLo,  p.hfBandHi,
        p.lfPeakLo,  p.lfPeakHi,
        p.peakHalfwidth, p.cohMultiplier,
    ]
    perif.writeValue(Data(bytes), for: ctrl, type: .withResponse)
}
```

**✅ Exact working JS (`protocol/narbis_protocol.ts` + `edgeDevice.ts`):**

```js
function serializeCoherenceParams(p) {            // 12 raw bytes, no CRC / no length prefix
  return new Uint8Array([
    p.min_ibis, p.conf_threshold,
    p.vlf_band_lo, p.vlf_band_hi,
    p.lf_band_lo,  p.lf_band_hi,
    p.hf_band_lo,  p.hf_band_hi,
    p.lf_peak_lo,  p.lf_peak_hi,
    p.peak_halfwidth, p.coh_multiplier,
  ]);
}
sendCtrlCommand(chCtrl, 0xE0, serializeCoherenceParams(p)); // 13 B on the wire
```

> **No read-back characteristic.** There's no GATT read for the current `narbis_coh_params_t`. The firmware emits the active params on boot and after every accepted `0xE0` write as a `0xF1` log line (`0xE0 ok: lf=[..] hf=[..] pk=[..]±N mult=M`) — parse that if you want to mirror state. The success-log fields are LF band, HF band, LF-peak window, halfwidth, multiplier; `min_ibis` and `conf_threshold` are echoed on boot but not on every write.

#### B. `0xB8` — coherence difficulty preset (1-byte arg)

On current firmware, difficulty does **not** touch the coherence math at all — the peak-window narrowing / score scale-down described in earlier revisions of this doc was reverted in v4.14.26, and the score is now computed identically at every difficulty. What `0xB8` sets is a **gamma curve on the coherence → lens-opacity mapping**, and only the **coh-lens program** (`0xB7 2`) reads it: `lens_clear = (coh/100)^γ`. Persists to NVS.

| Arg | Preset | γ | Feel |
|---|---|---|---|
| 0 | Easy (default) | 1.0 | Linear — lens clearing tracks coherence directly |
| 1 | Medium | 1.5 | At coh = 50 the lens is only ~35 % clear |
| 2 | Hard | 2.0 | At coh = 50, ~25 % clear |
| 3 | Expert | 3.0 | At coh = 50, ~13 % clear |

Arguments > 3 are **ignored** (with an `0xB8 arg OOR` line on `0xF1`), not clamped. Because difficulty no longer alters the computed score, `0xB8` and `0xE0` are now orthogonal: `0xE0` shapes the score, `0xB8` shapes how the coh-lens program renders it. `0xF2` scores stay comparable across difficulty levels and sessions.

#### C. `0xB9` — adaptive pacer toggle (1-byte arg)

`[0xB9, 0]` → disabled: the coherence pacer is **hard-coded back to 6.0 BPM** (quintet 30), re-forced at every cycle boundary. `0xB1` / `0xB2` have **no effect on the PPG coherence programs** — the coherence-breathe cycle is owned by this adaptive machinery (fixed 40/60 inhale/exhale split), and `0xB1`/`0xB2` only shape the plain `0xB0` breathe mode.
`[0xB9, 1]` → enabled (default): the pacer's target walks toward the user's measured resonant respiratory frequency in 0.2-BPM steps (one quintet per cycle boundary, slew-limited), clamped to 3.0–10.0 BPM.

Persists to NVS. Only takes effect at the next cycle boundary of the coh-breathe (`0xB7 1`) or coh-breathe-strobe (`0xB7 3`) programs — no-op on heartbeat / coh-lens.

The current pacer rate is exposed in the [`0xF2` coherence frame](#443-coherence-packet-0xf2--18-b) at byte 17 (`pacer_rate_q5`, **quintets = BPM × 5** — divide by 5), so a tuning UI can show "Target: 6.4 BPM" live without needing a separate read.

#### Related but documented elsewhere

- **Beat-detection tuning on the earclip side** (Elgendi / NCC / Kalman / watchdog params) lives in `narbis_runtime_config_t` v4 — see [§3.6](#36-the-runtime-config-struct). Only matters when the IBI source is the earclip; an H10-only build can ignore it. Write earclip config via the earclip's own `CONFIG_WRITE` characteristic — the [`0xC3`](#43-control-characteristic-0xff01--command-opcodes) relay path is currently unusable (v3/v4 payload-size mismatch).
- **Brightness, strobe rate / duty, breathe BPM / inhale ratio / hold times / waveform, PPG program selection** are all single-byte opcodes in the [§4.3 opcode table](#43-control-characteristic-0xff01--command-opcodes) (`0xA2`, `0xAB`, `0xAC`, `0xB1`–`0xB5`, `0xB7`).

### 4.4 Status characteristic `0xFF03` — notification multiplexer

The Edge multiplexes several packet types onto the same characteristic, distinguished by the **first byte**.

| Type byte | Cadence | Length | Purpose |
|---|---|---|---|
| `0xF0` | **not emitted** (current builds) | 11 B | Raw ADC stats — the on-glasses PPG front-end was removed; see §4.4.1 |
| `0xF1` | on demand | 1 + N B (N ≤ 63) | Firmware log strings (printf output) |
| `0xF2` | every 1000 ms (silent until the first successful compute — §4.4.3) | 18 B | Coherence packet (HRV bands + score) |
| `0xF3` | every 1000 ms | 22 B | Health telemetry (uptime, heap, jitter, errors, LED state) — see §4.4.4 |
| **`0xF4`** 🆕 | event-driven | 1 + 74 B | Relayed earclip CONFIG payload — see §4.4.5 |
| **`0xF5`** 🆕 | event-driven | 1 + variable | Relayed earclip RAW_PPG batch — see §4.4.6 |
| **`0xF6`** 🆕 | on connect / disconnect / 30 s | 2 B | Earclip relay link state — see §4.4.7 |
| **`0xF7`** 🆕 | event-driven | 1 + variable | Relayed earclip diagnostics — see §4.4.8 |
| **`0xF8`** 🆕 | event-driven | 5 B | Relayed earclip battery (binary) — see §4.4.9 |
| **`0xF9`** 🆕 | event-driven (~1 Hz per beat) | 5 B | Relayed earclip IBI (binary) — see §4.4.10 |
| **`0xFA`** 🆕 | every 1000 ms | 7 B | Link-quality telemetry (RSSI, MTU, drops) — see §4.4.11 |
| `0x01`–`0x08` | event-driven | 3–7 B | OTA status — see §6 |

Always subscribe to `0xFF03` before sending any OTA opcode, otherwise you'll miss the READY / PAGE_CRC / ERROR responses you need to drive the protocol. The relay frames `0xF4`–`0xFA` are also delivered on this same characteristic, so a single subscription covers everything.

#### 4.4.1 ADC stats (`0xF0`) — 11 B

> ⚠️ **Not emitted on current glasses builds.** The on-glasses PPG front-end was removed (the glasses are earclip-only now — no ADC read, no on-glasses beat detection), and the `0xF0` emitter has no remaining call sites. The layout below is kept for older firmware that still had the internal PPG.

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
| 1..N | up to 63 | ASCII string (NUL-terminated or truncated; 64-B frame buffer) |

Useful for debugging. The firmware emits a hello on subscribe, an `alive …` heartbeat every ~30 s, and ad-hoc events.

> **The subscribe-hello is the only firmware-version probe the Edge has.** It reads `Narbis fw v<version> test=<n> mode=<n>` — since the glasses expose no Device Information Service ([§4.8.6](#486-backward-compatibility--version)), parsing this line is the one way to learn the Edge's firmware version over BLE. Subscribe to `0xFF03` and capture the first `0xF1` frame if your app gates features on version.

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
| 17 | 1 | `pacer_rate_q5` | Current pacer rate in **quintets = BPM × 5** (0.2-BPM resolution): `30` = 6.0 BPM; range 15–50 (3.0–10.0 BPM) while a coherence-breathe program runs. **Not a plain BPM** — divide by 5. With the adaptive pacer disabled (`0xB9 0`) it is re-forced to `30` each cycle; it reads `0` only before a coherence-breathe program has ever started. Added by PR #31 / #32; earlier revisions of this doc mislabeled it `pacer_bpm`. |

> **No `0xF2` frames arrive until the first successful coherence compute.** The emitter returns early while the pipeline has never produced a result, and a compute only succeeds once ≥ `min_ibis` beats (default 20) are collected — so any `0xF2` you receive has `n_ibis_used ≥ min_ibis`. You will never see a live frame with `n_ibis_used = 0`; "no frames at all" is the no-data signal, not a zero field.

The Edge derives this from beats reaching its firmware pipeline — `0xCA` injection, or the earclip relay on relay-enabled builds ([§4.6](#46-the-edge-as-relay-path-b)).

#### 4.4.4 Health telemetry (`0xF3`) — 22 B

| Offset | Size | Field | Notes |
|---|---|---|---|
| 0 | 1 | `0xF3` | |
| 1 | 4 | `uptime_s` | u32 LE |
| 5 | 4 | `heap_free` | u32 LE |
| 9 | 4 | `heap_min` | u32 LE; minimum free heap since boot — leak detector |
| 13 | 2 | `ppg_stack_hwm_words` | u16 LE; `0xFFFF` = >65535 |
| 15 | 2 | `ble_send_errors` | u16 LE; saturates at `0xFFFF` |
| 17 | 2 | `jitter_max_us` | u16 LE; **cumulative since boot** on current fw (the 5-s window reset was removed with the on-glasses PPG front-end) |
| 19 | 1 | `jitter_ticks_over` | u8; **cumulative since boot** (same) |
| 20 | 1 | `led_mode` 🆕 | u8 — `led_mode_t` enum: `0` strobe, `1` static, `2` breathe, `3` breathe+strobe, `4` pulse-on-beat, `5` coherence-breathe, `6` coherence-breathe+strobe, `7` coherence-lens. Mirror of the lens-driver state machine. (There is no "off" value — a clear lens is `static`/`breathe` at duty 0.) |
| 21 | 1 | `led_duty` 🆕 | u8 — effective lens duty as a **percentage, 0–100** (0 = clear, 100 = fully dark; **not** 0–255 — a stale firmware comment says 0–255, but every producer path writes 0–100). Snapshot of the actual lens output at emit time, not the requested duty. Useful for "is the lens doing what I asked?" overlays. |

A spike in `ble_send_errors` means the iOS side is overwhelming the device — slow your writes. `led_mode` + `led_duty` were added in glasses fw v4.15.4 (PR #28); older firmware emits a 20-byte frame without these two bytes.

#### 4.4.5 Relayed earclip CONFIG (`0xF4`) — 75 B

🆕 **Path B.** Forwarded verbatim from the earclip's CONFIG characteristic when its value changes (e.g. after a direct CONFIG_WRITE / MODE write, or a `0xC5` refresh — the `0xC3` relay write is currently unusable, [§4.3](#43-control-characteristic-0xff01--command-opcodes)).

| Offset | Size | Field | Notes |
|---|---|---|---|
| 0 | 1 | `0xF4` | Type byte |
| 1 | 72 | `narbis_runtime_config_t` | Earclip config struct ([§3.6](#36-the-runtime-config-struct)) — Path C / v4 layout |
| 73 | 2 | `crc16` | CRC-16-CCITT-FALSE over bytes 1..72 |

The 74-byte tail is **identical** to what you'd read directly from the earclip's CONFIG characteristic — same struct layout, same CRC. Reuse your earclip CONFIG parser. (Earlier Path B firmware emitted a 51-byte frame here with a 48-byte struct + 2-byte CRC; the Edge just forwards whatever the earclip notifies, so if you ever connect to a v3 earclip through a current Edge you'll see the smaller frame — branch on the `config_version` field at the start of the payload.)

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

> **Stock builds emit this too.** Even with the relay compile-disabled ([§4.6](#46-the-edge-as-relay-path-b)), the ~30 s heartbeat still fires with `linked = 0` — a steady `0xF6 00` cadence on `0xFF03` is normal on stock firmware, not a sign of a lost earclip.

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

**✅ Exact working JS (`dashboard/src/ble/edgeDevice.ts` — type `0xF6`):**

```js
const connected = bytes[1] !== 0;   // 1 = earclip relay linked, 0 = lost
ui.setEarclipBadge(connected);
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

**✅ Exact working JS (`dashboard/src/ble/edgeDevice.ts` — `onStatusNotify`, type `0xF9`):**

```js
const ibi_ms = bytes[1] | (bytes[2] << 8);
const confidence_x100 = bytes[3];
const flags = bytes[4];
if (ibi_ms > 0) engine.pushBeat({ ibi_ms, confidence_x100, flags }); // gate on flags/conf client-side
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

**✅ Exact working JS (`dashboard/src/ble/edgeDevice.ts`, `dv` = DataView):**

```js
const earclipRssi   = dv.getInt8(1);          // 0x7F (127) = no link
const dashboardRssi = dv.getInt8(2);
const mtu   = bytes[3] | (bytes[4] << 8);
const drops = bytes[5] | (bytes[6] << 8);
ui.setBars(earclipRssi === 0x7F ? null : earclipRssi,
           dashboardRssi === 0x7F ? null : dashboardRssi);
```

### 4.5 PPG stream characteristic `0xFF04`

> ⚠️ **Not emitted on current glasses builds.** The on-glasses PPG front-end was removed — the glasses are earclip-only, nothing feeds this stream, and the emitters have zero call sites. The characteristic still exists in the GATT table (subscribing succeeds, nothing arrives). The layouts below are kept for older firmware that still had the internal PPG. For live PPG, use the earclip's RAW_PPG ([§3.1.3](#313-raw_ppg--6bacca91)) — direct or relayed as `0xF5` on a relay-enabled build.

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

> **JS note:** the Narbis dashboard consumes earclip PPG via the relay ([§4.6](#46-the-edge-as-relay-path-b)) or the direct earclip `RAW_PPG` ([§3.1.3](#313-raw_ppg--6bacca91)), **not** the Edge's own `0xFF04` stream — so there's no dashboard JS for this exact frame. Faithful port:

```js
function parseEdgePPG(dv /* DataView */) {
  if (dv.byteLength < 6 || dv.getUint8(0) !== 0x03) return null;
  const n = dv.getUint8(1);
  if (dv.byteLength !== 6 + n * 8) return null;
  const baseTimestampMs = dv.getUint32(2, true);
  const samples = [];
  for (let i = 0; i < n; i++) {
    const o = 6 + i * 8;
    samples.push({
      raw: dv.getUint16(o, true), index: dv.getUint16(o + 2, true),
      flags: dv.getUint8(o + 4), beatDetected: (dv.getUint8(o + 4) & 1) !== 0,
      ibi_ms: dv.getUint16(o + 5, true), bpm: dv.getUint8(o + 7),
    });
  }
  return { baseTimestampMs, samples }; // ts[i] = baseTimestampMs + i*20 (50 Hz nominal)
}
```

#### Legacy format `0x02` (older firmware only)

13 B per sample, no batching:

```
[0x02][raw:u16 LE][idx:u16 LE][ts:u32 LE][flags:u8][ibi:u16 LE][bpm:u8]
```

Detect by reading the type byte; both share characteristic `0xFF04`.

### 4.6 The Edge as relay (Path B)

> ### ⚠️ Relay disabled on stock firmware (since fw main 2026-07)
>
> Current glasses builds ship with **`EARCLIP_CENTRAL_ENABLED 0`** (`components/narbis_ble_central/narbis_ble_central.c`) — the central radio stays dark, eliminating the **~80 mA** active-scan drain when no earclip is in use. Everything in this section (pairing, the relay frames `0xF4`–`0xF9`, and the relay-control opcodes `0xC1` / `0xC3` / `0xC4` / `0xC5`) is implemented but **inert** unless the firmware is rebuilt with the flag set to `1`. On stock builds, use **Pattern A** (direct earclip connection) for earclip data, or feed beats to the glasses via `0xCA` ([§4.7.2](#472-legacy--standard-on-glasses-mode-0xca--0xb7)).

🆕 **New architecture.** The Edge is no longer just a peripheral — it also runs a NimBLE **central** that scans for, pairs with, and persistently reconnects to the earclip. Once linked, the Edge transparently forwards earclip notifications to whichever phone is connected to it.

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

**Pairing.** With no MAC persisted (first boot, or after a `0xC1` / 5 magnet-taps), the Edge runs a **general scan** (30 s windows) filtering on the earclip's NARBIS service UUID, picks the strongest hit, and stores the MAC in NVS. Once a MAC is persisted it only ever runs **directed scans for that MAC: 30-s windows (`SCAN_DIRECTED_MS = 30000`) with a ~5-s backoff between attempts, retried indefinitely** — it never falls back to general scan on its own; `0xC1` (or the 5-tap gesture) is the only way back to general discovery.

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
| **B. Single connection via Edge** — connect only to the Edge; consume `0xF4`/`0xF5`/`0xF6`/`0xF7` from `0xFF03`. **Requires a relay-enabled build** (`EARCLIP_CENTRAL_ENABLED 1` — see the note at the top of this section). | You're building a companion app that mainly drives Edge sessions; raw earclip-side data is enough via the relay. | One fewer connection to manage. Slight extra latency on relayed frames (one BLE hop). **Earclip config writes can't currently go through the Edge** — `0xC3` forwards a v3-era 50-byte payload that a v4 earclip rejects ([§4.3](#43-control-characteristic-0xff01--command-opcodes)); use a direct earclip connection for config changes. |

```swift
// Pattern B: read the relay state and decide whether to expect earclip data.
func peripheral(_ p: CBPeripheral, didUpdateValueFor c: CBCharacteristic, error: Error?) {
    guard c.uuid == CBUUID(string: "FF03"), let data = c.value, !data.isEmpty else { return }
    switch data[0] {
    case 0xF6:  // relay state
        let linked = data.count >= 2 && data[1] == 1
        appState.earclipReachable = linked
    case 0xF4:  // relayed earclip CONFIG (74 B after the type byte for v4 / Path C; 50 B for legacy v3)
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
// ⚠️ Currently unusable — the glasses forward a v3-era 50-byte payload that a v4
// earclip rejects (§4.3). Kept for reference; write the earclip's CONFIG_WRITE
// characteristic directly (§5) until the glasses relay is rebuilt against config v4.
func writeEarclipConfigViaEdge(_ payload50B: Data) {
    var msg = Data([0xC3])
    msg.append(payload50B)             // glasses expect 50 B (v3-era NARBIS_CONFIG_WIRE_SIZE)
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

**✅ Exact working JS (`dashboard/src/ble/edgeDevice.ts` — `onStatusNotify` dispatch + relay-control writes; condensed, full frame layouts in §4.4):**

```js
switch (bytes[0]) {                                                       // 0xFF03 multiplex
  case 0xF6: emit('centralRelayState', { connected: bytes[1] !== 0 }); break;
  case 0xF9: emit('relayedIbi',     { ibi_ms: bytes[1]|(bytes[2]<<8), confidence_x100: bytes[3], flags: bytes[4] }); break;
  case 0xF8: emit('relayedBattery', { mv: bytes[1]|(bytes[2]<<8), soc_pct: bytes[3], charging: bytes[4] }); break;
  case 0xF4: emit('relayedConfig',     { bytes: bytes.slice(1) }); break; // 74 B → deserializeConfig (§3.6)
  case 0xF5: emit('relayedRawPpg',     { bytes: bytes.slice(1) }); break;
  case 0xF7: emit('relayedDiagnostic', { bytes: bytes.slice(1) }); break; // → parseDiagnostic (§3.1.8)
}
// relay-control writes:
// (0xC3 currently unusable — glasses forward a v3-era 50 B payload a v4 earclip rejects, §4.3)
sendCtrlCommand(chCtrl, 0xC4, new Uint8Array([on ? 1 : 0])); // toggle raw-PPG relay
sendCtrlCommand(chCtrl, 0xC1);                              // forget earclip pairing
```

### 4.7 Integration patterns — where coherence runs

There are two ways to put coherence on the glasses. **Pattern A (app-side) is the standard;** Pattern B is legacy.

#### 4.7.1 App-side coherence — recommended (Mode A/B/C)

The app computes coherence + the breathing pacer itself — the **Mode A/B/C engine** (A **Follow** · B **Static Pacer** · C **Settle & Find**, the resonance search) — from whatever HR source it has (Polar H10, Apple Watch, an app-internal PPG detector, or the earclip's own IBI notifications). The glasses are a **display**: the app **drives the lens by commanding the firmware's breathe / static program**, so the glasses still render the smooth waveform locally while the app owns the algorithm. This is the path the Narbis dashboard uses and the one new iOS / web clients should implement.

- **How to drive the lens:** see [§4.8 "Driving the Edge lens"](#48-driving-the-edge-lens) — the breathe ops, the strobe ops, the duty→opacity floor, and the breath-phase sync rule.
- **The algorithm to reproduce:** [`coherence-engine.md`](./coherence-engine.md) (architecture + the three modes) and [`coherence-algorithm-reference.md`](./coherence-algorithm-reference.md) (the verbatim pipeline: outlier gate, IBI ring, Lomb–Scargle / FFT, band integration, peak pick, EWMA, adaptive pacer).
- You do **not** send `0xCA` / `0xB7` in this pattern — the firmware's coherence pipeline is idle and the app owns the lens. (You *may* still read the firmware's own `0xF2` coherence for a parity check if an earclip is paired, but it is not what drives the lens.)

#### 4.7.2 Legacy / Standard on-glasses mode (`0xCA` + `0xB7`)

> **Legacy.** Use this only when you want the *glasses* to compute coherence and drive the lens themselves — a thin client with no app-side engine, or the on-glasses "Standard" program. New clients should prefer [§4.7.1](#471-app-side-coherence--recommended-mode-abc).

Forward your HR source's IBIs to the Edge via `0xCA`; the Edge runs the same coherence pipeline it uses for earclip beats and drives the lens automatically based on the selected PPG program (`0xB7`). You get firmware tuning (`0xE0` / `0xB8` / `0xB9`) and the pacer overlay (`pacer_rate_q5` in `0xF2` — quintets, divide by 5) for free.

**Per-connect setup (do this once each time you connect to the Edge):**

```swift
// 1. Tell the Edge that beats will be coming from iOS, not the earclip.
//    arg = 0 (earclip / resume central scan) or 1 (external — pause central scan).
//    Not persisted; re-assert on every reconnect.
edgePeripheral.writeValue(Data([0xCB, 0x01]), for: edgeControl, type: .withResponse)

// 2. Pick the PPG program (lens behaviour):
//    0 heartbeat        — pulse on every beat
//    1 coh-breathe      — lens follows the breathing pacer
//    2 coh-lens         — lens opacity tracks the coherence score directly
//    3 coh-breathe-strobe — pacer + strobe
edgePeripheral.writeValue(Data([0xB7, 0x02]), for: edgeControl, type: .withResponse)

// 3. (Optional) subscribe to 0xFF03 to receive 0xF2 coherence updates,
//    0xFA link-quality, and 0xF1 firmware logs.
edgePeripheral.setNotifyValue(true, for: edgeStatus)
```

**✅ Exact working JS (`dashboard/src/ble/edgeDevice.ts` — `setHrSource` + `setProgram`):**

```js
sendCtrlCommand(chCtrl, 0xCB, new Uint8Array([1]));  // HR source: 1 = H10/external (pauses earclip scan)
sendCtrlCommand(chCtrl, 0xB7, new Uint8Array([2]));  // PPG program: 2 = coh-lens
```

**Per-beat (call once for each beat your HR source emits):**

```swift
// rrMs is one R-R interval from your HR source, in ms.
// (For Polar H10's 0x2A37 Heart Rate Measurement, convert: rrMs = rrRaw1024 * 1000 / 1024.)
func forwardBeatToEdge(rrMs: UInt16, confidence: UInt8 = 100, isArtifact: Bool = false) {
    let flags: UInt8 = isArtifact ? 0x01 : 0x00
    let bytes: [UInt8] = [
        0xCA,
        UInt8(rrMs & 0xFF),
        UInt8(rrMs >> 8),
        confidence,                 // 0…100; the Edge drops beats below conf_threshold (default 50)
        flags,                      // bit 0 = ARTIFACT (Edge drops these silently)
    ]
    // 0xFF01 is write-WITH-response only (no write-no-response property) — see the note below.
    edgePeripheral.writeValue(Data(bytes), for: edgeControl, type: .withResponse)
}
```

**✅ Exact working JS (`dashboard/src/ble/edgeDevice.ts` — `injectIbi`):**

```js
function injectIbi(chCtrl, ibi_ms, conf = 100, flags = 0) {
  const ibi = Math.max(0, Math.min(0xffff, Math.round(ibi_ms)));
  return sendCtrlCommand(chCtrl, 0xCA, new Uint8Array([ibi & 0xff, (ibi >> 8) & 0xff, conf, flags]));
}
```

**That's the whole integration.** A few notes:

- **Per-beat writes must be `.withResponse`.** The Edge's `0xFF01` control characteristic is registered **read + write only — it has no write-no-response property** (only `0xFF02` OTA data does). Core Bluetooth drops such a write with an API-misuse warning, and Web Bluetooth's `writeValueWithoutResponse()` **rejects with `NotSupportedError`**. At ~1 Hz per beat the with-response round-trip is negligible. (Earlier revisions of this doc recommended `.withoutResponse` here — that never matched the GATT table.)
- **You don't need to gate yourself.** The Edge silently drops beats with `confidence < g_coh_params.conf_threshold` (default 50) or `flags & ARTIFACT`. If your source has no confidence/quality signal, just pass `confidence = 100`.
- **R-R interval bit width.** The doc's `ibi_ms` field is `u16` — values up to 65535 ms. Polar H10's `0x2A37` carries R-R in 1/1024-second units in a `u16`; convert before forwarding.
- **Setting source = `1` (H10) pauses** the Edge's BLE central scan for the earclip — saves power, prevents the earclip pipeline from competing if both happen to be in range. Setting it back to `0` resumes the scan. (On stock builds this is moot — the central is compile-disabled entirely, [§4.6](#46-the-edge-as-relay-path-b).)
- **Pulse-on-beat program (`0xB7 0`)** works with `0xCA` beats — the lens pulses each time your `0xCA` write lands. No earclip required.
- **Coherence updates** arrive on `0xFF03` as `0xF2` frames once per second — but only after the first successful compute (see [§4.4.3](#443-coherence-packet-0xf2--18-b)). Byte 17 carries the current pacer rate in quintets (BPM × 5 — divide by 5) — useful for an in-app overlay.
- **For tuning sliders / sensitivity presets**, see [§4.3.1 Edge-side algorithm tuning](#431-edge-side-algorithm-tuning). The `0xB8` difficulty preset (Easy/Medium/Hard/Expert) is the cheapest UX hook.
- **Prefer app-side coherence** ([§4.7.1](#471-app-side-coherence--recommended-mode-abc)) for new clients — compute the algorithm on the client and drive the lens yourself via [§4.8](#48-driving-the-edge-lens). This `0xCA` path is kept for thin clients and the on-glasses Standard program.

---

### 4.8 Driving the Edge lens

In app-side mode ([§4.7.1](#471-app-side-coherence--recommended-mode-abc)) the app owns the algorithm and tells the lens what to do. This section is the complete drive surface: how to make the lens breathe, how to strobe, the opacity curve, and — the part that bites everyone — how to keep the lens **in phase** with your on-screen cue and audio.

#### 4.8.1 Command the renderer — don't stream PWM

There are two ways to make the lens "breathe" (fade clear → dark → clear):

- **❌ Stream per-tick PWM.** Compute the waveform value every frame and write it as a static duty (`0xA5`) at ~12 Hz. Don't: it's a continuous write stream (BLE air-time + glasses power), and any link jitter or a dropped write shows up as a visible stutter — smoothness becomes hostage to the link.
- **✅ Command the breathe program.** Send a handful of parameter writes **once** and the glasses render the smooth **100 Hz cosine locally**. The link carries only occasional writes; the waveform is smooth regardless of BLE conditions. This is the "fade clear→dark over the inhale, dark→clear over the exhale, repeating" primitive — the firmware owns the interpolation.

> There is **no one-shot "ramp A→B over T seconds" opcode.** Breathe mode *is* the timed fade, but it is **cyclic** (repeats every breath). For a steady, non-breathing tint that just tracks a slow value, use `0xA5` as a **setpoint you refresh ~1 Hz** — not a per-frame stream.

> ⚠️ **On BLE disconnect the lens freezes at its last commanded output.** The firmware's disconnect handler touches no lens state — whatever mode/duty was running keeps running. If your app crashes (or the link drops) while the lens is dark, the wearer stays dark until they use the magnet or the session-expiry sleep fires. Mitigations: command a low depth before intentional disconnects, and treat "reconnect → re-assert lens state" as mandatory in your reconnect path.

#### 4.8.2 The breathe op set

| Opcode | Arg | Meaning |
|---|---|---|
| `0xB0` | `0x00` | enter BREATHE mode (firmware renders the cosine from here on) |
| `0xB1` | bpm 1–30 | breathe rate — **integer BPM** (see §4.8.4) |
| `0xB2` | pct 10–90 | inhale fraction (40 = inhale 40 % / exhale 60 %) |
| `0xA2` | pct 0–100 | amplitude / depth — peak lens darkness at full inhale (your coherence → depth map) |
| `0xBA` | `[cycle_ms u16 LE][inhale_pct u8]` | **phase-lock + exact cycle** (fw ≥ 4.15.5) — see §4.8.4 |
| `0xA5` | pct 0–100 | STATIC mode — immediate tint; use as a slow setpoint, not a stream |

```swift
func edgeEnterBreathe(ctrl: CBCharacteristic, on p: CBPeripheral) {
    p.writeValue(Data([0xB0, 0x00]), for: ctrl, type: .withResponse)   // enter breathe (once)
}

// Call ONLY at a breath boundary (see §4.8.4). cycleMs = full breath; depthPct from your coherence.
func edgePushBreath(cycleMs: UInt16, inhalePct: UInt8, depthPct: UInt8,
                    ctrl: CBCharacteristic, on p: CBPeripheral) {
    let bpm = UInt8(max(1, min(30, (60_000 + Int(cycleMs) / 2) / Int(cycleMs))))
    p.writeValue(Data([0xBA, UInt8(cycleMs & 0xFF), UInt8(cycleMs >> 8), inhalePct]),
                 for: ctrl, type: .withResponse)                      // exact cycle + phase anchor
    p.writeValue(Data([0xB1, bpm]),       for: ctrl, type: .withResponse)  // integer-rate fallback (old fw)
    p.writeValue(Data([0xB2, inhalePct]), for: ctrl, type: .withResponse)
    p.writeValue(Data([0xA2, depthPct]),  for: ctrl, type: .withResponse)  // depth for THIS breath
    // (0xFF01 is write-with-response only — it has no write-no-response property.)
}
```

**✅ Exact working JS (`dashboard/src/ble/edgeDevice.ts` — the `0xBA` write is exact; `driveLens` condensed):**

```js
async function syncBreath(chCtrl, cycleMs, inhalePct) {
  const c   = Math.max(2000, Math.min(30000, Math.round(cycleMs)));
  const inh = Math.max(10, Math.min(90, Math.round(inhalePct)));
  await sendCtrlCommand(chCtrl, 0xBA, new Uint8Array([c & 0xff, (c >> 8) & 0xff, inh]));
}
// driveLens(state) coalesces the engine's desired lens state into 0xB0 (enter breathe, once) +
// 0xB1 rate + 0xB2 inhale + 0xA2 depth, writing an opcode only when its value changed. The engine
// calls driveLens ~1 Hz and syncBreath at each breath boundary (§4.8.4). Full driveLens() + the
// per-breath latch are in edgeDevice.ts / coherenceEngine.ts.
```

#### 4.8.3 Lens opacity is not linear — the duty→opacity floor (fw ≥ 4.15.4)

The electrochromic cell shows **no visible tint below ~26 % drive**, so the firmware remaps your duty onto the *visible* range: **duty 0 → fully clear; duty 1..100 → raw [265..1023]** (duty 1 is already the first visible step, ~26 % electrically). Consequences for your coherence → `0xA2` / `0xA5` mapping:

- `depth = 0` is the only fully-clear value. `depth = 1` is **already visibly tinted** — the bottom of the range is a **hard step**, not a fade-in.
- Usable contrast is `1..100`. Treat `0` as "off"; map coherence onto `1..100` (or a floor like `8..100` if you want the lens to always show *something*).

#### 4.8.4 Phase sync — the one rule: write only at the breath boundary

The firmware's breathe phase is **free-running**: `t = (tick_count × 10 ms) mod cycle_ms`, and nothing resets it. So the glasses' inhale/exhale boundaries fall at **arbitrary times** relative to your on-screen breathing cue and your audio chime — they drift apart. And `0xB1` is **integer BPM**, so a fractional pacer (e.g. 5.4 br/min) rounds, adding a rate mismatch.

**`0xBA BREATHE_SYNC` `[cycle_ms u16 LE][inhale_pct u8]`** fixes both: it **restarts the cosine at the instant of the write** (phase origin = now = start of inhale) **and** sets the **exact** cycle length in ms.

> ### ⚠️ Send `0xBA` (and any `0xB1` / `0xA2` change) **only at the breath-cycle boundary** — never mid-breath
>
> Two independent reasons:
> 1. **The correction is invisible at the seam.** Re-anchor when *your* clock is at the start of inhale (waveform ≈ 0, lens at its clearest). Both clocks are at the same point, so the phase fix is a visual no-op. Re-anchoring mid-inhale teleports the firmware's phase → a visible snap.
> 2. **Mid-breath param changes warp the waveform.** The firmware recomputes `effective_duty = wave(frac) × depth` every 10 ms from the *live* params. Change the rate (→ `cycle_ms` / `inhale_ms`) or the depth (`0xA2`) mid-inhale and `frac` or the product moves **non-monotonically** — the lens darkens, clears a bit, then darkens again. (This exact stutter is a bug we shipped, then fixed by moving to boundary-only writes.)
>
> **So: latch your breathe params per breath.** Sample rate + depth once at each boundary, hold them for the whole breath, and push (`0xBA` + `0xB1` + `0xA2`) only at the next boundary.

The firmware also **slew-rate-limits** the breathe tint (≤ 4 %/10 ms ≈ 250 ms full-scale fade) as belt-and-suspenders, so the one unavoidable correction — the very first anchor, a deliberate rate snap, or a reconnect — *fades* instead of snapping. You do nothing for this; just know it exists, and that it does **not** apply to strobe.

One more reason the per-boundary send is non-negotiable: the `0xBA` exact-cycle override **auto-expires ~2 cycles after the last write**, after which the firmware falls back to the integer-BPM `0xB1` rate. The boundary write is a **keep-alive** — skip a couple of breaths and the lens quietly de-syncs to the rounded rate. (The firmware also clamps `cycle_ms` to 2000–30000 ms, matching the JS clamp above.)

**Drive the on-screen cue and the audio chime off the SAME app breath clock** as your `0xBA` writes. Because the lens is now phase-locked to that clock, screen + sound + physical lens all line up — including as the pacer rate drifts.

```swift
// The app owns a breath clock: cycleMs, and phase ∈ [0,1) advanced by elapsed time.
// Drive the on-screen cue AND the chime from THIS clock too — one clock for everything.
var phase = 0.0
var cycleMs: UInt16 = 10_000
var pendingCycleMs: UInt16 = 10_000   // engine updates these continuously…
var pendingDepth: UInt8 = 0           // …but they are APPLIED only at the boundary.

func onEnterBreathe() {
    edgeEnterBreathe(ctrl: ctrl, on: p)
    edgePushBreath(cycleMs: cycleMs, inhalePct: 40, depthPct: pendingDepth, ctrl: ctrl, on: p) // initial anchor
}

func onFrame(dtMs: Double) {
    phase += dtMs / Double(cycleMs)
    if phase >= 1.0 {                       // ← BREATH BOUNDARY (frac ≈ 0)
        phase -= 1.0
        cycleMs = pendingCycleMs            // re-sample rate ONCE, here
        edgePushBreath(cycleMs: cycleMs, inhalePct: 40, depthPct: pendingDepth, ctrl: ctrl, on: p) // + depth, here
    }
    updateOnScreenCue(phase)                // smooth, app-side
    maybePlayChime(phase)                   // inhale/exhale edges off the same clock
    // NOTHING about rate/depth/cycle is written to the glasses between boundaries.
}
```

**✅ Exact working JS (`dashboard/src/engine/coherenceEngine.ts` — the boundary push the dashboard uses):**

```js
onBreathBoundary() {              // fires once per breath, at frac ≈ 0
  this.cycleMs = this.pacer.latch();
  this.latchLensParams();         // sample depth + rate ONCE, here (held for the whole breath)
  this.emitLens();                // → edgeDevice.driveLens: 0xB0 / 0xB1 / 0xB2 / 0xA2 (coalesced)
  this.emitSync();                // → edgeDevice.syncBreath: 0xBA cycle_ms + inhale%
}
// Between boundaries, nothing rate/depth/cycle is sent; the on-screen cue + chime read
// coherenceEngine.breathCyclePos() — the same clock the 0xBA writes anchor.
```

#### 4.8.5 Strobe

| Opcode | Arg | Meaning |
|---|---|---|
| `0xA6` | `0x00` | enter STROBE mode |
| `0xAB` | see below | strobe frequency |
| `0xAC` | pct 10–90 | dark fraction of each strobe period |

`0xAB` has **two wire forms** — use the deci-Hz form for sub-Hz precision (brainwave-entrainment targets like 13.5 / 17.5 Hz):

```swift
// integer Hz (2 bytes):        [0xAB, hz]
// deci-Hz   (3 bytes, prefer): [0xAB, dHz_lo, dHz_hi]  where dHz = round(hz * 10)
func edgeSetStrobeHz(_ hz: Double, ctrl: CBCharacteristic, on p: CBPeripheral) {
    let dHz = UInt16((max(1.0, min(50.0, hz)) * 10).rounded())          // e.g. 13.5 Hz → 135
    p.writeValue(Data([0xAB, UInt8(dHz & 0xFF), UInt8(dHz >> 8)]), for: ctrl, type: .withResponse)
}
```

**✅ Exact working JS (`dashboard/src/ble/edgeDevice.ts` — `setStrobeFreqHz`, deci-Hz form):**

```js
async function setStrobeFreqHz(chCtrl, hz) {
  const dhz = Math.round(Math.max(1, Math.min(50, hz)) * 10);   // e.g. 13.5 Hz → 135
  await sendCtrlCommand(chCtrl, 0xAB, new Uint8Array([dhz & 0xff, (dhz >> 8) & 0xff]));
}
// enter strobe: sendCtrlCommand(chCtrl, 0xA6);  set dark duty: sendCtrlCommand(chCtrl, 0xAC, new Uint8Array([pct]));
```

> **Strobe needs hard edges — never smooth, slew, or ramp it.** Write the params once and let the firmware's ISR toggle. (The breathe slew limiter in §4.8.4 deliberately does not touch strobe.)
>
> **Breathe + strobe** (a strobe whose dark-duty is modulated by the breathing wave) is entered with **`0xB0 0x01`** (firmware ≥ 4.15.6): the breathe arg selects the variant — `0xB0 0x00` = plain breathe, `0xB0 0x01` = breathe+strobe. It stays phase-locked to `0xBA` / `0xB1` / `0xB2` exactly like plain breathe, and toggling the arg `0↔1` preserves the breathe phase. On firmware **< 4.15.6** there is no standalone breathe+strobe opcode — fall back to pure breathe (`0xB0`) **or** pure strobe (`0xA6`).

#### 4.8.6 Backward compatibility & version

`0xBA` is **ignored by firmware < 4.15.5** (unknown opcode → silent no-op), so you can always send it; on old firmware the lens stays on the integer-`0xB1` rate path (rate-matched, not phase-locked). **The Edge does not expose a Device Information Service**, so there is no GATT-read firmware-version characteristic — send `0xBA` unconditionally (it's safe) rather than gating on version. If you genuinely need the version, the one probe that exists is the `0xF1` subscribe-hello (`Narbis fw v<version> …` — [§4.4.2](#442-log-string-0xf1--variable)). (The *earclip* does expose DIS `0x180A` / `0x2A26` — [§3.4](#34-device-information-service--0x180a) — but that is the earclip's version, not the Edge's.)

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

// 1. Read current config (74 B = 72 B struct + 2 B CRC for Path C / v4).
peripheral.readValue(for: chConfig)

// 2. In peripheral(_:didUpdateValueFor:error:), parse and modify:
func peripheral(_ p: CBPeripheral, didUpdateValueFor c: CBCharacteristic, error: Error?) {
    guard c.uuid == CBUUID(string: "553abc98-6406-4e37-b9fd-34df85b2b6c1"),
          let data = c.value, data.count == 74 else { return }

    // Verify CRC (last 2 bytes are CRC over first 72).
    let body = data.subdata(in: 0..<72)
    let receivedCRC = UInt16(data[72]) | (UInt16(data[73]) << 8)
    guard narbisCRC16(body) == receivedCRC else {
        print("CONFIG CRC mismatch")
        return
    }

    var cfg = decodeConfig(body)            // your byte-by-byte decoder
    cfg.dataFormat = 2                       // IBI_PLUS_RAW
    cfg.bleProfile = 1                       // LOW_LATENCY

    let newBody = encodeConfig(cfg)          // your byte-by-byte encoder, 72 B
    let newCRC  = narbisCRC16(newBody)
    var payload = Data(newBody)
    payload.append(UInt8(newCRC & 0xFF))
    payload.append(UInt8(newCRC >> 8))

    p.writeValue(payload, for: chConfigWrite, type: .withResponse)
}
```

**✅ Exact working JS (`dashboard/src/ble/narbisDevice.ts` — `writeConfig()`):**

```js
async function writeConfig(chConfigWrite, cfg) {
  const blob = serializeConfig(cfg);   // 74 B incl. CRC — see §3.6 (offsets) + serializer there
  await chConfigWrite.writeValueWithResponse(blob);
}
// On connect the dashboard reads CONFIG once → deserializeConfig(), and subscribes for live updates
// (the earclip notifies the full 74 B after every accepted CONFIG_WRITE / MODE write).
```

For just changing the data format / profile, the 2-byte MODE write is much cheaper:

```swift
peripheral.writeValue(Data([1, 2]), for: chMode, type: .withResponse)
//                          ^  ^
//                          |  data_format = IBI_PLUS_RAW
//                          ble_profile   = LOW_LATENCY
```

**✅ Exact working JS (`dashboard/src/ble/narbisDevice.ts` — `writeMode()`):**

```js
await chMode.writeValueWithResponse(new Uint8Array([1, 2])); // [ble_profile=LOW_LATENCY, data_format=IBI_PLUS_RAW]
```

The earclip will notify on the CONFIG characteristic with the updated 74-byte payload after either write succeeds — subscribe to it once at startup so your view layer stays in sync.

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
| Status | `0xFF03` | read + notify (plain notify on both devices — [§7.3](#73-indicate-vs-notify)) | Status frames 1–7 B |

### 6.2 Constants

| Constant | Value |
|---|---|
| Page size | 4096 B (one flash erase block) |
| Recommended chunk size | **244 B** (`MTU − 3` at the negotiated MTU 247; the dashboard uses `NARBIS_OTA_CHUNK_SIZE = 244`). Both devices accept up to `MTU − 3 = 244` per OTA-data write. |
| Page CRC | Standard CRC-32 (poly `0xEDB88320` — ESP-IDF `esp_crc32_le`, same as `zlib.crc32`), computed by the device over each full 4096-B page. ⚠️ Packed **big-endian** in the PAGE_CRC notification — see §6.4 |

### 6.3 Opcodes (write to `0xFF01` as `[opcode, param]`)

| Opcode | Name | Param | Meaning |
|---|---|---|---|
| `0xA8` | START | `0x00`, or `[size:u32 LE]` (**Edge only**) | Enter OTA mode; device responds with `READY`. On the **Edge**, the optional 4-byte image size makes OTA-begin erase an **image-sized region** instead of the full slot — send it (the erase is what blocks the radio; see the note at the end of §6.8). The **earclip** accepts only the exact 2-byte `[0xA8, 0x00]` form (its control point rejects any other write length) and erases incrementally (`esp_ota_begin(OTA_SIZE_UNKNOWN)`), so it has no long erase to shorten |
| `0xA9` | FINISH | `0x00` | Flush, set boot partition, reboot |
| `0xAA` | CANCEL | `0x00` | Abort transfer |
| `0xAD` | PAGE_CONFIRM | `0x01` commit / `0x00` resend | Driven by client after verifying PAGE_CRC |

### 6.4 Status notifications (read from `0xFF03`)

| First byte | Name | Length | Payload |
|---|---|---|---|
| `0x01` | READY | **1 B** Edge / 4 B earclip | `01` (earclip pads: `01 00 00 00`) |
| `0x02` | PROGRESS | — | Reserved; defined on both devices, emitted by neither |
| `0x03` | SUCCESS | **1 B** Edge / 4 B earclip | `03` (earclip: `03 00 00 00`) — reboot is imminent, expect disconnect |
| `0x04` | ERROR | **2 B** Edge / 4 B earclip | `04 <err>` (earclip: `04 <err> 00 00`) |
| `0x05` | CANCELLED | **1 B** Edge / 4 B earclip | `05` (earclip: `05 00 00 00`) |
| `0x06` | PAGE_CRC | 7 B | `06 page_hi page_lo crc32_be[4]` — client must verify and ack |
| `0x07` | PAGE_OK | 3 B | `07 page_hi page_lo` — page committed to flash |
| `0x08` | PAGE_RESEND | 3 B | `08 page_hi page_lo` — restart this page |

> **Don't length-match the simple statuses.** The Edge sends them minimal (1–2 B); the earclip zero-pads the same codes to 4 B. Dispatch on the first byte and read `<err>` from byte 1 when present. (Earlier revisions of this doc showed the 4-B padded forms for both devices.)
>
> **Byte-order quirk — the `0x06` PAGE_CRC frame is big-endian throughout.** The page number is `page_hi` first (as in `0x07`/`0x08`), **and the CRC32 is packed most-significant byte first** (`crc >> 24` at offset 3). This is the one exception to the little-endian rule ([§9.2](#92-wire-conventions)). Earlier revisions of this doc said `crc32_le` — unpack it little-endian and every page verification fails.
>
> **The final partial page gets no PAGE_CRC.** Only full 4096-B pages trigger the CRC/confirm exchange; the trailing partial page is flushed by FINISH (`0xA9`) without a per-page check. Don't wait for a `0x06` after the last chunks — send `0xA9`.
>
> **PAGE_RESEND rewinds the whole page.** On `[0xAD, 0x00]` the device discards its entire 4096-B page buffer (offset back to 0) — resend the page from byte 0, not just the tail.
>
> **Stop-and-wait is mandatory, not advisory.** Any `0xFF02` data written while a page is awaiting its `0xAD` confirm is **silently dropped** — you cannot pipeline the next page behind the CRC exchange. And a single `0xFF02` write must **never straddle a 4096-B page boundary**: bytes past the boundary in that write are discarded (the Edge logs `bytes crossed page boundary (discarded)`). Since 4096 = 244 × 16 + 192, size your final chunk of each page accordingly.

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

The `esp_app_desc_t` sits at **fixed file offset `0x20`** (24-byte image header + 8-byte first-segment header): `magic 0xABCD5432` (u32 LE) at `0x20`, then `secure_version` (4 B) and 8 reserved bytes, so the NUL-terminated **`version[32]` string starts at `0x30`**. Earlier revisions of this doc said "typically around 0x20–0x40" — the offset is not fuzzy; read it directly. See `ota-additions/firmware_validator.js` for a working JavaScript implementation you can port to Swift.

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
    case 0x06:  // PAGE_CRC — page number AND crc32 are big-endian (§6.4)
        let pageHi = data[1], pageLo = data[2]
        let pageNumber = UInt16(pageHi) << 8 | UInt16(pageLo)
        let crc = UInt32(data[3]) << 24 | UInt32(data[4]) << 16
                | UInt32(data[5]) << 8  | UInt32(data[6])
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

**✅ Exact working JS (`webapp/ota/index.html` — the dashboard's OTA updater; condensed, full loop in that file):**

```js
const CHUNK_SIZE = 244, PAGE_SIZE = 4096;
function crc32(data) { /* ESP-IDF esp_rom_crc32_le, poly 0xEDB88320 — table-driven; see the file */ }

async function sendPageChunks(cD /* 0xFF02 */, pageData) {
  for (let i = 0; i * CHUNK_SIZE < pageData.length; i++) {
    await cD.writeValueWithoutResponse(pageData.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE));
  }
}
// 1. cC.writeValueWithResponse([0xA8, 0x00])  → wait for 0x01 READY  (0xFF01 control has no write-no-response)
// 2. per 4 KB page: sendPageChunks(cD, page) → wait for 0x06 PAGE_CRC, then:
//      frame.crc = (b[3]<<24 | b[4]<<16 | b[5]<<8 | b[6]) >>> 0;   // BIG-endian on the wire (§6.4)
//      crc32(page) === frame.crc ? cC.write([0xAD, 0x01]) /*commit*/ : cC.write([0xAD, 0x00]) /*resend*/
//    → 0x07 PAGE_OK (next page) | 0x08 PAGE_RESEND (retry)
// 3. cC.write([0xA9, 0x00]) FINISH → 0x03 SUCCESS (device reboots)
// Same state machine as the Swift above. Full impl (crc32 table, retries, MTU-safe chunking) in webapp/ota/index.html.
```

> **Do NOT treat a 5–10 second silence on `0xFF03` mid-OTA as a stall.** When the Edge erases its update partition at OTA begin (an image-sized region), the radio can be blocked for **well past 19 seconds** on worn flash. The **32-second** supervision timeout (the BLE max) is set for exactly this reason. Don't call `cancelPeripheralConnection` until you've waited at least 35 s with no progress.

---

## 7. iOS / Core Bluetooth gotchas

### 7.1 GATT caching

iOS aggressively caches discovered services per peripheral identifier. Neither device mutates its GATT table at runtime, so this is fine — but if you ever ship a firmware that adds characteristics, you'll need to bump the device's `serviceChanged` indication or instruct users to forget the device in iOS Settings.

### 7.2 MTU is final after discovery

`maximumWriteValueLength(for:)` returns the post-negotiation value only after `didDiscoverServices` fires. Don't read it earlier — you'll get the safe-default 20.

### 7.3 Indicate vs notify

**Both devices use plain notify — nothing uses indicate.** The Edge's `0xFF03` is registered with `BLE_GATT_CHR_F_NOTIFY` and emits via `ble_gatts_notify_custom()`; there is no per-frame link-layer ACK, and no "keep one indicate in flight" pacing rule for OTA. (Earlier revisions of this doc claimed the Edge used indicate internally — that was wrong.) Back-pressure on notification-heavy paths is the OS's job on both devices; on the write side, don't hammer the earclip's CONFIG_WRITE faster than ~10 Hz.

### 7.4 CCCD subscription order matters for Edge OTA

You must subscribe to `0xFF03` **before** sending an OTA opcode, otherwise you'll miss `READY`, all `PAGE_CRC` notifications, and the final `SUCCESS`/`ERROR`. There's no way to recover the protocol from the middle. The same characteristic also carries the new relay frames (`0xF4`–`0xF7`) so subscribing once covers both flows.

### 7.4a Always write PEER_ROLE early on the earclip

🆕 **Path B.** When connecting to the earclip, write `0x01` (DASHBOARD) to PEER_ROLE **before** you enable any notifications, otherwise you'll start receiving notifications under the global default `BATCHED` profile (slow, 50–100 ms intervals) and the conn-update from your role write will arrive a few hundred ms later. Doing it first means your very first IBI lands at LOW_LATENCY pacing.

### 7.5 No NACKs from either device

Neither device sends an explicit failure response for an out-of-range command — it just silently clamps or drops. Wrap every write in a Swift timeout / response correlator.

### 7.6 Edge advertising teardown

After **2 minutes** of no client connection the Edge powers down its BLE radio entirely (was 5 minutes before fw main 2026-07). Surface this in your UX: "Tap your glasses to wake them" rather than spinning a connect retry forever.

### 7.7 Reconnection

Both devices auto-resume advertising on disconnect. Just call `central.connect(_:options:)` again from `centralManager(_:didDisconnectPeripheral:error:)`. Use exponential backoff (1, 2, 4, 8, 16, 30 seconds) — the same cadence the dashboard uses.

### 7.8 Background / state restoration

If you build a background-scanning app, set `CBCentralManagerOptionRestoreIdentifierKey`. Implement `centralManager(_:willRestoreState:)` and re-attach delegates to the restored peripherals. Both devices behave identically across foreground and background — there are no special "background-only" advertisements.

### 7.9 watchOS

watchOS 6+ supports Core Bluetooth identically (you'll need the `bluetooth-central` background mode in your `WKExtension` plist). Connection parameter ranges are tighter on Apple Watch than iPhone — test on real hardware. Our supervision timeout of 32 s on Edge is well within watchOS limits.

### 7a. Web Bluetooth gotchas

The wire protocol is identical, but Web Bluetooth (Chrome / Edge) differs from Core Bluetooth in ways that will bite you — and the **Narbis dashboard itself is a Web Bluetooth app**, so these are battle-tested:

- **User gesture required.** `navigator.bluetooth.requestDevice()` must be called from a click/tap handler — you **cannot** auto-connect on page load or reconnect silently. There is no passive scan; the browser shows a device chooser, one device per call.
- **`optionalServices` is mandatory.** Any service you call `getPrimaryService()` on must be listed in a `filter` **or** in `optionalServices` at `requestDevice()` time, or the call throws `SecurityError`. Include the custom Narbis service, the PMD service, and any SIG service (`0x180d` / `0x180f` / `0x180a`) you read. (Exact filters: [§2.2](#22-central-manager).) This is the #1 footgun.
- **No RSSI.** Web Bluetooth never exposes RSSI to JS — which is exactly why the Edge ships link RSSI up in the `0xFA` frame ([§4.4.11](#4411-link-quality-0xfa--7-b)). Drive signal-strength UI from that, not the BLE API.
- **No MTU API.** No `maximumWriteValueLength`; `writeValue()` fragments for you. Keep writes ≤ 244 B and don't worry about it ([§2.4](#24-mtu--check-it-after-discovery-not-before)).
- **Foreground only.** A backgrounded/hidden tab throttles timers and can stop delivering notifications. The H10 beat-clock and ACC paths re-anchor after such gaps ([§3a.2](#3a2-rr-from-the-standard-hr-service--beat-timestamp-reconstruction)); expect drop-outs when the tab isn't visible. **This contradicts [§7.8](#78-background--state-restoration), which is iOS-only — there is no Web Bluetooth background mode.**
- **Browser support.** Chrome / Edge / Brave on desktop + Android only. **No Firefox, no Safari, no iOS browser** (iOS has no Web Bluetooth — ship a native app there).
- **Permission caching + `device.forget()`.** The browser caches an accepted device (~30 s after disconnect) and re-matches it on the next `requestDevice()` without prompting. If a device's GATT cache goes stale (the "needs multiple Forget+Connect cycles" symptom), call `device.forget()` (Chrome 114+) to release the grant — the dashboard does this in `narbisDevice.forget()`.
- **`writeValueWithResponse` vs `WithoutResponse`.** `WithoutResponse` works only where the characteristic actually has the write-no-response property — on these devices that is **only the OTA data char `0xFF02`**. The Edge's `0xFF01` control char (including per-beat `0xCA`) is write-with-response only; `writeValueWithoutResponse()` on it rejects with `NotSupportedError`. Use `WithResponse` for all control writes.

```js
// Everything starts from a user gesture:
button.addEventListener('click', async () => {
  const device = await navigator.bluetooth.requestDevice({ filters: [/*…*/], optionalServices: [/*every service you read*/] });
  const server = await device.gatt.connect();
  // …getPrimaryService / getCharacteristic / startNotifications…
});
```

---

## 8. Troubleshooting matrix

| Symptom | Likely cause | Fix |
|---|---|---|
| Can't see Edge in scan | 2-minute idle teardown after disconnect (radio fully powered down) | User taps the magnet on the glasses to re-arm advertising |
| Both devices appear with the same service UUID | They share `0x00FF` for OTA | Disambiguate by `peripheral.name` |
| OTA fails immediately on earclip with err `0x06` | Battery SoC < 30 % | Charge the earclip before retry |
| OTA fails on earclip with err `0x07` | Wrong `.bin` (Edge image targeted at earclip) | Validate the chip-id field (offset `0x0C`) before sending |
| Connection drops mid-OTA | iOS cancelled before partition erase finished | Don't call `cancelPeripheralConnection` for at least 35 s after last progress |
| MODE write succeeds but format unchanged | Wrote to the wrong characteristic UUID | Verify you're using `71db6de8-…` (earclip-only) — not `0xFF01` |
| Notifications stop after a few seconds | Forgot to enable the CCCD | `peripheral.setNotifyValue(true, for: chr)` for every notify char |
| Garbled CONFIG read | Skipped CRC verification | Validate the last 2 B with CRC-16-CCITT-FALSE; it should match a CRC over `data.count - 2` payload bytes (72 B for v4 / Path C, 48 B for v3 / Path B) |
| No `0xF2` coherence frames ever arrive | The firmware pipeline has never completed a compute — it emits nothing until ≥ `min_ibis` beats (default 20) are collected, and on stock builds the earclip central is compile-disabled ([§4.6](#46-the-edge-as-relay-path-b)) so no beats reach it | Feed beats via `0xCA` (§4.7.2) and wait ~`min_ibis` beats for the first frame. On a relay-enabled build: check the latest `0xF6` relay-state frame on `0xFF03`; if `linked=0`, send `0xC1` and let the Edge re-pair, or get the earclip into range. (You'll never see a live frame with `n_ibis_used = 0` — silence, not a zero field, is the no-data signal.) |
| `0xF4`/`0xF5` frames never arrive even with `0xF6 linked=1` | Earclip has no skin contact / no signal | Confirm with earclip BATTERY notify or SQI; raw stream needs `0xC4 1` to be enabled |
| New iOS app gets stuck at BATCHED cadence even after writing PEER_ROLE | Wrote PEER_ROLE *after* enabling notifies | Re-order: write `[0x01]` to PEER_ROLE first, then `setNotifyValue(true, …)` on IBI |
| Earclip CONFIG read returns 74 B but parser expects 50 B (or 58 B) | Parser stuck on an older `config_version` | Branch on `config_version` (offset 0): `≤2` legacy 56-B struct, `3` Path B 48-B struct, `4` Path C 72-B struct. The first 48 bytes of v3 and v4 are identical, so a v3-only parser can read everything it knows from a v4 frame by ignoring bytes 48..71 |
| Health telemetry `ble_send_errors` climbing | Client overflowing the device's send queue | Slow down command writes; check for tight write loops |
| `firmware_revision` reads as empty string | Read before discovery completed | Read inside `didDiscoverCharacteristicsFor:` callback, not on `didConnect` |
| RAW_PPG never fires | `data_format` is `IBI_ONLY` | Write MODE to set `data_format = 1` or `2` |
| Edge `0xFF04` / `0xF0` never arrive | The on-glasses PPG front-end was removed — neither is emitted on current builds ([§4.4.1](#441-adc-stats-0xf0--11-b), [§4.5](#45-ppg-stream-characteristic-0xff04)) | Use earclip PPG/IBI instead — direct ([§3.1](#31-custom-narbis-service--a24080b2-8857-4785-b3ba-a43b66af4f28)) or relayed on a relay-enabled build |
| Every OTA page fails CRC verification | Client unpacks the `0x06` CRC32 little-endian | The PAGE_CRC frame packs page number **and** CRC32 big-endian ([§6.4](#64-status-notifications-read-from-0xff03)) |
| Glasses vanish mid-session while connected | Session auto-sleep expired (default 30 min from wake, `0xA4`-persisted; the clock is not restarted by `0xA4`) → deep sleep | Set a longer duration via `0xA4` at session start; estimate remaining as `minutes × 60 − 0xF3 uptime_s`; re-wake by magnet tap |
| Lens program changes by itself mid-session / lens stuck dark after app crash | Magnet gestures stay live while connected (short tap cycles programs); on disconnect the lens freezes at its last output ([§4.1.1](#411-standalone-programs--magnet-gestures), [§4.8.1](#481-command-the-renderer--dont-stream-pwm)) | Watch `0xF3 led_mode` and re-assert your program; re-assert lens state on every reconnect |

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
  CONFIG         553abc98-6406-4e37-b9fd-34df85b2b6c1   read + notify   (74 B in v4 / Path C; was 50 B in v3 / Path B)
  CONFIG_WRITE   129fbe56-cbd6-4f52-957b-d80834d6abf3   write           (74 B in v4 / Path C; was 50 B in v3 / Path B)
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

EDGE — Single custom service (Path B / current)
  Service                             0x00FF
    Control                           0xFF01   read + write
                                               opcodes 0xA2..0xE0 (sparse)
                                               🆕 0xC1/C3/C4/C5 (relay control), 0xCA/CB (H10 path), 0xE0 (coh tuning)
    OTA Data                          0xFF02   write + write-no-response
    Status (multiplexed)              0xFF03   read + notify (plain notify — §7.3)
                                               own packets 0xF1/F2/F3/FA (0xF0 not emitted — §4.4.1)
                                               🆕 relay packets 0xF4..0xF9
                                               OTA codes 0x01..0x08
    PPG Stream                        0xFF04   read + notify (not emitted on current builds — §4.5)

OTA — Shared between Edge and Earclip (same UUIDs)
  Service                             0x00FF
    Control                           0xFF01
    Data                              0xFF02
    Status                            0xFF03
```

### 9.2 Wire conventions

- Endianness: **little-endian** everywhere. (Single exception: the OTA `0x06`/`0x07`/`0x08` status frames pack the page number — and, in `0x06`, the CRC32 — **big-endian**. See [§6.4](#64-status-notifications-read-from-0xff03).)
- Structs: byte-packed, no padding except where explicitly named (`reserved_*`).
- Booleans: `u8` with values `0` or `1` — never a C `bool`.
- Fixed-point: scaled integers (`_x10`, `_x100`, `_x1000`) — no float in any wire format.
- CRC for config and ESP-NOW frames: **CRC-16-CCITT-FALSE** (poly `0x1021`, init `0xFFFF`, no reflect, no xor-out).
- CRC for OTA pages: standard **CRC-32** (poly `0xEDB88320`, = `zlib.crc32`) — but packed **big-endian** in the PAGE_CRC frame.

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

### 9.4 Edge firmware function-anchor index (current Path B build)

These anchors don't drift with every commit the way line numbers do — grep for the function name in `main/main.c` (root: `C:\NARBIS APP\Oct_4_25\Clone\edge-firmware\v4\Code-Glasses\`).

| Topic | Function / symbol in `main/main.c` |
|---|---|
| Service / characteristic UUID `#define`s | `GATTS_SERVICE_UUID`, `GATTS_CHAR_UUID_CTRL/OTA/STATUS/PPG` |
| Generic notify emitter for any `0xF*` frame | `send_status_frame()` |
| Advertising setup + auto-stop | `start_advertising()` |
| 5-tap "forget earclip" hall gesture | `hall_task()` + `TAP_FORGET_COUNT` |
| Command opcode dispatch (every `0xA2`..`0xE0`) | `process_command()` |
| OTA state machine + page-CRC protocol | `ota_task()` + `process_ota_data()` |
| `0xF0` ADC stats builder | `ppg_emit_adc_stats()` |
| `0xF1` log-frame emitter (printf-style) | `ble_log()` |
| `0xF2` coherence packet builder | `coh_emit_packet()` |
| `0xF3` health-telemetry builder | `ppg_emit_health()` |
| `0xFA` link-quality builder | `emit_link_quality()` |
| `0xF4` relayed earclip CONFIG | `on_earclip_config()` |
| `0xF5` relayed earclip RAW_PPG | `on_earclip_raw()` |
| `0xF6` relay link state (UP/DOWN) | `on_central_state()` |
| `0xF7` relayed earclip diagnostics | `on_earclip_diag()` |
| `0xF8` relayed earclip battery (binary) | `on_earclip_battery()` |
| `0xF9` relayed earclip IBI (binary) | `on_earclip_ibi()` |

In `components/narbis_ble_central/`:

| Topic | Where |
|---|---|
| Central state machine + scan/pair/discover/subscribe | `narbis_ble_central.c` |
| Public callback registration API | `include/narbis_ble_central.h` — see the `narbis_central_register_*` functions |
| Earclip-side characteristic UUIDs the central discovers | mirrored in `components/narbis_protocol/narbis_protocol.h` |
