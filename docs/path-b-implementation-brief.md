# Path B Implementation Brief — BLE-only across all three components

## 0. Context (read this before doing anything else)

The Narbis system has three components, all in this repo:

```
edge-earclip/
  firmware/                              ← earclip firmware (BLE peripheral)
  dashboard/                             ← Web Bluetooth dashboard (BLE central, browser-side)
  EDGE/
    EDGE FIRMWARE/main_v4_14_38 (1).c    ← Edge glasses firmware (currently BLE peripheral; becomes BLE central in this change)
    EDGE DASHBOARD/                      ← Edge glasses' own dashboard (probably for OTA / config; orthogonal)
    EDGE OTA/                            ← Edge glasses' OTA webapp
```

PPK2 measurements established:
- Wi-Fi/ESP-NOW costs ~28 mA continuously, cannot be reduced via software on ESP32-C6 + IDF 5.5
- BLE-only floor with PM tuning: ~25–35 mA dashboard-connected, ~5–15 mA when idle
- Quick wins (`NARBIS_AGC_LED_MAX_X10`, `BT_LE_SLEEP_ENABLE`, `MAC_BB_PD`) already landed
- The 9/11/13 mA targets in `staged-prompts/07_firmware_config_power.md` are unreachable on this hardware regardless of architecture (phones force tight BLE conn intervals); revise the targets

Path B = strip ESP-NOW from the earclip, convert the glasses to BLE central role, both glasses + dashboard connect simultaneously to the earclip as BLE peripherals. **All three components ship together in this change.** No multi-week external dependency.

## 1. Required reading before you start

1. **`EDGE/EDGE FIRMWARE/main_v4_14_38 (1).c`** — full file. Understand:
   - Existing BLE stack (NimBLE? Bluedroid? from boot logs in CLAUDE.md it's Bluedroid)
   - Existing peripheral role used for phone OTA / config
   - Hall sensor input flow (used for user input on the glasses)
   - Main loop / task structure
   - NVS usage
   - Where to add a BLE central instance alongside the existing peripheral instance (or whether the glasses chip supports that — Bluedroid does, NimBLE does, just need to verify build config)
2. **`firmware/main/transport_ble.c`** — earclip's existing single-central BLE peripheral. The multi-central refactor lands here.
3. **`firmware/main/ble_service_narbis.c`** — earclip's custom GATT service. New CHR_PEER_ROLE characteristic added here.
4. **`dashboard/`** (skim) — find where `navigator.bluetooth.requestDevice` is called, that's the pairing entry point.

Don't write any code until you've read these. The brief below assumes you understand the existing architecture.

## 2. Pairing flow across all three components

**Independent pairing on each central** — no cross-component coordination protocol. Each central separately picks an earclip and remembers it. Earclip accepts up to 2 simultaneous connections.

```
        Earclip (BLE peripheral, advertises NARBIS_SVC_UUID)
       /                        \
     /                            \
Dashboard (BLE central #1)    Glasses (BLE central #2)
- scans via Web Bluetooth     - scans via NimBLE/Bluedroid central API
- user picks from list        - user picks via glasses UI (hall sensor menu?)
- saves device.id in          - saves earclip BLE MAC in NVS
  localStorage
- auto-reconnects on reload   - auto-reconnects on boot
- writes "I am dashboard"     - writes "I am glasses" to
  to CHR_PEER_ROLE             CHR_PEER_ROLE on connect
```

The earclip sees both, knows their roles via CHR_PEER_ROLE, applies the right BLE profile to each (dashboard gets LOW_LATENCY for live raw view; glasses gets BATCHED for power), and notifies both with each beat.

**Pairing UX detail to figure out per component:**
- Dashboard: existing `requestDevice()` UI is fine. Just persist `device.id` to localStorage so the second load auto-matches.
- Glasses: needs a "Pair with earclip" entry in their existing UI. Look for the input/menu pattern they already use (hall sensor presses?) and add a new option that triggers a 30-second BLE scan and lets the user select. Confirmed selection writes the chosen earclip's MAC to NVS.

## 3. Earclip firmware changes — `firmware/`

### 3a. Strip ESP-NOW

| File | Action |
|---|---|
| `firmware/main/transport_espnow.c`, `transport_espnow.h` | **Delete** |
| `firmware/main/auto_pair.c`, `auto_pair.h` | **Delete** |
| `firmware/main/main.c` | Remove `#include "transport_espnow.h"`, `#include "auto_pair.h"`. Delete `transport_espnow_init()`, `boot_log_macs()`, `auto_pair_init()` calls. Inside `on_beat()`: delete `transport_espnow_send_beat(e)`. Delete `#if CONFIG_NARBIS_ESPNOW_BURST_MODE` and `#if CONFIG_NARBIS_DISABLE_ESPNOW` gates. Keep `#if CONFIG_NARBIS_DISABLE_BLE`. |
| `firmware/main/power_mgmt.c::emit_battery_frames` | Delete `transport_espnow_send_battery(...)` call. Keep BLE + Narbis service push. |
| `firmware/main/config_manager.c` | Delete `apply_partner_mac()` and `config_apply_partner_mac()`. Inside `apply_transport()`: delete partner_mac handling block. Keep `config_get_partner_mac` / `config_set_partner_mac` / `config_clear_pairing` for NVS read-side migration (don't break old devices; just stop writing). |
| `firmware/main/ble_service_narbis.c` | Delete `CHR_PAIR_UUID`, `CHR_PAIR_UUID_BYTES`, `access_pair()`, and the corresponding GATT chr-table row. In `access_factory_reset`, replace `config_clear_pairing()` with `config_factory_reset()`. |
| `firmware/main/CMakeLists.txt` | From SRCS: remove `transport_espnow.c`, `auto_pair.c`. From REQUIRES: remove `esp_wifi`, `esp_netif`, `esp_event`, `esp_coex`. |
| `firmware/sdkconfig.defaults` | Delete the Wi-Fi/coex block (4 lines). |
| `firmware/main/Kconfig.projbuild` | Delete: `NARBIS_HARDCODED_PARTNER_MAC`, `NARBIS_HARDCODED_PARTNER_MAC_VAL`, `NARBIS_ESPNOW_CHANNEL`, `NARBIS_ESPNOW_BURST_MODE`, `NARBIS_DISABLE_ESPNOW`. |

### 3b. Multi-central BLE support

| File | Action |
|---|---|
| `firmware/sdkconfig.defaults` | Add `CONFIG_BT_NIMBLE_MAX_CONNECTIONS=3` (host) **and** `CONFIG_BT_LE_MAX_CONNECTIONS=3` (controller). Both required — host alone is a footgun. |
| `firmware/main/transport_ble.c` | Replace single `g_conn_handle` with array `g_conn_handles[CONFIG_BT_NIMBLE_MAX_CONNECTIONS]`. Promote `g_subscribed[BLE_SUB_COUNT]` to `g_subscribed[CONN][BLE_SUB_COUNT]`. Add `g_peer_role[CONN]` (uint8_t: 0=unknown, 1=dashboard, 2=glasses). |
| `firmware/main/transport_ble.c::gap_event_handler` | On `BLE_GAP_EVENT_CONNECT`: find first free slot, store handle, init role=unknown. On `BLE_GAP_EVENT_DISCONNECT`: clear that slot, restart advertising. Always advertise if at least one slot free. |
| `firmware/main/transport_ble.c::transport_ble_notify` | Iterate active connections; notify each subscribed peer. Skip peers that aren't subscribed to the given chr. |
| `firmware/main/transport_ble.c::transport_ble_set_profile` | Becomes per-role: takes a role + profile. Iterates active connections, applies to matching ones. |
| `firmware/main/transport_ble.c::start_advertising` | Restart advertising whenever a slot becomes free. Stop only when all slots are full. |
| `firmware/main/transport_ble.c::transport_ble_get_conn_handle` / `is_subscribed` | Update semantics: "any connection?" / "any peer subscribed?". Used by power_mgmt diagnostics and diagnostics drain task. |

### 3c. New CHR_PEER_ROLE characteristic

| File | Action |
|---|---|
| `protocol/narbis_protocol.h`, `.ts` | Generate a new UUID for `NARBIS_CHR_PEER_ROLE_UUID`. Use `protocol/generate_uuids.py` if it exists, else hand-pick a UUID. Define enum `narbis_peer_role_t` { NARBIS_PEER_ROLE_UNKNOWN=0, NARBIS_PEER_ROLE_DASHBOARD=1, NARBIS_PEER_ROLE_GLASSES=2 }. |
| `firmware/main/ble_service_narbis.c` | Add CHR_PEER_ROLE_UUID. New access callback `access_peer_role` accepts a 1-byte write from the central, validates 0–2, stores into `g_peer_role[conn]` via a new `transport_ble_set_peer_role(conn_handle, role)` helper. On role-set, call `transport_ble_apply_role_profile(role)` to apply the right BLE conn params (dashboard → LOW_LATENCY, glasses → BATCHED). |
| Add to GATT chr table | `BLE_GATT_CHR_F_WRITE` for the new char. |

### 3d. Protocol bump

| File | Action |
|---|---|
| `protocol/narbis_protocol.h` | In `narbis_runtime_config_t`: rename `partner_mac[6]` → `reserved_legacy_partner_mac[6]`, `espnow_channel` → `reserved_legacy_espnow_channel`. Bump default `config_version` to `3`. From `narbis_transport_mode_t`: delete `NARBIS_TRANSPORT_EDGE_ONLY`. Add `NARBIS_CHR_PEER_ROLE_UUID` constants. Add `narbis_peer_role_t` enum. |
| `protocol/narbis_protocol.ts` | Mirror exactly. |
| `protocol/test/roundtrip.{c,ts}` | Update `config_version=3`, renamed fields. Both must pass before continuing. |
| `firmware/main/config_manager.c::load_default_config` | `c->config_version = 3`. Stop populating partner_mac, espnow_channel. |
| `firmware/main/config_manager.c::config_manager_init` | Tighten check to `loaded.config_version >= 3`. Older blobs harmlessly fall back to defaults. |

### 3e. Cleanup and renames

| File | Action |
|---|---|
| `firmware/main/app_state.{c,h}` | Delete `APP_STATE_EDGE_ONLY` enum value. State machine: BOOT → IDLE → STREAMING → OTA_UPDATING. |
| `CLAUDE.md` | Architecture section: replace dual-radio description with "BLE peripheral. Dashboard and Edge glasses both connect simultaneously as BLE centrals." Drop ESP-NOW arrow from any diagram. Drop transport_mode 3-axis description. |
| `TODO.md` | Remove ESP-NOW pairing entries. |
| `staged-prompts/05_firmware_espnow.md` | Add deprecated banner at top: "Path B (BLE-only) chosen YYYY-MM-DD; preserved for history, not on critical path." |
| `staged-prompts/07_firmware_config_power.md` | Update validation targets: "Idle no central: ≤35 mA. Dashboard connected: ≤35 mA (phone-forced 15 ms interval) or ≤25 mA (BATCHED honored). Both centrals connected: ≤45 mA." Note original 9/11/13 mA targets were based on pre-measurement assumptions that didn't hold. |
| `firmware/edge-additions/narbis_esp_now_rx/` | Delete the directory. Glasses no longer use ESP-NOW receive. |

## 4. Edge glasses firmware changes — `EDGE/EDGE FIRMWARE/`

**Read `main_v4_14_38 (1).c` first.** Identify:
- The BLE host stack in use (Bluedroid expected based on prior CLAUDE.md notes)
- Existing peripheral-role characteristics (likely OTA + control)
- Whether the chip supports concurrent peripheral + central role (Bluedroid yes; check sdkconfig)
- Hall sensor input handler — that's the user-input mechanism for any new pairing UI
- NVS namespace conventions

### 4a. Add BLE central role module

Create a new module (or inline in `main.c`, depending on existing structure):

- **Scanner**: scan for devices advertising `NARBIS_SVC_UUID`. Filter by service UUID. Report results to a callback that displays them in the existing glasses UI.
- **Connect**: directed connect to the user-selected earclip MAC.
- **GATT discovery**: discover `NARBIS_SVC_UUID` and find handles for `NARBIS_CHR_IBI_UUID` (and optionally `NARBIS_CHR_BATTERY_UUID`, `NARBIS_CHR_CONFIG_UUID`).
- **Subscribe** to IBI characteristic (write CCCD = 0x0001). On notification, parse `narbis_ibi_payload_t` (4 bytes: ibi_ms u16, confidence u8, flags u8) — same struct as on the wire today over ESP-NOW, just delivered via BLE now.
- **Write `NARBIS_CHR_PEER_ROLE_UUID`** with value `2` (NARBIS_PEER_ROLE_GLASSES) immediately after MTU exchange. This tells the earclip to apply the BATCHED profile to this connection.
- **Don't subscribe to RAW_PPG** — it's a power hog and the glasses don't need raw samples.
- **Auto-reconnect on disconnect**: directed scan with 5 s window; if found, reconnect. If not found in 5 s, sleep and retry every 30 s. Don't spin-poll.

### 4b. Pairing UI

Use the existing input mechanism (hall sensor presses, button, whatever the glasses have). Add a "Pair earclip" entry to whatever menu exists.

When triggered:
1. Start a 30-second scan for `NARBIS_SVC_UUID` advertisements
2. Display each found device's name (`Narbis Earclip XXXXXX`) + RSSI
3. User picks one via the input mechanism
4. Persist the chosen earclip's BLE MAC to NVS (key: `narbis_earclip_mac`)
5. Initiate first connection

On boot, read `narbis_earclip_mac` from NVS. If present, do a directed scan and connect. If absent, do nothing (user hasn't paired yet — they get to it via the menu).

### 4c. Strip ESP-NOW receive code

The glasses currently have an `narbis_esp_now_rx` handler in `firmware/edge-additions/narbis_esp_now_rx/` that gets copy-pasted into the glasses build. After Path B, delete or comment-out the equivalent code in `main_v4_14_38 (1).c` and remove the include/call from the glasses' main loop. Replace any "process incoming IBI from ESP-NOW" with "process incoming IBI from BLE central GATT notification" — same payload structure, different transport.

### 4d. NVS / state cleanup

- Delete the legacy ESP-NOW partner-MAC NVS entries on the glasses if any exist (it's the receiver, so probably none — but check).
- Add the new `narbis_earclip_mac` key.

### 4e. Optional but recommended

- **Show paired earclip name in glasses status display.** Small UX win.
- **"Forget paired earclip" menu option.** Wipes NVS, returns to unpaired state.
- **Battery passthrough**: if the earclip notifies `NARBIS_CHR_BATTERY_UUID`, display the earclip's battery level on the glasses too.

## 5. Dashboard changes — `dashboard/`

### 5a. Pairing persistence

| File | Action |
|---|---|
| `dashboard/src/lib/ble.ts` (or wherever `requestDevice` is) | On first connect: save `device.id` to `localStorage.narbisPairedDeviceId` and `device.name` to `localStorage.narbisPairedDeviceName`. On subsequent loads: still call `requestDevice({filters:[{services:[NARBIS_SVC_UUID]}]})` — Chrome auto-matches the previously-accepted device by id without re-prompting. |
| `dashboard/src/components/Settings.tsx` (or equivalent) | Add a "Forget paired earclip" button that clears the localStorage keys. Show currently-paired device name. |

### 5b. Peer role announcement

| File | Action |
|---|---|
| `dashboard/src/lib/ble.ts` | After successful connect + GATT discovery, write `0x01` (NARBIS_PEER_ROLE_DASHBOARD) to the new `NARBIS_CHR_PEER_ROLE_UUID` characteristic. This tells the earclip to apply the LOW_LATENCY profile (which the dashboard wants for raw-PPG live view). |

### 5c. Two-central handling

The earclip now allows two centrals (dashboard + glasses) simultaneously. The dashboard doesn't need to do anything special here — it just connects normally. If the connection fails because both slots are full, surface a useful error ("earclip is paired with another device — disconnect glasses or wait").

## 6. Verification

1. **Roundtrip tests pass.**
   ```
   cd protocol/test
   make test
   npx tsx roundtrip.ts
   ```
   Both green, `config_version=3`, new `narbis_peer_role_t` exercised.

2. **Earclip build clean.**
   ```
   cd firmware
   idf.py fullclean && idf.py build
   ```

3. **Earclip greps return empty.**
   ```
   grep -rn "transport_espnow|auto_pair|esp_wifi|ESPNOW" firmware/main/
   ```

4. **Glasses build clean.**
   Build the glasses firmware per its existing build process. No ESP-NOW code paths, new BLE central code links cleanly.

5. **Earclip flash + monitor.** Confirm boot log:
   - **Absent:** `wifi:`, `ESPNOW:`, `transport_espnow:`, `auto_pair:` lines.
   - **Present:** `transport_ble: advertising`, `BLE PM is enabled`.
   - `pm_dump_locks` at boot+5s: no `wifi APB_FREQ_MAX` lock at all. `bt CPU_FREQ_MAX` Active=0 with low Time(%).
   - `Mode stats` shows real time at `APB_MIN 40 M` (was 0% before; this is the smoking-gun indicator that light sleep is engaging).

6. **Functional: dashboard alone.**
   Pair via dashboard. Confirm IBI notifications arrive, RAW_PPG arrives if subscribed, BLE conn params are LOW_LATENCY. Disconnect, reload page, confirm auto-reconnect.

7. **Functional: glasses alone.**
   Pair via glasses UI. Confirm IBI notifications arrive on glasses, displayed correctly. Reboot earclip, confirm glasses auto-reconnect within 30 s.

8. **Functional: both connected simultaneously.**
   Pair both. Both should show live IBI stream. Earclip's `pm_dump_locks` should still show light-sleep engagement even with two connections (less than with one, but >0%).

9. **PPK2 measurements** — capture five:
   - Idle, no central: ≤ 35 mA (target 25–35).
   - Dashboard only, LOW_LATENCY profile honored: ≤ 35 mA.
   - Glasses only, BATCHED profile: ≤ 25 mA (target 15–25).
   - Both connected: ≤ 45 mA.
   - Battery life calculation: at the dashboard-only number, on a 100 mAh LiPo, lifetime in hours.

10. **NVS migration**: flash a previously-paired (Wi-Fi era) earclip with the new firmware. Should boot cleanly, ignore the legacy partner_mac NVS blob, advertise normally.

## 7. Order of execution

Recommended PR layout:

1. **PR #1 — protocol bump.** Update `narbis_protocol.{h,ts}`, roundtrip tests, new UUID + enum. Doesn't touch any firmware logic. Easy review.
2. **PR #2 — earclip: strip ESP-NOW + multi-central + CHR_PEER_ROLE.** All earclip-side changes (sections 3a–3e). Land with a stub test where the dashboard connects and writes role = DASHBOARD. Verify multi-central works by connecting two browser tabs simultaneously and confirming both get notifications.
3. **PR #3 — glasses: BLE central role.** All glasses-side changes (section 4). Land paired with PR #2 — they're tested together end-to-end.
4. **PR #4 — dashboard: pairing persistence + role write.** Small. Section 5.
5. **PR #5 — docs + cleanup.** CLAUDE.md, TODO.md, staged-prompts updates. Delete `firmware/edge-additions/narbis_esp_now_rx/`.

PRs #2 and #3 can land in either order or together; #4 and #5 are independent. PR #1 is a hard prerequisite for #2 and #3.

## 8. What NOT to do

- ❌ **Encryption / bonding** — defer. Threat model doesn't require it for v1.
- ❌ **Per-connection stream filtering beyond LOW_LATENCY/BATCHED** — keep it simple. Both peers get IBI notifications; dashboard additionally subscribes to RAW_PPG by user choice; glasses doesn't.
- ❌ **Removing legacy NVS keys** — read-side compat only. Don't break existing devices on upgrade.
- ❌ **Refactoring the earclip's runtime config struct beyond the ESP-NOW field renames** — keep it stable.
- ❌ **Adding a third central** — `MAX_CONNECTIONS=3` in the brief is for future-proofing (e.g., a debug client) but the spec is two: dashboard + glasses.

## 9. Done criteria

- All §6 verification steps pass.
- Five PPK2 numbers in PR #5's description.
- No `wifi:`, `ESPNOW:`, `auto_pair:` lines in earclip boot log.
- No ESP-NOW code paths in glasses firmware.
- `protocol/test` both halves pass with `config_version=3` and new peer-role enum.
- `git grep transport_espnow` and `git grep auto_pair` both return zero hits across the whole repo.
- Glasses + dashboard can be paired simultaneously and both receive live IBI streams from the earclip.

If any of the PPK2 numbers come in significantly above the targets, raise it as a finding in the PR — likely root cause is conn interval the central negotiated. Document in TODO if the dashboard / glasses centrals can't be persuaded to honor the peripheral's BATCHED request.
