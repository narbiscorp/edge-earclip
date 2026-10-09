# Handoff: Narbis V2.1 earclip → iOS (spec) and Android

**This document doubles as the prompt.** Hand it to an agent whole. Written 2026-10-09.

| | repo @ commit | what to read |
|---|---|---|
| Reference implementation (TypeScript) | `narbiscorp/edge-earclip` @ `5c25b41` | `dashboard/src/ble/v2/*`, `dashboard/src/ble/narbisDevice.ts` (V2 parts), `dashboard/src/recording/*`, `dashboard/src/guided/*` |
| Wire truth (firmware, protocol 1.2) | `narbiscorp/narbis-earclip-fw` @ `6786cc7` | `firmware/components/narbis_core/include/narbis/proto.h`, `nc_types.h`, `knob_list.h`, `nc_agc.h` |
| Shared guided protocols | `edge-earclip/protocol/guided/` | `ppg_artifact_protocols.json`, `README.md` |

**Status at writing:** the boards in hand run functest `v0.3.0-22` (protocol 1.1, AGC adjusting
continuously). The gain-lock firmware (protocol 1.2) is `4415ccd` plus the fix `6786cc7`
(functest `v0.3.0-26`), which makes the lock count beats flagged `INTERPOLATED`. It passes its
host tests and has streamed from a board, but it has not been checked locking on a real ear,
and it has not been pushed. Until then, take its constants from
`dashboard/src/ble/v2/protocol.ts`, which already carries them. Phase 1 does not depend on it:
gate everything that is 1.2-only on PROTO_VER (trap 7).

Per the apps' own rules: iOS is the spec and Android mirrors it; port the TypeScript 1:1 keeping
its class boundaries; cite the commit SHA above in every port commit; log every divergence in
`docs/PARITY.md` (iOS) / `docs/PARITY-ANDROID.md`.

---

## The job

Neither app talks to an earclip today. The welcome screens show `DeviceChip("Narbis Earclip",
available = false)` ("soon"), `HrvBeatSource` has no earclip value, and the only earclip data
either app handles is its battery relayed by the glasses (`0xF8`). Make the V2.1 earclip a
first-class beat source, in three phases:

1. **Beats** — connect, stream, feed every IBI to the coherence engine, show battery and
   signal state, record the session with source `EDGE_EARCLIP`. This is what the apps need.
2. **Raw capture** — optional: write the raw PPG / accelerometer / status / events into the
   export zip, in the same CSV schemas as the dashboard. This is what on-device beat-detection
   development needs.
3. **Guided recordings** — optional: run `ppg_artifact_protocols.json` (sit still, foot tap,
   chewing, talking, cued actions) and write the `protocol/` folder.

## The governing constraint

Same as the H10 port (`ref-ios/docs/H10-PORT-HANDOFF.md`): **TDD for the byte parser,
evidence-from-hardware for the link.** The parser has real acceptance vectors:

- `dashboard/src/ble/v2/__tests__/fixtures/fw-v0.3.0-22-capture.json` — 8 s of real notification
  bytes from a V2.1 board (every frame type, hex), captured connecting exactly as described
  below. Port `realCapture.test.ts` against it: every frame must decode, PPG `seq` contiguous,
  ~100 sps on the device clock, STATUS sane, accel 50 Hz, only known event layouts.
- `dashboard/src/ble/v2/__tests__/v2protocol.test.ts` and `linkStats.test.ts` — frames built
  byte-for-byte from the firmware layouts, including truncation and unknown-record cases.

A green suite proves the parser. It proves nothing about bonding, MTU, ordering or background
behaviour — see "What only hardware can prove".

---

## The wire contract (V2.1, protocol 1.2)

Custom service `a5e90100-c6a0-43c0-b0d0-6e6172626973`; characteristics `a5e901xx-…`:

| uuid | name | props | payload |
|---|---|---|---|
| `0101` | PPG | notify | `[u32 seq][u64 t0_us][u8 rate][u8 n][u8 flags]` + n × `{i32 ir, i32 red[, i32 amb]}` (amb present iff flags & 0x10). `t0_us` = device time of the FIRST sample |
| `0102` | ACCEL | notify | `[u32 seq][u64 t0_us][u8 odr][u8 n][u8 flags]` + n × `{i16 x,y,z}`; flags & 3 = full scale, & 4 = FIFO overrun |
| `0103` | IBI | notify | `[u32 seq][u8 n]` + n × `{u64 t_beat_us, u16 ibi_ms, u8 confidence 0..100, u8 flags}` |
| `0104` | EVENT | notify | `[u32 seq][u8 n]` + n × `{u8 type, u8 len, payload}`; payload starts with `u64 t_us`; skip unknown types by `len` |
| `0105` | STATUS | notify | 32 bytes, append-only (accept longer): battery mV/%, rate, LED mA, TIA gain, gate duty, drop/I²C counters, uptime, last IBI, HR, button, **byte 28 `agc_state`, byte 29 `agc_reacq_count` (1.2)** |
| `0106` | CONTROL | write + notify | request `[op][tid][payload]`, response notification `[op\|0x80][tid][status][payload]` |
| `0107` | PROTO_VER | read | u16 LE, `major << 8 \| minor` (`0x0102` = 1.2) |

Also exposed, unencrypted: Device Information `0x180A` (`0x2A26` firmware revision), Battery
`0x180F`, standard Heart Rate `0x180D`. All little-endian. Exact layouts and every constant:
`dashboard/src/ble/v2/protocol.ts` (generated-from-firmware values, cross-checked by the
firmware repo's `gen_proto_consts.py`).

PPG flags: `GATE 0x01`, `AGC_SETTLING 0x02`, `USB 0x04`, `RATE_CHANGED 0x08`, `AMB 0x10`,
`WEAR_OFF 0x20`, `CLIPPED 0x40`. IBI flags: `GATED 0x01`, `AGC_SETTLING 0x02`,
`INTERPOLATED 0x04`, `FIRST_AFTER_GAP 0x08` (that record has `ibi_ms = 0`).
Rate codes: 0..4 = 50/100/200/250/500 sps.

### Connect sequence (what the dashboard does — `V2Session.open` + `openV2Session`)

1. Connect; read DIS `0x2A26` (firmware) and PROTO_VER.
2. Subscribe **CONTROL first** (responses must be correlatable before anything is sent), then
   STATUS, PPG, IBI, EVENT, ACCEL.
3. Write CONTROL `STREAM_START` = `[0x01][tid][0x0D]` (PPG | IBI | EVENT). Expect `[0x81][tid][0]`.
4. Beats arrive on IBI; STATUS at 1 Hz and on every state change.

Subscribe ACCEL even if you ignore it: the firmware batches accelerometer data whenever PPG runs
and, with no subscriber, discards it by drop-oldest — counted in STATUS `notif_drop_count`, which
then climbs ~1/s and stops meaning anything.

CONTROL: **one outstanding request at a time** (else `BUSY`) — queue them
(`V2Session.control`). Correlate by tid; tid 0 is device-internal, ignore it. Status codes:
`dashboard/src/ble/v2/protocol.ts` `CTRL_STATUS_NAME`.

---

## Beats into the engine

- Entry point: `CoherenceEngine.onRR(rrMs, confidence, nowS)` — the documented single-beat path
  (Android `CoherenceEngine.kt:776-780`, iOS `CoherenceEngine.swift:859-860`).
- Skip `ibi_ms == 0` (`FIRST_AFTER_GAP`: a valid beat time with no interval).
- Confidence is already 0..100 — pass it unscaled (`narbisDevice.onV2Ibi` explains why).
- Keep the flags with the beat; `GATED` and `AGC_SETTLING` beats are the ones an artifact gate
  should distrust. `INTERPOLATED` is NOT an artifact flag: it means the peak time was refined
  to sub-sample precision, which happens on nearly every good beat.
- **Timestamp = when the beat occurred**, not when the notification arrived (the apps' own rule):
  anchor the device clock to the host clock once, on the first PPG batch's NEWEST sample
  (`t0_us + (n-1) * period`), then map every `t_beat_us` through that anchor
  (`narbisDevice.v2HostTime`). Anchoring on `t0` (the first sample) puts everything one batch
  early — that bug existed in the dashboard until `d1c37ce`.
- Record source: add `HrvBeatSource.EDGE_EARCLIP` (append-only; matches the backend contract
  `narbis-backend/docs/CONTRACT-HRV.md` and `Edge-HRV-Dashboard`). Map it explicitly — no `else`
  — and treat it as optical (`isOptical`).
- Battery: STATUS `batt_mv` / `batt_pct` (or standard BAS).

---

## Traps (each one would cost a field day)

1. **The strap scan will never see it.** The earclip advertises flags + its 128-bit service UUID
   only; the name is in the scan response; `0x180D` is not advertised. The apps' strap scan
   filters on `0x180D` (`PolarHrvLink.kt:514/538`, `PolarHrvLink.swift:266-269`). Scan for
   `a5e90100-…` — which is also what iOS background scanning requires.
2. **The glasses scan will grab it.** It keeps any name starting with "Narbis"/"Edge"
   (`LensProtocol.kt:36-43`, `LensProtocol.swift:36-45`); `Narbis Edge Earclip` and
   `Narbis Edge Earclip TEST` both match. Exclude anything advertising `a5e90100-…` or with
   "Earclip" in its name.
3. **One connection only** (`CONFIG_BT_NIMBLE_MAX_CONNECTIONS = 1`). A connected earclip stops
   advertising: if a dashboard or the functest page holds it, the phone will not find it at all.
4. **Bonding.** LE Secure Connections, Just Works, bonding on. The custom characteristics require
   an encrypted link (`*_ENC` flags); DIS / BAS / HRS do not. Production firmware accepts a NEW
   bond only while the pairing window is open (button double-press); TEST builds accept any.
   iOS shows the system pairing sheet on first access; Android must bond (or handle
   insufficient authentication). A phone that lost its keys is ignored outside the window.
5. **Production power policy.** PPG pauses off-ear (with brief periodic wear probes); the
   earclip sleeps after 120 s off-ear or 300 s idle and unconnected. Treat sleep as a normal
   disconnect with backoff (1/2/4/8 s, capped 30 s), and a 12 s unconditional connect timeout.
6. **MTU.** The firmware sizes every stream batch to the negotiated MTU
   (`ble_att_payload_budget` = MTU − 3, capped at 244), so whatever the phone negotiates works —
   iPhones commonly settle at 185, which just means smaller batches. But at the default MTU 23
   (20-byte payload) not even one PPG sample fits after the 15-byte header: Android must
   `requestMtu(247)` before subscribing.
7. **Gain lock (proto 1.2).** The AGC adjusts LED current / gain only until 6 clean beats (or a
   steady level for 8 s), then LOCKS; it re-adjusts only after 3 s of clipping or 15 s of drift
   with no beats, never sooner than 30 s after locking. STATUS byte 28 is the state — but only
   trust it when PROTO_VER ≥ `0x0102`; on older firmware it is a reserved zero.
8. **Device clock is truth.** One board's "100 sps" measured 99.43 sps. Firmware IBIs already
   use the measured period; never recompute intervals from the nominal rate.

---

## Port order

| # | What | Port from | Testable? |
|---|---|---|---|
| 1 | `EarclipV2Protocol` — pure byte parsing | `ble/v2/protocol.ts` | **Yes, TDD** — vectors above |
| 2 | `EarclipLinkStats` — seq gaps, clipping, device-clock rate | `ble/v2/linkStats.ts` | Yes (`linkStats.test.ts`) |
| 3 | `HrvLink` implementation + demo link | `ble/v2/session.ts`, `narbisDevice.ts` V2 parts | Demo: yes; BLE: **hardware** |
| 4 | Wiring to the engine + `EDGE_EARCLIP` record source | `narbisDevice.onV2Ibi` | Partly |
| 5 | Scan/pairing UX, both scan exclusions, battery, reconnect | traps 1–5 | **Hardware** |
| 6 | Raw capture into the export zip (optional) | `recording/format.ts`, `types.ts` | Yes (`v2format.test.ts`) |
| 7 | Guided recordings (optional) | `guided/*`, `recording/protocolFormat.ts` | Yes (`guided.test.ts`, `protocolFormat.test.ts`) |

For step 3's demo link, replay the capture fixture rather than synthesising a signal — that is
how the dashboard's end-to-end check was run.

## Raw capture schemas (phase 2)

Match the dashboard's zip so one analysis pipeline reads both: `v2/ppg_raw.csv` (one row per
sample: `host_ms, dev_us, seq, i, n, rate_sps, flags, flag_names, ir, red, amb, led_ir_ma,
led_red_ma, tia_rf_kohm`), `v2/accel_raw.csv`, `v2/status.csv`, `v2/ibi.csv`, `v2/events.csv`,
`v2/link_stats.json`, `v2/README.txt` — writers and column definitions in
`dashboard/src/recording/format.ts` (`V2_README` documents every column). Store batches whole and
expand to rows only on export.

## Guided recordings (phase 3)

Bundle `protocol/guided/ppg_artifact_protocols.json` unmodified and implement the eight rules in
`protocol/guided/README.md` (scheduled timestamps, cue timing, pause restarts the block, device
marker ids `(block + 1) * 1000 + offset`, audio modes). Write the `protocol/` folder exactly as
`recording/protocolFormat.ts` does. Pin it with the cases in `guided.test.ts` and
`protocolFormat.test.ts`.

---

## What only hardware can prove

- The bonding flow on each OS: pairing sheet / `createBond`, the pairing window, a phone that
  forgot its keys, and that iOS background reconnect (state restoration) works with an
  encrypted, bonded peripheral.
- The MTU each phone actually negotiates, batches arriving at that size, and no frame-length
  decode errors (the link-stats `parseErrors` counter must stay 0).
- CONTROL response ordering vs STATUS; the STREAM_START response arrives and data follows.
- Off-ear pause, sleep and wake, and the reconnect that follows.
- IBI agreement with a simultaneous Polar H10 (target ±10 ms at rest) — the guided protocol with
  an H10 connected is exactly this test.

## Rules

1. **Show the output.** For the link: a session on a real phone with a real earclip — logs, beat
   counts, a recorded block. Not a green tick.
2. Port the TypeScript 1:1, cite `5c25b41` / `6786cc7`; log divergences in the PARITY files.
3. Saved enum identifiers are append-only; every new record field needs a default.
4. No health data in logs: opcodes, states and counts only.
