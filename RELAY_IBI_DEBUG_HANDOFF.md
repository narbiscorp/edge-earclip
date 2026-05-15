# IBI Relay Debug Handoff

**Date:** 2026-05-15  
**Branch:** `claude/glasses-0xFA-link-quality` (glasses firmware)  
**Repos:** glasses firmware + earclip dashboard (edge-earclip)

---

## Problem Summary

The dashboard IBI tachogram and HRV metrics are empty when the earclip is paired through the glasses via BLE relay (Path B). Battery, raw PPG, and diagnostics all relay correctly. IBI and config do not.

---

## What IS Working (confirmed from BLE log screenshots)

| Frame | Description | Evidence |
|-------|-------------|---------|
| `0xF8` | Binary battery relay | "relay batt soc=30% mv=3636" in BLE log |
| `0xF1` | Text battery log | "earclip batt soc=30% mv=3636" in BLE log |
| `0xF5` | Raw PPG relay | Raw PPG chart full, clean waveform |
| `0xF7` | Diagnostic relay | Filtered signal chart with detected peaks |
| `0xFA` | Link quality frames | 0xFA frames arriving at 1 Hz |
| `0xF3` | Health frames | Present in log |
| —      | Relay badge | "⇄ Earclip linked" showing in dashboard header |
| —      | Beat detection | Earclip IS detecting beats (peaks visible in 0xF7 diag) |

## What is NOT Working

| Frame | Description | Symptom |
|-------|-------------|---------|
| `0xF9` | IBI binary relay | Zero "relay ibi=" entries in BLE log |
| `0xF1` | "earclip ibi=…" text | None in glasses log (distinct from battery 0xF1 lines) |
| `0xF4` | Config relay | Never arrives even after pressing "Get from Earclip" (0xC5 opcode) |
| —      | IBI tachogram | Completely empty |
| —      | HRV metrics | Completely empty |

---

## Definitive Root Cause Narrowing

**`on_earclip_ibi()` in the glasses firmware (main.c:6074) is never called.**

Evidence: This function emits `ble_log("earclip ibi=…")` unconditionally before sending the 0xF9 frame. Neither the log line nor the 0xF9 frame appear → the callback is never invoked.

The callback is only invoked from one place: `BLE_GAP_EVENT_NOTIFY_RX` inside `narbis_ble_central.c` when `attr_handle == S.hdl_ibi`. Since it never fires, either:

1. The earclip is not sending IBI notifications to the glasses, **or**
2. The notifications arrive but `S.hdl_ibi` is stale/zero so the handle comparison never matches

---

## Glasses Firmware Code Paths (fully investigated)

### `narbis_ble_central.c` — 9-Step Connection Chain

```
Step 1  ST_CONNECTING          gap_event_cb → BLE_GAP_EVENT_CONNECT
Step 2  ST_DISCOVERING         MTU exchange (on_mtu_complete)
Step 3  ST_DISCOVERING         NARBIS service discovery → on_svc_disc() per match
Step 4  ST_DISCOVERING         NARBIS service discovery complete (BLE_HS_EDONE)
Step 5  ST_WRITING_ROLE        Write PEER_ROLE = 0x02 to earclip
Step 6  ST_SUBSCRIBING_IBI     Write CCCD for IBI char   ← IBI subscription here
Step 7  ST_SUBSCRIBING_CONFIG  Write CCCD for CONFIG + initial read
Step 8  ST_SUBSCRIBING_BATT   Write CCCD for BATTERY
Step 9  ST_READY               Subscribe RAW + DIAG → enter_ready()
```

**Critical: `on_cccd_written()` continues the chain even on ATT error.**

```c
if (err && err->status != 0) {
    cb_log("central: cccd write status=%d (st=%s)", err->status, state_name(S.state));
}
// Chain advances regardless of error:
if (S.state == ST_SUBSCRIBING_IBI) {
    cb_log("central: chain 6/9 SUB_IBI_ACK");
    advance_to_config_or_batt_or_raw_or_diag_or_ready();
}
```

This means: **if the IBI CCCD write to the earclip fails with an ATT error, the glasses continue to subscribe battery/raw/diag — those will still work, but no IBI notifications will ever arrive.**

### `cccd_subscribe_ibi()` — Missing CCCD guard

```c
static void cccd_subscribe_ibi(void) {
    if (S.hdl_ibi_cccd == 0) {
        ESP_LOGW(TAG, "no IBI CCCD; skipping to READY");
        enter_ready();   // ← jumps past all remaining subscriptions
        return;
    }
    cccd_write(S.hdl_ibi_cccd, true, on_cccd_written);
}
```

If `S.hdl_ibi_cccd == 0` (descriptor not found during discovery), it calls `enter_ready()` directly — skipping CONFIG, BATTERY, RAW, and DIAG too. But battery IS working, so this path was NOT taken (battery CCCD must have been found and written).

### IBI notification dispatch path

```c
// In gap_event_cb, BLE_GAP_EVENT_NOTIFY_RX:
if (event->notify_rx.conn_handle != S.conn_handle ||
    event->notify_rx.om == NULL) return 0;

uint16_t attr_handle = event->notify_rx.attr_handle;
// ...
if (attr_handle == S.hdl_ibi && copied >= sizeof(narbis_ibi_payload_t)) {
    narbis_ibi_payload_t pl;
    memcpy(&pl, buf, sizeof(pl));
    if (S.ibi_cb) S.ibi_cb(pl.ibi_ms, pl.confidence_x100, pl.flags);
    S.notify_ibi_count++;
}
```

`S.ibi_cb` = `on_earclip_ibi` registered via `narbis_central_init(on_earclip_ibi, on_earclip_battery)`.

### `on_earclip_ibi()` (main.c:6074)

```c
static void on_earclip_ibi(uint16_t ibi_ms, uint8_t conf, uint8_t flags) {
    ble_log("earclip ibi=%u conf=%u flags=0x%02x", ibi_ms, conf, flags);  // always fires
    uint8_t ibi_pkt[4];
    ibi_pkt[0] = (uint8_t)(ibi_ms & 0xFF);
    ibi_pkt[1] = (uint8_t)((ibi_ms >> 8) & 0xFF);
    ibi_pkt[2] = conf;
    ibi_pkt[3] = flags;
    send_status_frame(0xF9, ibi_pkt, sizeof(ibi_pkt));  // → dashboard
    // ... beat_pulse, coh_push_ibi if conf >= threshold ...
}
```

### Characteristic UUIDs (narbis_protocol.h, used by narbis_ble_central.c)

| Char | UUID | Subscribed? |
|------|------|-------------|
| IBI | `78ef492f-66be-438d-a91e-ddfdb441b7bb` | Yes (step 6) |
| CONFIG | `553abc98-6406-4e37-b9fd-34df85b2b6c1` | Yes (step 7) |
| BATTERY | `b59d3ba1-78d1-4260-93c2-7e9e02329777` | Yes (step 8) |
| RAW_PPG | `6bacca91-7017-40fa-bb91-4ebf28a65a99` | Yes (step 9) |
| DIAGNOSTICS | `31d99572-bf8a-4658-828e-4f7c138ca722` | Yes (step 9) |
| CONFIG_WRITE | `129fbe56-cbd6-4f52-957b-d80834d6abf3` | Write-only |
| PEER_ROLE | (custom) | Write-only |

### Logged handle discovery line to look for

When descriptor discovery completes, the firmware logs:
```
"handles ibi=X/Y batt=Z/W role=R cfg=A/B cfgw=C raw=D/E diag=F/G"
```
If any field shows `0`, that characteristic or its CCCD was not found during GATTC discovery. **This is the first thing to check in the glasses serial log.**

---

## Root Cause Candidates

### Candidate A — IBI CCCD write failed (ATT error from earclip) ★ Most Likely

**Mechanism:** Glasses write `0x0001` to earclip's IBI CCCD → earclip returns ATT error → glasses log the error and advance the chain → battery/raw/diag still work → earclip never sends IBI notifications.

**Evidence for:** Battery works (step 8, after IBI) while IBI doesn't (step 6); chain-continues-on-error behavior is confirmed in code.

**Diagnostic:** Search glasses serial log for:
```
central: cccd write status=N (st=ST_SUBSCRIBING_IBI)
```
Any non-zero status here confirms this candidate.

**Why would earclip reject IBI CCCD write?**
- Earclip's NimBLE CCCD table is at capacity (too many concurrent CCCD registrations)
- Earclip requires authenticated pairing before IBI CCCD can be written, but not for battery
- IBI characteristic on earclip does not have NOTIFY property (firmware version mismatch)
- Earclip's IBI characteristic is in a different service than what glasses scan for

### Candidate B — Earclip not sending IBI notifications despite CCCD

**Mechanism:** CCCD write succeeded → earclip's CCCD is set → but earclip firmware never calls `ble_gatts_notify()` for the IBI characteristic, even when it detects beats.

**Evidence for:** Filtered signal (0xF7) shows beat detection is running. If earclip detects beats but a code path condition prevents it from emitting notify, this candidate applies.

**Diagnostic:** Read earclip firmware's beat-output path. Find where it calls `ble_gatts_notify()` for the IBI characteristic, and what gates that call (PEER_ROLE check? connection state? confidence threshold?).

### Candidate C — `S.hdl_ibi` handle mismatch / zero

**Mechanism:** IBI characteristic handle `S.hdl_ibi` is 0 or mismatches actual notify attr_handle → `attr_handle == S.hdl_ibi` condition in NOTIFY_RX never matches → callback never fired.

**Evidence for/against:** This would also cause `cccd_subscribe_ibi()` to be skipped entirely (since `S.hdl_ibi_cccd == 0` → `enter_ready()` → skips battery too). Battery works → battery CCCD was subscribed → the "skip to READY" path was NOT taken. So this candidate requires a split scenario: IBI chr val handle is found but CCCD descriptor for IBI is not found separately... but in that case `cccd_write(S.hdl_ibi_cccd=0)` → `enter_ready()` → still no battery. Unlikely.

**Diagnostic:** Check "handles ibi=X/Y" log line.

### Candidate D — Config-only: 0xC5 handler issues

Config (0xF4) failing to arrive after pressing "Get from Earclip" could be a separate issue from IBI:

- **Dashboard side:** 0xC5 opcode sends a GATTC read request; check `edgeDevice.ts` for `0xC5` send in `requestEarclipConfigRead()`
- **Glasses side:** `main.c` 0xC5 handler should call `narbis_central_read_earclip_config()` or similar → `ble_gattc_read(S.conn_handle, S.hdl_config, on_config_read, NULL)` → `on_earclip_config()` → `send_status_frame(0xF4, ...)`
- If `S.hdl_config == 0`, the read will fail silently; check handle log
- The initial config read also happens at step 7 after CONFIG CCCD subscription

---

## Dashboard Data Path (for reference — not the bug)

```
0xF9 frame arrives on 0xFF03 STATUS characteristic
→ edgeDevice.ts parseRelayFrame(0xF9, data)
→ ibi_ms = data[1] | (data[2] << 8)
→ conf = data[3], flags = data[4]
→ dispatch 'relayedIbi' event { ibi_ms, conf, flags }

store.ts handler for 'relayedIbi':
→ state.buffers.narbisBeats.push(timestamp, { ibi_ms, bpm, confidence_x100, flags })
→ metricsRunner reads narbisBeats when samples.length >= 4
→ BeatChart reads buffer for IBI tachogram
→ HRV metrics computed from extractIbiWindow(beats, 64s, nowMs)
```

---

## Investigation Steps for New Agent

### Step 1 — Read glasses serial log

Connect glasses and earclip, let them pair. Capture serial output from glasses (ESP-IDF monitor). Look for:

```
# Discovery completed — shows all handles:
handles ibi=X/Y batt=Z/W role=R cfg=A/B cfgw=C raw=D/E diag=F/G

# IBI CCCD write result:
central: chain 6/9 SUB_IBI_ACK
central: cccd write status=N (st=ST_SUBSCRIBING_IBI)    ← N≠0 = error, N=0 = success

# Descriptor not found:
no IBI CCCD; skipping to READY    ← would mean no battery either

# enter_ready log:
central: chain 9/9 READY (IBI+cfg+batt+raw+diag)    ← missing chars won't appear
```

### Step 2 — Read earclip firmware GATT server

File: `C:\CODE\EDGE EAR CLIP\REPO\edge-earclip\main\main.c`

Find:
1. IBI characteristic registration in the GATT service table — confirm it has `BLE_GATT_CHR_F_NOTIFY` property
2. Where earclip calls `ble_gatts_notify()` or `ble_gatts_chr_updated()` for IBI
3. What conditions gate this call (peer_role check? confidence threshold? connection mode?)
4. Whether there's a `peer_role` mechanism where earclip only sends IBI after the glasses write PEER_ROLE=0x02

### Step 3 — Confirm UUIDs match across both firmware trees

Check earclip `main/main.c` or its protocol header for IBI UUID and compare to:
```
glasses: 78ef492f-66be-438d-a91e-ddfdb441b7bb
```
Any mismatch → handles never discovered → IBI never subscribed.

### Step 4 — Confirm PEER_ROLE write timing

The glasses write `PEER_ROLE=0x02` to the earclip at step 5. If the earclip requires this write before it starts gating IBI notifications (a gating mechanism not in glasses firmware but possibly in earclip firmware), check if the write is confirmed before IBI subscription.

### Step 5 — Check NimBLE CCCD config

Check earclip's `sdkconfig` or `sdkconfig.defaults`:
```ini
CONFIG_BT_NIMBLE_MAX_CONNECTIONS   # max concurrent connections
CONFIG_BT_NIMBLE_ATTR_TABLE_SIZE   # attribute/CCCD table size
```
If CCCD table is full (e.g., earclip is also paired to iOS app simultaneously), IBI CCCD write will fail.

---

## Key File Paths

| File | Role |
|------|------|
| `C:\NARBIS APP\Oct_4_25\Clone\edge-firmware\v4\Code-Glasses\components\narbis_ble_central\narbis_ble_central.c` | Glasses GATTC client — fully investigated (see above) |
| `C:\NARBIS APP\Oct_4_25\Clone\edge-firmware\v4\Code-Glasses\main\main.c` | Glasses app — `on_earclip_ibi()` at line 6074, `narbis_central_init()` call at line 6289 |
| `C:\CODE\EDGE EAR CLIP\REPO\edge-earclip\main\main.c` | **Earclip firmware — primary investigation target** |
| `C:\CODE\EDGE EAR CLIP\REPO\edge-earclip\dashboard\src\ble\edgeDevice.ts` | Dashboard 0xF9 parser (data path downstream of bug) |
| `C:\CODE\EDGE EAR CLIP\REPO\edge-earclip\dashboard\src\state\store.ts` | Dashboard `relayedIbi` handler → `narbisBeats` buffer |
| `C:\CODE\EDGE EAR CLIP\REPO\edge-earclip\dashboard\src\state\metricsRunner.ts` | HRV metrics consumer — requires ≥4 samples in 64s window |

---

## Git Context

```
Glasses branch: claude/glasses-0xFA-link-quality
Recent glasses PRs:
  #25  emit 0xF9 binary IBI frame in on_earclip_ibi
  #24  raise BLE TX power to 0 dBm
  #23  NimBLE follow-up fixes (surgical self-heal, 25s watchdog)
  #22  NimBLE migration (removed Bluedroid + ESP-NOW)
```

The IBI emission code in 0xF9 was added in PR #25. The earclip central GATTC subscription chain was part of the NimBLE migration in PR #22/23. The bug is likely a mismatch between the GATTC subscription state and the earclip's GATT server state.

---

## Quick Diagnostic Checklist

- [ ] Capture glasses serial log during earclip connection
- [ ] Find `"handles ibi=X/Y"` line — are both X and Y non-zero?
- [ ] Find `"central: cccd write status=N (st=ST_SUBSCRIBING_IBI)"` — is N=0?
- [ ] Find `"central: chain 9/9 READY (IBI+cfg+batt+...)"` — does IBI appear in the list?
- [ ] Read earclip GATT table — does IBI characteristic have `NOTIFY` flag?
- [ ] Read earclip beat-output path — is `ble_gatts_notify(IBI)` gated on peer_role or connection mode?
- [ ] Check earclip sdkconfig for CCCD table size limits
- [ ] Confirm IBI UUID matches between earclip and glasses firmware
