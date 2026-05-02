# Path B Relay — Handoff to next agent

**Goal:** make the dashboard fully usable when its only BLE connection is to the
glasses, so all earclip data (IBI, FW summary, battery, config, optionally
raw PPG) reaches the dashboard via the glasses, AND config writes from the
dashboard reach the earclip via the glasses.

End-state architecture:
```
                 ┌─────────────────────────────────────────┐
earclip ──BLE──> │    glasses (Bluedroid: peripheral +     │ ──BLE──> dashboard
        IBI      │              central)                   │   0xFF03 status
        Battery  │                                         │   0xF1 = log line (ASCII)
        Config   │  central subscribes → text/binary       │   0xF4 = config blob (NEW)
        RAW (*)  │  forwarders → 0xFF03 notify frames      │   0xF5 = raw PPG batch (NEW, *)
                 └─────────────────────────────────────────┘
                                        ↑
        dashboard ──BLE──> glasses ──BLE──> earclip
                            0xFF01 ctrl write    GATTC write_char
                            0xC3 = config blob   to NARBIS_CHR_CONFIG_WRITE
                            0xC4 = raw on/off

(*) raw streaming is opt-in via 0xC4 to save power/bandwidth when not needed.
```

The user runs an app+glasses-only flow ideally. Direct dashboard↔earclip is
optional / for debug.

---

## Repos and paths you will touch

Two repos, two clones — both must be edited.

**Earclip-side repo** (this one, the source-of-truth working repo):
```
C:\CODE\EDGE EAR CLIP\REPO\edge-earclip
├── EDGE\EDGE FIRMWARE\                      # glasses firmware mirror (this repo's view)
│   ├── components\narbis_ble_central\
│   │   ├── include\narbis_ble_central.h     # ← extend public API
│   │   └── narbis_ble_central.c             # ← extend state machine + add forwarders
│   └── main\main.c                           # ← register cbs, emit 0xF4/F5, add 0xC3/C4
└── dashboard\src\
    ├── ble\edgeDevice.ts                     # ← parse 0xF4/F5, add forwardConfigWrite, setRawRelay
    ├── ble\narbisDevice.ts                   # ← writeConfig should fall back to glasses route
    ├── state\store.ts                        # ← listen for relayedConfig / relayedRaw events
    └── components\EdgeControls.tsx           # ← add "Stream Raw PPG via glasses" toggle
```

**User's glasses-firmware clone** (the separate repo, where the build happens
and they push to GitHub):
```
C:\NARBIS APP\Oct_4_25\Clone\edge-firmware\v4\Code-Glasses\
├── components\narbis_ble_central\           # mirror this from the source-of-truth repo
└── main\main.c                               # mirror this
```

**Sync rule:** every change to `EDGE\EDGE FIRMWARE\components\narbis_ble_central\*`
or `EDGE\EDGE FIRMWARE\main\main.c` in the source repo MUST be `cp`'d to the
clone immediately. The user pushes from the clone to `narbiscorp/edge-firmware`
on GitHub. They run `idf.py build && idf.py -p COM_X flash monitor` from
`C:\NARBIS APP\Oct_4_25\Clone\edge-firmware\v4\Code-Glasses\`.

---

## What's already done (do not redo)

✅ **PR #1 — protocol bump.** `narbis_protocol.{h,c,ts}` updated to
config_version=3 (transport_mode/partner_mac/espnow_channel removed),
NARBIS_CHR_PEER_ROLE_UUID added, narbis_peer_role_t enum added. Committed.

✅ **PR #2a/2b — earclip firmware.** ESP-NOW stripped, multi-central BLE
peripheral supports up to 3 simultaneous centrals, CHR_PEER_ROLE write
applies LOW_LATENCY (DASHBOARD) or BATCHED (GLASSES) conn-update profile.

✅ **PR #3 — glasses central.** `narbis_ble_central` Bluedroid GATTC
component scans for and connects to a Narbis Earclip, writes
peer-role=GLASSES, subscribes to **IBI + BATTERY only** (CONFIG not yet
subscribed — that's the work to do here). State callback fires on
ST_READY (`narbis_central_set_state_cb`) and on disconnect; main.c handler
flips PPG to program 1 + disables ADC + does 5 slow lens pulses on
connect, restores on disconnect. ble_log bridge already routes the
central's scan/connect/subscribe lines into 0xFF03 frame type 0xF1 so
they show in the dashboard's BLE event log.

✅ **PR #4 — dashboard pairing.** `dashboard/src/ble/edgeDevice.ts` connects to
glasses by name `Narbis_Edge` (exact match — this is critical, not a
prefix). Decodes 0xF0 (ADC stats), 0xF1 (firmware log line), 0xF2 (HRV),
0xF3 (health). PairingAssistant component shows live pair status.
EdgeControls panel exposes the existing v13.27 control opcodes
(0xA2/A5/A6/B0/B1/B2/B6/**B7 sends p-1**, B8/B9/AB/AC/BF/C0/C1/D0).
Critical fix already in: `sendCtrlCommand` always pads to ≥ 2 bytes
because firmware `main.c::process_command` does `if (len < 2) return;`.

✅ **Relay (partial)** — IBI and Battery already relay. Glasses' main.c
`on_earclip_ibi` / `on_earclip_battery` callbacks `ble_log()` text lines
("earclip ibi=850 conf=100 flags=0x00", "earclip batt soc=72% mv=3850
chg=1") that the dashboard parses with regex (in
`edgeDevice.ts::parseRelayedIbi` / `parseRelayedBattery`) into
`NarbisBeatEvent` and feeds into `liveBuffers.narbisBeats`. The relay is
**suppressed** when the dashboard is also directly connected to the
earclip (`isEarclipDirect()` check in store.ts) to avoid double-counting.

✅ **Scan diagnostics** — added on the very last firmware edit before this
handoff. `narbis_ble_central.c` now logs `central: scan done, N adv
seen, M matched narbis` at the end of each scan window, plus `central:
matched narbis adv XX:XX:... rssi=N` on the first match per window. This
is in `narbis_ble_central.c` already, mirrored to clone. **Has not been
flashed yet** as of this handoff. Next time the user flashes, we'll have
hard data on whether the glasses see the earclip's adverts.

---

## What still needs to be built (your task)

### Phase 1 — Config relay (read + write)

#### 1.1 Firmware: extend `narbis_ble_central`

**File:** `EDGE/EDGE FIRMWARE/components/narbis_ble_central/include/narbis_ble_central.h`

Add to the public API:
```c
/** Fires when the earclip notifies on its CONFIG characteristic. The
 * payload is the serialized narbis_runtime_config_t (50 bytes including
 * the trailing CRC16 — i.e. NARBIS_CONFIG_WIRE_SIZE). The caller does
 * NOT need to validate CRC; do that on the consumer side. */
typedef void (*narbis_central_config_cb_t)(const uint8_t *bytes, uint16_t len);
void narbis_central_set_config_cb(narbis_central_config_cb_t cb);

/** Fires when the earclip notifies on its RAW_PPG characteristic. Payload
 * is the wire format: u16 sample_rate_hz, u16 n_samples, n × (u32 red, u32 ir).
 * Up to 4 + 29*8 = 236 bytes per notify. RAW subscription is opt-in via
 * narbis_central_set_raw_enabled(true) — by default raw is NOT subscribed
 * so air time and glasses' RAM aren't burned. */
typedef void (*narbis_central_raw_cb_t)(const uint8_t *bytes, uint16_t len);
void narbis_central_set_raw_cb(narbis_central_raw_cb_t cb);

/** Toggle whether the central subscribes to the earclip's RAW_PPG char.
 * - If currently connected:
 *   - true: write CCCD = 0x0001 to enable notify
 *   - false: write CCCD = 0x0000 to disable
 * - If not connected: latches state for next connect.
 * Returns ESP_OK on dispatch, ESP_ERR_INVALID_STATE if no GATTC if. */
esp_err_t narbis_central_set_raw_enabled(bool enabled);

/** Forward a config write to the earclip via GATTC. The dashboard sends
 * the config blob (NARBIS_CONFIG_WIRE_SIZE bytes) to the glasses CTRL
 * char with opcode 0xC3; main.c's CTRL handler calls this function with
 * the payload. Returns ESP_ERR_INVALID_STATE if not connected to earclip
 * or no CONFIG_WRITE handle cached. Async: result reported via the
 * existing ble_log path ("central: config write rc=N"). */
esp_err_t narbis_central_write_earclip_config(const uint8_t *bytes, size_t len);
```

**File:** `EDGE/EDGE FIRMWARE/components/narbis_ble_central/narbis_ble_central.c`

Internal state additions:
```c
static struct {
    ...existing fields...
    narbis_central_config_cb_t  config_cb;
    narbis_central_raw_cb_t     raw_cb;
    bool                        raw_enabled;        /* user toggle */

    /* Cached handles after discovery. */
    uint16_t hdl_config;
    uint16_t hdl_config_cccd;
    uint16_t hdl_config_write;     /* CONFIG_WRITE char value handle */
    uint16_t hdl_raw;
    uint16_t hdl_raw_cccd;
} S;
```

Things to update:

a. **`cache_handles_after_discover()`** — also walk attrs for these UUIDs:
   - `NARBIS_CHR_CONFIG_UUID_BYTES` → `hdl_config`, descriptor → `hdl_config_cccd`
   - `NARBIS_CHR_CONFIG_WRITE_UUID_BYTES` → `hdl_config_write` (NO cccd, write-only char)
   - `NARBIS_CHR_RAW_PPG_UUID_BYTES` → `hdl_raw`, descriptor → `hdl_raw_cccd`

b. **State machine extension.** Currently:
   `ST_WRITING_ROLE → ST_SUBSCRIBING_IBI → (ST_SUBSCRIBING_BATT) → ST_READY`
   Becomes:
   `ST_WRITING_ROLE → ST_SUBSCRIBING_IBI → ST_SUBSCRIBING_CONFIG → (ST_SUBSCRIBING_BATT) → (ST_SUBSCRIBING_RAW if raw_enabled) → ST_READY`
   Each transition triggers `cccd_subscribe(S.hdl_X_cccd)` and waits for
   `ESP_GATTC_WRITE_DESCR_EVT`. Skip cleanly if a handle is 0 (older
   earclip firmware that doesn't have the characteristic).

c. **`ESP_GATTC_NOTIFY_EVT` handler** — already routes IBI and BATTERY by
   handle. Add cases for `S.hdl_config` (call `S.config_cb`) and
   `S.hdl_raw` (call `S.raw_cb`).

d. **`narbis_central_write_earclip_config(bytes, len)`** — implement:
   ```c
   if (S.state != ST_READY || S.hdl_config_write == 0) return ESP_ERR_INVALID_STATE;
   esp_err_t err = esp_ble_gattc_write_char(
       S.gattc_if, S.conn_id, S.hdl_config_write,
       len, (uint8_t*)bytes,
       ESP_GATT_WRITE_TYPE_RSP, ESP_GATT_AUTH_REQ_NONE);
   cb_log("central: config write rc=%d", err);
   return err;
   ```
   Note: there's already a write-char path used for peer-role write; you
   can model after that. The earclip's `WRITE_CHAR_EVT` will arrive — at
   that point we're in ST_READY, so just log success/failure and don't
   change state.

e. **`narbis_central_set_raw_enabled(bool)`** — implement:
   ```c
   S.raw_enabled = enabled;
   if (S.state != ST_READY || S.hdl_raw_cccd == 0) return ESP_OK;  /* latch only */
   uint8_t cccd[2] = { enabled ? 0x01 : 0x00, 0x00 };
   esp_err_t err = esp_ble_gattc_write_char_descr(
       S.gattc_if, S.conn_id, S.hdl_raw_cccd,
       sizeof(cccd), cccd,
       ESP_GATT_WRITE_TYPE_RSP, ESP_GATT_AUTH_REQ_NONE);
   cb_log("central: raw subscribe %s rc=%d", enabled ? "on" : "off", err);
   return err;
   ```

#### 1.2 Firmware: glasses `main.c`

Search for the existing `on_earclip_ibi` and `on_earclip_battery` callbacks.
Add two new callbacks alongside them:

```c
/* Send a binary frame on 0xFF03 status char. type byte is followed by the
 * payload bytes. We need this for 0xF4 (config) and 0xF5 (raw) since the
 * existing ble_log() formats ASCII only. The framing matches the v13.27
 * status-char protocol (type byte + payload) — dashboard's edgeDevice.ts
 * already dispatches by type. */
static void send_status_frame(uint8_t type, const uint8_t *payload, size_t len) {
    if (s_h_stat == 0) return;                   /* status char not registered yet */
    if (len > 240) return;                        /* MTU safety cap */
    uint8_t pkt[256];
    pkt[0] = type;
    if (len > 0 && payload) memcpy(pkt + 1, payload, len);
    /* Notify on the status char to whoever's connected (dashboard). The
     * existing ble_log() does the same notify pattern; copy it here. */
    /* TODO(handoff): factor the notify path out of ble_log so we don't
     *   duplicate the GATTS notify call. Look for ble_gatts_notify or
     *   esp_ble_gatts_send_indicate in main.c. */
    ...do the notify...
}

static void on_earclip_config(const uint8_t *bytes, uint16_t len) {
    /* len should be NARBIS_CONFIG_WIRE_SIZE = 50. Pass through verbatim
     * as a 0xF4 frame; dashboard parses with deserializeConfig. */
    send_status_frame(0xF4, bytes, len);
}

static void on_earclip_raw(const uint8_t *bytes, uint16_t len) {
    /* RAW_PPG payload: 4 + n_samples*8 bytes. Pass through as 0xF5. */
    send_status_frame(0xF5, bytes, len);
}
```

In `app_main` after `narbis_central_init`, register them:
```c
narbis_central_set_config_cb(on_earclip_config);
narbis_central_set_raw_cb(on_earclip_raw);
```

In the existing `process_command(uint8_t *data, uint16_t len)` switch-case
(grep for `case 0xC1:`), add two new opcodes:

```c
case 0xC3: {  /* Forward a config write to the earclip.
               * Payload: NARBIS_CONFIG_WIRE_SIZE (50) bytes.
               * Dashboard sends the same blob it would write to
               * NARBIS_CHR_CONFIG_WRITE if directly connected. */
    if (len < 2 + 50) {
        ble_log("0xC3 len %d (need >=52)", len);
        break;
    }
    esp_err_t err = narbis_central_write_earclip_config(&data[2], 50);
    if (err != ESP_OK) ble_log("0xC3 forward rc=%d", err);
    /* If err==ESP_OK, central will log "central: config write rc=0"
     * once the GATTC write completes; dashboard polls or waits for the
     * 0xF4 echo (earclip notifies CONFIG after applying the write). */
    break;
}

case 0xC4: {  /* Toggle raw-PPG relay on/off. arg = 0 disable, 1 enable. */
    bool on = data[1] != 0;
    esp_err_t err = narbis_central_set_raw_enabled(on);
    ble_log("0xC4 raw=%d rc=%d", on ? 1 : 0, err);
    break;
}
```

#### 1.3 Dashboard: parse new frames + new control APIs

**File:** `dashboard/src/ble/edgeDevice.ts`

Add to `decodeStatusFrame(bytes, dv)`:
```ts
if (type === 0xF4 && bytes.length >= NARBIS_CONFIG_WIRE_SIZE + 1) {
  // Config blob — let the caller deserialize via deserializeConfig.
  // Just summarize for the log: byte count + first 8 hex bytes.
  return {
    kind: 'unknown',
    summary: `config (${bytes.length - 1} B): ${bytesToHex(bytes.slice(1, 9))}…`,
  };
}
if (type === 0xF5 && bytes.length >= 5) {
  const sr = dv.getUint16(1, true);
  const n = dv.getUint16(3, true);
  return {
    kind: 'unknown',
    summary: `raw_ppg ${n} samples @${sr}Hz`,
  };
}
```

Better: add new event types so the store can distinguish:
```ts
export interface RelayedConfig {
  timestamp: number;
  bytes: Uint8Array;   /* the 50-byte payload (without the 0xF4 prefix) */
}
export interface RelayedRawPpg {
  timestamp: number;
  bytes: Uint8Array;   /* the variable-length payload (without 0xF5 prefix) */
}
```

In the `onStatusNotify` handler, after `decodeStatusFrame`, check the type:
```ts
if (type === 0xF4 && bytes.length > 1) {
  this.dispatch('relayedConfig', {
    timestamp: ts,
    bytes: bytes.slice(1),
  } as RelayedConfig);
}
if (type === 0xF5 && bytes.length > 1) {
  this.dispatch('relayedRawPpg', {
    timestamp: ts,
    bytes: bytes.slice(1),
  } as RelayedRawPpg);
}
```

Add public methods on `EdgeDevice`:
```ts
/** Forward a config blob to the earclip via the glasses. The blob is
 * the same 50-byte serialized narbis_runtime_config_t the dashboard
 * would write directly. Glasses firmware opcode 0xC3. */
async forwardEarclipConfigWrite(configBytes: Uint8Array): Promise<void> {
  if (configBytes.length !== NARBIS_CONFIG_WIRE_SIZE) {
    throw new Error(`config blob must be ${NARBIS_CONFIG_WIRE_SIZE} bytes`);
  }
  await this.sendCtrlCommand(0xC3, configBytes);
}

/** Toggle whether the glasses subscribe to the earclip's RAW_PPG and
 * forward it to the dashboard as 0xF5 frames. Default: disabled. */
async setRawRelayEnabled(enabled: boolean): Promise<void> {
  await this.sendCtrlCommand(0xC4, new Uint8Array([enabled ? 1 : 0]));
}
```

Import `NARBIS_CONFIG_WIRE_SIZE` from `protocol/narbis_protocol.ts`.

**File:** `dashboard/src/state/store.ts`

Listen for the new events:
```ts
edgeDevice.addEventListener('relayedConfig', (e) => {
  if (isEarclipDirect()) return;
  const r = (e as CustomEvent<RelayedConfig>).detail;
  try {
    const cfg = deserializeConfig(r.bytes);    /* import from narbis/parsers */
    setState({ config: cfg });
    appendBleLog('earclip', 'rx', `config v${cfg.config_version} (relay)`);
  } catch (err) {
    appendBleLog('earclip', 'error', `config parse: ${(err as Error).message}`);
  }
});

edgeDevice.addEventListener('relayedRawPpg', (e) => {
  if (isEarclipDirect()) return;
  const r = (e as CustomEvent<RelayedRawPpg>).detail;
  /* parse same way as direct path. The existing rawSampleReceived path
   * gives you a template — you'll basically do parseRawPPG on r.bytes,
   * then run the existing jitter-smoother feed. */
  try {
    const dv = new DataView(r.bytes.buffer, r.bytes.byteOffset, r.bytes.byteLength);
    const sr = dv.getUint16(0, true);
    const n  = dv.getUint16(2, true);
    /* construct NarbisRawSampleEvent and reuse the existing
     * processRawBatch() function. The function lives in store.ts already. */
    ...
  } catch (err) {
    appendBleLog('earclip', 'error', `raw parse: ${(err as Error).message}`);
  }
});
```

**File:** `dashboard/src/ble/narbisDevice.ts`

`writeConfig()` currently throws if `chConfigWrite` is null. Change so that
when not directly connected, it falls back through the glasses:
```ts
async writeConfig(cfg: NarbisRuntimeConfig): Promise<void> {
  const blob = serializeConfig(cfg);
  if (this.chConfigWrite) {
    /* direct path */
    await this.chConfigWrite.writeValueWithResponse(toBufferSource(blob));
    return;
  }
  /* fallback via glasses, if connected */
  if (edgeDevice.isConnected) {
    await edgeDevice.forwardEarclipConfigWrite(blob);
    return;
  }
  throw new Error('not connected to earclip (direct or via glasses)');
}
```

(Will need an import: `import { edgeDevice } from './edgeDevice';`. Watch
for circular import — if edgeDevice imports narbisDevice, refactor the
shared bit into a separate module or pass via callback.)

**File:** `dashboard/src/components/EdgeControls.tsx`

Add a toggle in the existing controls panel:
```tsx
<Section
  label="Stream Raw PPG via glasses (0xC4)"
  hint="Glasses subscribe to the earclip's raw 50/100/200/400 Hz PPG and forward each batch as a 0xF5 frame. Adds significant BLE air-time. Off by default."
>
  <Toggle
    checked={rawRelay}
    disabled={!connected}
    onChange={(on) => {
      setRawRelay(on);
      void edgeDevice.setRawRelayEnabled(on).catch(console.error);
    }}
    label={rawRelay ? 'Raw PPG relay enabled' : 'Raw PPG relay disabled'}
  />
</Section>
```

Add a `useState<boolean>(false)` for `rawRelay`.

---

## Implementation order (suggested)

1. Read this entire doc + `docs/path-b-implementation-brief.md` + the
   existing `narbis_ble_central.{c,h}` end to end.
2. Phase 1 firmware (`narbis_ble_central` + `main.c`). Test by flashing
   and watching for the new `central: subscribe slot=0 which=6 on`
   (CONFIG = enum value 6 in the earclip's BLE_SUB_NARBIS_CONFIG) lines
   in the dashboard's BLE event log.
3. Phase 1 dashboard (parse 0xF4, store wiring). Verify the
   ConfigPanel populates from the relayed config.
4. Phase 1 dashboard writes (0xC3 forward path). Test: edit a value in
   the config UI; the earclip's UART should show `config_manager: config
   applied + persisted`.
5. Phase 2 raw streaming (0xC4 + 0xF5). Last because it's the heaviest
   air-time and easiest to defer.

After each phase, copy the firmware files from
`C:\CODE\EDGE EAR CLIP\REPO\edge-earclip\EDGE\EDGE FIRMWARE\` into
`C:\NARBIS APP\Oct_4_25\Clone\edge-firmware\v4\Code-Glasses\` so the user
can `git push` from the clone.

---

## Critical gotchas you will hit

1. **Firmware silently drops CTRL writes < 2 bytes.** `main.c::process_command`
   has `if (len < 2) return;`. The dashboard's `sendCtrlCommand` already
   pads to ≥ 2 bytes. Don't undo that pad.

2. **PPG program enum is 0-indexed, UI is 1-indexed.** Send `p - 1` for
   `setProgram`. Already fixed in `edgeDevice.ts::setProgram`.

3. **Glasses BLE name is `Narbis_Edge`** (underscore, exact match — not
   `Narbis Edge`, not a name prefix). Already fixed.

4. **The earclip co-advertising while connected to dashboard at LOW_LATENCY
   is unreliable** — adverts may get nearly zero air time when the radio
   is fully booked serving the 15 ms conn interval. Pairing flow that
   needs glasses to find the earclip works best when the dashboard is
   NOT connected to the earclip directly. The scan diagnostic counter
   added in `narbis_ble_central.c` (`scan_advs_seen` /
   `scan_advs_matched`) will tell you definitively whether this is the
   issue on the next flash. If `scan_advs_seen` > 0 but
   `scan_advs_matched` == 0, that's a different bug (UUID mismatch).
   If `scan_advs_seen` == 0, it's RF starvation — the earclip's adv
   timing needs to change, or the user's pair flow has to disconnect
   dashboard from earclip first.

5. **`narbis_central_forget()` doesn't disconnect first.** When the
   dashboard sends 0xC1 while the glasses are still connected to the
   earclip, the central wipes NVS but stays GATTC-connected on the same
   handle, then starts a general scan. Fix in narbis_ble_central.c
   `narbis_central_forget()`: call `esp_ble_gattc_close()` if connected,
   then wipe NVS, let the disconnect handler trigger general scan
   (since `S.earclip_known` will now be false).
   This is in the deferred list — fix it as part of Phase 1 cleanup.

6. **PowerShell 5.1 quirks** — if you write any helper scripts, no
   em-dashes (encoding gets mangled), no `2>&1` on native commands
   (`$ErrorActionPreference = 'Stop'` aborts on stderr lines), no
   backtick-`$1`-newline interpolation in single-line strings (parser
   error). All learned the hard way.

7. **Cross-org git push is sandboxed** — the agent cannot directly push
   to `narbiscorp/edge-firmware`. The user pushes from their clone.
   Don't try `gh auth login` or `git remote add` on the trusted repo.

---

## Verification flow (end-to-end test once Phase 1 ships)

1. Power on earclip. Confirm UART shows `transport_ble: advertising as
   "Narbis Earclip 1439C2" (slots used 0/3)`.
2. Power on glasses (with the new firmware flashed). Watch UART:
   - `central: scanning attempt 1, last seen N s ago`
   - `central: scan done, X adv seen, Y matched narbis`
   - `central: connected, conn_id=0`
   - `central: mtu=247`
   - `handles: ibi=N/cccd=M batt=… role=… config=… config_write=… raw=…`
   - `central: subscribe slot=0 which=2 on` (IBI, on earclip)
   - `central: subscribe slot=0 which=6 on` (CONFIG, on earclip — this is new)
   - `central: ready (IBI + config + battery subscribed)`
   - `earclip up: prog 1 + ADC off`
   - 5 slow lens pulses
3. Connect dashboard to glasses only (NOT to earclip). Within ~1 s
   the BLE event log shows `earclip rx config v3 (relay)` and the
   ConfigPanel populates with the live config. Sliders should be
   editable.
4. Move a slider, click Apply (or trigger autosave). Earclip UART shows
   `config_manager: config applied + persisted`. Dashboard's
   ConfigPanel updates a moment later via the next CONFIG notify.
5. Toggle "Stream Raw PPG via glasses". Dashboard sends 0xC4
   (ctrl_opcode=0xC4 in event log). Glasses log `0xC4 raw=1 rc=0`,
   then `central: raw subscribe on rc=0`. Earclip log shows
   `transport_ble: subscribe slot=0 which=4 on` (RAW_PPG = enum 4).
   Dashboard's Raw PPG chart starts populating.
6. Toggle off. Inverse log lines, chart stops.
7. Disconnect dashboard. Watch for clean disconnect lines on both ends.
8. Power-cycle earclip while glasses + dashboard remain. Within 30 s
   glasses reconnect, do 5 slow pulses, dashboard log resumes.

---

## Files / functions you'll be reading

```
EDGE/EDGE FIRMWARE/components/narbis_ble_central/narbis_ble_central.c
  ├── struct S {} ............................. internal state, line ~78
  ├── adv_contains_narbis_svc() ............... line ~194
  ├── start_scan_directed/general() ............ line ~224
  ├── cache_handles_after_discover() ........... ~line 260 (you will extend this)
  ├── write_peer_role() ........................ ~line 320
  ├── narbis_central_gap_event() ............... ~line 362
  ├── gattc_cb() ............................... ~line 422 (you will extend this)
  ├── narbis_central_init/start/forget() ....... ~line 540
  └── (new) narbis_central_set_config_cb / set_raw_cb / set_raw_enabled / write_earclip_config

EDGE/EDGE FIRMWARE/main/main.c (the user's clone, NOT in this repo's tree —
this repo's "EDGE/EDGE FIRMWARE/main/main.c" was moved from
"main_v4_14_38 (1).c" via git mv but is the same file)
  ├── process_command() switch ................. ~line 3853 (you will add 0xC3, 0xC4)
  ├── on_earclip_ibi() ......................... ~line 5856 (template for on_earclip_config)
  ├── on_earclip_battery() ..................... ~line 5862
  ├── ble_log() implementation ................. ~line 3017 (study this to write send_status_frame)
  └── narbis_central_init() call site .......... ~line 5974 (add cb registrations)

dashboard/src/ble/edgeDevice.ts
  ├── decodeStatusFrame() ...................... add 0xF4, 0xF5 cases
  ├── EdgeDevice class ........................ add forwardEarclipConfigWrite, setRawRelayEnabled
  └── parseRelayedIbi/Battery .................. study the pattern; mirror it for 0xF4/F5

dashboard/src/state/store.ts
  └── ~line 360-460 for the existing edgeDevice addEventListener pattern

dashboard/src/components/EdgeControls.tsx ....... add raw-relay Toggle section

dashboard/src/components/ConfigPanel.tsx ........ check if it gates on narbis.state ===
                                                  'connected'; relax to also accept edge.state ===
                                                  'connected' once relay populates state.config

protocol/narbis_protocol.ts
  ├── deserializeConfig ........................ already exists, used for both paths
  └── NARBIS_CONFIG_WIRE_SIZE ................... 50

protocol/narbis_protocol.h
  └── NARBIS_CHR_CONFIG_UUID_BYTES, NARBIS_CHR_CONFIG_WRITE_UUID_BYTES,
      NARBIS_CHR_RAW_PPG_UUID_BYTES — use these in cache_handles_after_discover
```

---

## Deferred backlog (NOT blocking Phase 1, but good follow-ups)

- **`narbis_central_forget()` should disconnect first** before wiping NVS.
  Currently it leaves the GATTC handle alive. Symptom: clicking
  "Pair earclip with glasses" while pair is established starts a scan
  that can't find the earclip because the slot is still occupied by
  the same glasses.
- **FW telemetry panel** — render the 0xF0 ADC stats and 0xF2 HRV
  fields (FW HR, IBI, Coherence, VLF/LF/HF, etc.) as a side panel.
  Decoder already in place in `edgeDevice.ts::decodeStatusFrame`.
- **Spectral Power (Lomb-Scargle) PSD chart** — separate compute job
  + Plotly chart. ~250 LOC.
- **Auto-fallback general scan** — after N directed-scan failures, the
  central could automatically go general. Right now it only goes
  general after explicit forget. Quality-of-life.
- **MTU-aware frame splitting** for 0xF5 raw — at MTU 23 a single
  notify can't carry 236 bytes. The dashboard negotiates 247 MTU on
  Web Bluetooth so it's fine in practice, but if MTU exchange fails
  we should chunk.

---

## How to confirm "Phase 1 done"

When you can:
1. Power-cycle both devices.
2. Open dashboard, click only Connect Glasses (not Connect Earclip).
3. ConfigPanel populates with live earclip config within seconds.
4. Edit a slider, save, see the earclip's UART confirm
   `config_manager: config applied + persisted`.
5. Reload dashboard tab — ConfigPanel re-populates from relay.

…you're done. Then move to Phase 2 (raw relay) only if the user still
wants it.

Good luck.
