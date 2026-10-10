# Handoff: Narbis V2.1 earclip → iOS (spec) and Android

**This document doubles as the prompt.** Hand it to an agent whole. Written 2026-10-09; updated
the same day for firmware v0.3.0-38 / protocol 1.3.

| | repo @ commit | what to read |
|---|---|---|
| Reference implementation (TypeScript) | `narbiscorp/edge-earclip` @ `0bff73d` | `dashboard/src/ble/v2/*`, `dashboard/src/ble/narbisDevice.ts` (V2 parts), `dashboard/src/recording/*`, `dashboard/src/guided/*`, `dashboard/src/metrics/windowing.ts` (which beats HRV trusts) |
| Wire truth (firmware, protocol 1.3) | `narbiscorp/narbis-earclip-fw` @ `6db9ec3` | `firmware/components/narbis_core/include/narbis/proto.h`, `nc_types.h`, `knob_list.h`, `nc_agc.h`, `nc_ibi.h` |
| Shared guided protocols | `edge-earclip/protocol/guided/` | `ppg_artifact_protocols.json`, `README.md` |

**Status at writing:** firmware v0.3.0-38 (`a92c7cb`, image committed as `6db9ec3`, protocol
1.3) is pushed. Board `58:E6:C5:15:A9:74` runs it; board `A0:F2:62:85:9F:C0` runs v0.3.0-34
(protocol 1.3, no step compensation / radio fix). Verified on real hardware, on an earlobe:
- The optimizer AGC locks: it picked 28/19 mA at 25k and locked, with beats ~80 bpm at
  confidence 84.
- Removal is detected in ~4 s, and no beats are emitted off-ear.
- The standby breathing LED works.
- The radio fix: advertising RSSI at the same spot went −68 → −41 dBm.

Not yet proven on hardware:
- Beats continuing through an AGC re-run (proven in the firmware's host tests only).
- ARTIFACT flags on chewing / talking against an H10.
- The 2-minute auto-off.

Gate every 1.2-only and 1.3-only behaviour on PROTO_VER (traps 7 and 9). Take constants from
`dashboard/src/ble/v2/protocol.ts`, which carries them all.

Per the apps' own rules: iOS is the spec and Android mirrors it; port the TypeScript 1:1 keeping
its class boundaries; cite the commit SHAs above in every port commit; log every divergence in
`docs/PARITY.md` (iOS) / `docs/PARITY-ANDROID.md`.

---

## The job

Neither app talks to an earclip today. The welcome screens show `DeviceChip("Narbis Earclip",
available = false)` ("soon"), `HrvBeatSource` has no earclip value, and the only earclip data
either app handles is its battery relayed by the glasses (`0xF8`). Make the V2.1 earclip a
first-class beat source, in three phases:

1. **Beats** — connect, stream, feed every trusted IBI to the coherence engine, show battery and
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
  ~100 sps on the device clock, STATUS sane, accel 50 Hz, only known event layouts. (It is a
  protocol 1.1 capture: the 1.2 STATUS bytes read 0 there, which is exactly what trap 7 is about.)
- `dashboard/src/ble/v2/__tests__/v2protocol.test.ts`, `linkStats.test.ts` and `agc.test.ts` —
  frames built byte-for-byte from the firmware layouts, including truncation and unknown-record
  cases, the 1.3 ARTIFACT flag, the STATUS AGC fields and the AGC_STATE event.

A green suite proves the parser. It proves nothing about bonding, MTU, ordering or background
behaviour — see "What only hardware can prove".

---

## The wire contract (V2.1, protocol 1.3)

Custom service `a5e90100-c6a0-43c0-b0d0-6e6172626973`; characteristics `a5e901xx-…`:

| uuid | name | props | payload |
|---|---|---|---|
| `0101` | PPG | notify | `[u32 seq][u64 t0_us][u8 rate][u8 n][u8 flags]` + n × `{i32 ir, i32 red[, i32 amb]}` (amb present iff flags & 0x10). `t0_us` = device time of the FIRST sample |
| `0102` | ACCEL | notify | `[u32 seq][u64 t0_us][u8 odr][u8 n][u8 flags]` + n × `{i16 x,y,z}`; flags & 3 = full scale, & 4 = FIFO overrun |
| `0103` | IBI | notify | `[u32 seq][u8 n]` + n × `{u64 t_beat_us, u16 ibi_ms, u8 confidence 0..100, u8 flags}` |
| `0104` | EVENT | notify | `[u32 seq][u8 n]` + n × `{u8 type, u8 len, payload}`; payload starts with `u64 t_us`; skip unknown types by `len` |
| `0105` | STATUS | read + notify | 32 bytes, append-only (accept longer): battery mV/%, rate, LED mA, TIA gain, gate duty, drop/I²C counters, uptime, last IBI, HR, button, **byte 28 `agc_state`, byte 29 `agc_reacq_count` (1.2)** |
| `0106` | CONTROL | write + notify | request `[op][tid][payload]`, response notification `[op\|0x80][tid][status][payload]` |
| `0107` | PROTO_VER | read | u16 LE, `major << 8 \| minor` (`0x0103` = 1.3) |

Also exposed, unencrypted: Device Information `0x180A` (`0x2A26` firmware revision), Battery
`0x180F`, standard Heart Rate `0x180D`. All little-endian. Exact layouts and every constant:
`dashboard/src/ble/v2/protocol.ts` (generated-from-firmware values, cross-checked by the
firmware repo's `gen_proto_consts.py`).

PPG flags: `GATE 0x01`, `AGC_SETTLING 0x02`, `USB 0x04`, `RATE_CHANGED 0x08`, `AMB 0x10`,
`WEAR_OFF 0x20`, `CLIPPED 0x40`. Rate codes: 0..4 = 50/100/200/250/500 sps.

IBI flags:
- `GATED 0x01` — the first beat after a gated stretch (motion, clipping, off-ear); its interval
  spans the gated time.
- `AGC_SETTLING 0x02` — reserved: current firmware never sets it (gain steps are compensated,
  trap 7).
- `INTERPOLATED 0x04` — sub-sample peak timing; set on nearly every good beat; NOT an artifact.
- `FIRST_AFTER_GAP 0x08` — that record has `ibi_ms = 0`: a valid beat time with no interval.
- `ARTIFACT 0x10` (**1.3**) — the interval is implausible: more than 15 % off BOTH the median of
  the last 5 accepted intervals AND the last one (a missed or double beat — chewing, talking).
  Confidence is capped at 20. Four agreeing flagged intervals re-anchor (a real rate change).

STATUS flags byte: `CHARGING 0x01`, `CHARGE_DONE 0x02`, `USB 0x04`, `WORN 0x08`, `GATE 0x10`,
`AGC_FROZEN 0x20`, `HRS_ACTIVE 0x40`, `LOWBATT_WARN 0x80`.

### Connect sequence (what the dashboard does — `V2Session.open` + `openV2Session`)

1. Connect; read DIS `0x2A26` (firmware) and PROTO_VER.
2. Subscribe **CONTROL first** (responses must be correlatable before anything is sent), then
   STATUS, PPG, IBI, EVENT, ACCEL. Do it promptly — see trap 10.
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
- Skip `ibi_ms == 0` (`FIRST_AFTER_GAP`).
- Confidence is already 0..100 — pass it unscaled (`narbisDevice.onV2Ibi` explains why).
- Keep every beat and its flags in the record (flagged, never dropped), but leave out of HRV the
  ones the dashboard leaves out: `ARTIFACT`, `GATED`, `AGC_SETTLING` (`isArtifactBeat` in
  `metrics/windowing.ts`). `INTERPOLATED` beats are clean.
- The firmware already emits beats only while the clip is worn: off-ear there are no beats at
  all (not flagged ones — none).
- **Timestamp = when the beat occurred**, not when the notification arrived (the apps' own rule):
  anchor the device clock to the host clock once, on the first PPG batch's NEWEST sample
  (`t0_us + (n-1) * period`), then map every `t_beat_us` through that anchor
  (`narbisDevice.v2HostTime`). Anchoring on `t0` (the first sample) puts everything one batch
  early — that bug existed in the dashboard until `d1c37ce`.
- Record source: add `HrvBeatSource.EDGE_EARCLIP` (append-only; matches the backend contract
  `narbis-backend/docs/CONTRACT-HRV.md` and `Edge-HRV-Dashboard`). Map it explicitly — no `else`
  — and treat it as optical (`isOptical`).
- Battery: STATUS `batt_mv` / `batt_pct` (or standard BAS).
- The standard Heart Rate Service (`0x180D`) carries the same beats H10-style (one RR per beat,
  1/1024 s) minus `ARTIFACT` and `GATED` ones — its RR list has no flag field. Use the custom
  IBI characteristic in the apps; HRS is for third-party consumers.

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
5. **Power policy.** Treat every sleep as a normal disconnect with backoff (1/2/4/8 s, capped
   30 s), and a 12 s unconditional connect timeout.
   - Production builds: PPG pauses off-ear (with brief periodic wear probes); the earclip sleeps
     after 120 s off-ear or 300 s idle and unconnected.
   - TEST / functest builds (what the boards run today): with no app session the clip is in
     STANDBY — the LEDs breathe and the accelerometer watches for ear posture. On the ear it starts
     sensing and optimizing gain by itself, LED solid, before anything connects; connecting does
     not restart that. Not worn for 2 minutes → OFF, on battery and (since v0.3.0-38) on USB
     alike; a button press wakes it.
6. **MTU.** The firmware sizes every stream batch to the negotiated MTU
   (`ble_att_payload_budget` = MTU − 3, capped at 244), so whatever the phone negotiates works —
   iPhones commonly settle at 185, which just means smaller batches. But at the default MTU 23
   (20-byte payload) not even one PPG sample fits after the 15-byte header: Android must
   `requestMtu(247)` before subscribing.
7. **Gain control (proto 1.2 lock, 1.3 optimizer).** As soon as the clip is on the ear the AGC
   OPTIMIZES once: it solves for the LED currents and TIA gain that put the raw level near the
   middle of the ADC (~1.05 M counts) around preferred currents (25 mA IR / 20 mA red), then
   LOCKS after 6 clean beats (or a steady level for 8 s).
   - Once locked it re-runs only after 3 s of clipping, or the level outside ±500 k counts for
     15 s, and never sooner than 3 minutes after a lock.
   - Every LED / gain step is compensated in the beat chain (v0.3.0-36), so beats keep coming
     through a re-run.
   - STATUS byte 28 is the state (0 off, 1 adjusting, 2 locked) and EVENT `AGC_STATE` says why.
     Trust both only when PROTO_VER ≥ `0x0102`; on older firmware byte 28 is a reserved zero.
   - The dashboard's tuning panel (`V2TuningPanel.tsx` + `ble/v2/agc.ts`) shows how to present
     it, if the apps want to: knobs driven by STATUS, and a run history.
8. **Device clock is truth.** One board's "100 sps" measured 99.43 sps. Firmware IBIs already
   use the measured period; never recompute intervals from the nominal rate.
9. **ARTIFACT is 1.3-only.** On PROTO_VER < `0x0103` bit 4 is never set — do not treat its
   absence as "plausibility checked".
10. **Subscribe within 15 s or be dropped.** A central that connects and subscribes to nothing
    of ours is disconnected after 15 s (`idle_kick_s`; OTA exempt). It exists because a phone or
    PC that bonded once reconnects in the background, subscribes nothing, and with one connection
    slot locks the real app out. Every client of ours subscribes within a second; an app that
    connects "just to read the battery" must subscribe or expect the kick.

---

## Port order

| # | What | Port from | Testable? |
|---|---|---|---|
| 1 | `EarclipV2Protocol` — pure byte parsing | `ble/v2/protocol.ts` | **Yes, TDD** — vectors above |
| 2 | `EarclipLinkStats` — seq gaps, clipping, device-clock rate | `ble/v2/linkStats.ts` | Yes (`linkStats.test.ts`) |
| 3 | `HrvLink` implementation + demo link | `ble/v2/session.ts`, `narbisDevice.ts` V2 parts | Demo: yes; BLE: **hardware** |
| 4 | Wiring to the engine + `EDGE_EARCLIP` record source + the HRV beat filter | `narbisDevice.onV2Ibi`, `metrics/windowing.ts` | Partly (`windowing.test.ts`) |
| 5 | Scan/pairing UX, both scan exclusions, battery, reconnect, prompt subscribe | traps 1–5, 10 | **Hardware** |
| 6 | Raw capture into the export zip (optional) | `recording/format.ts`, `types.ts` | Yes (`v2format.test.ts`) |
| 7 | Guided recordings (optional) | `guided/*`, `recording/protocolFormat.ts` | Yes (`guided.test.ts`, `protocolFormat.test.ts`) |

For step 3's demo link, replay the capture fixture rather than synthesising a signal — that is
how the dashboard's end-to-end check was run.

## Raw capture schemas (phase 2)

Match the dashboard's zip so one analysis pipeline reads both: `v2/ppg_raw.csv` (one row per
sample: `host_ms, dev_us, seq, i, n, rate_sps, flags, flag_names, ir, red, amb, led_ir_ma,
led_red_ma, tia_rf_kohm`), `v2/accel_raw.csv`, `v2/status.csv`, `v2/ibi.csv`, `v2/events.csv`,
`v2/link_stats.json`, `v2/README.txt` — writers and column definitions in
`dashboard/src/recording/format.ts` (`V2_README` documents every column, ARTIFACT and AGC_STATE
included). Store batches whole and expand to rows only on export.

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
- CONTROL response ordering vs STATUS; the STREAM_START response arrives and data follows; the
  app subscribes inside the 15 s idle-kick window.
- Standby, the 2-minute auto-off, wake, and the reconnect that follows.
- IBI agreement with a simultaneous Polar H10 (target ±10 ms at rest) — the guided protocol with
  an H10 connected is exactly this test. Check the ARTIFACT flags on its chewing / talking
  blocks, and that beats keep coming through an AGC re-run.

## Rules

1. **Show the output.** For the link: a session on a real phone with a real earclip — logs, beat
   counts, a recorded block. Not a green tick.
2. Port the TypeScript 1:1, cite `0bff73d` / `6db9ec3`; log divergences in the PARITY files.
3. Saved enum identifiers are append-only; every new record field needs a default.
4. No health data in logs: opcodes, states and counts only.
