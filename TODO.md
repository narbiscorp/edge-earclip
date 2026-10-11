# TODO

Items that cannot be resolved in code alone — they need hardware changes,
external systems, or work that is intentionally deferred to a later stage.

## Open

- **Battery sense divider (hardware mod required).** The Seeed XIAO ESP32-C6
  ships without a battery voltage divider. Solder a 1 MΩ : 1 MΩ resistor
  pair from BAT+ → A1 (GPIO1) → GND, then set Kconfig
  `NARBIS_BATT_DIVIDER_PRESENT=y` in `firmware/main/Kconfig.projbuild`
  (or via `idf.py menuconfig`). Until that's done,
  `power_mgmt_get_battery()` returns placeholder values
  (4000 mV / 80%) with a rate-limited `STUB:` warning.
  Reference: `firmware/main/power_mgmt.c`, `CLAUDE.md` Hardware target section.

- **Charge-status GPIO (Stage 09).** The XIAO ESP32-C6 charger does not
  expose CHG_STAT to a GPIO out of the box. `power_mgmt_get_battery()`
  currently always reports `charging=0`. To detect charging state, route
  the charger's status pin to a free GPIO and add `NARBIS_CHARGE_GPIO`
  Kconfig + a polling read in `power_mgmt.c`.

- **OTA payload format (Stage 08).** `firmware/main/ble_ota.c` is still a
  stub. Stage 08 ports the Nordic-style DFU implementation from the Edge
  firmware repo.

- **v2 — port glasses BLE host from Bluedroid to NimBLE.** Path B leaves the
  earclip on NimBLE and the glasses on Bluedroid (intentional v1
  divergence to avoid a port and a refactor in the same PR). Future
  cleanup: port the glasses' GATT server + new BLE central code to
  NimBLE so both halves of the product line share one stack. Reference:
  `EDGE/EDGE FIRMWARE/components/narbis_ble_central/` (current
  Bluedroid GATTC implementation).

## V2.1 earclip ("PPG Clip": XIAO ESP32-C6 + AFE4404 + LIS2DH12) — status 2026-10-11

### Where everything lives
- **Firmware:** `narbiscorp/narbis-earclip-fw` (local `C:\Users\dgrec\Downloads\PPG Clip\narbis-earclip-fw`),
  master @ `63b209e` = v0.3.0-40, protocol 1.3, **pushed**. Functest image `vendor/narbis-earclip-functest.bin`
  (build: `tools/make_factory_image.ps1`; flash at 0x0 with esptool). The repo has no CI.
- **Dashboard:** `dashboard/` here, live at https://narbiscorp.github.io/edge-earclip/app.html (`0bff73d`: device-driven
  AGC panel, "Run gain protocol", run history, ARTIFACT beats). Tester page `functest/` (protocol 1.3 constants, 89 knobs).
- **Mobile port spec:** `EARCLIP_V2_MOBILE_PORT_HANDOFF.md` (this repo's root).
- **Android HRV app:** `narbiscorp/edge-Android-HRV` PR #1 (branch `claude/zen-elbakyan-82adb6` @ `c246052`, phase 1 "Beats",
  CI green). On top of it, LOCAL ONLY (not pushed): branch `claude/earclip-raw-capture`
  (worktree `C:\CODE\edge-Android-HRV\.claude\worktrees\earclip-raw-capture`):
  - `945a2fd` first-pairing fix;
  - `3e866b7` raw capture + flags (phase 2) and the share-sheet grant.

  Debug APK built with a side-by-side id (`com.narbis.edge.hrv.earclip`, init script in the session scratchpad: debug
  `applicationIdSuffix ".earclip"`). Not yet installed on the phone.
- **iOS HRV app** (`narbiscorp/edge-iOS-HRV`): no earclip work yet.

### Boards
| board | BLE | USB | firmware |
|---|---|---|---|
| `58:E6:C5:15:A9:74` | `…A9:76` | COM25 | functest **v0.3.0-40** |
| `A0:F2:62:85:9F:C0` | `…9F:C2` | COM21 | functest v0.3.0-34 (flaky battery connector) |
| `A0:F2:62:85:A7:90`, `…D1:C0` | | | old bench -21 / functest -22 |

A clip that turned itself OFF drops off USB — press its button before flashing.

### Decisions (and why)
- **AGC = optimizer (agc_mode 2, default).**
  - Behaviour: solves the LED currents and TIA gain for ~1.05 M raw (50 % FS) around preferred 25/20 mA. It locks after 6 clean beats or 8 s steady, and then holds.
  - Re-runs: only when raw leaves target ± 500 k for 15 s, or after 3 s of clipping — never within 180 s of a lock. The user asked for ±400 k; 500 k was kept because it is wider (fewer re-runs, the stated goal).
  - In band near the preferred currents it holds still (v0.3.0-34 — breathing had made the LEDs dither ±1-2 mA and it never locked).
- **AGC step compensation (v0.3.0-36, knob `agc_step_comp`).** The DSP + beat chain is rescaled across every LED/gain step instead of gating ~2 s per step; the settle window now only annotates the PPG stream.
- **Beats only while worn. ARTIFACT (proto 1.3, IBI flag 0x10):** the interval is >15 % off both the median of the last 5 and the last one. Still sent, with confidence capped at 20; the dashboard keeps it out of HRV.
- **Standby (TEST builds).**
  - Ear posture → local sensing; a breathing LED while waiting.
  - OFF after 2 min not worn with no app session — on battery AND on USB (v0.3.0-38); console commands hold it off.
- **Idle-link kick.**
  - A central that subscribes nothing is dropped after 15 s, so a bonded OS background link cannot hold the single slot.
  - A NEW phone still pairing gets 60 s (v0.3.0-40, `idle_kick_pair_s`), and the 15 s restarts once paired.
- **Radio.**
  - TX power +20 dBm (knob `ble_tx_dbm`).
  - XIAO RF switch driven at boot: GPIO3 low (powered) + GPIO14 low (onboard ceramic antenna).
  - Advertising RSSI at the same spot went −68 → −41 dBm.
- **Heart Rate Service (0x180D)** carries H10-style RRs (1/1024 s, one per beat) minus ARTIFACT and GATED-context beats.
- **OFF current** measured 46 µA (PPK2), inside the hardware floor.
  - 33 µA of it is the AFE RESETZ pull-up R1 held low.
  - The fix is a board change (V2.2: R1 → pull-down), not firmware.
  - The 5 Hz spikes in OFF are hardware housekeeping (~1-2 µA), not firmware wakes.
- **Android pairing bug (root cause).** `ContextCompat.registerReceiver(..., RECEIVER_NOT_EXPORTED)` below API 33 puts the receiver behind an app-private permission. `com.android.bluetooth` does not hold it, so ACTION_BOND_STATE_CHANGED never arrived. Fixed by exporting protected-system-broadcast receivers, plus a 500 ms bond-state poll.

### Open — next steps, in order
1. **[Android, hardware]** Install the `claude/earclip-raw-capture` build on the Galaxy Note9 (needs a USB data connection + adb; the APK is too big to send through chat). Then run the checklist in that branch's `TODO.md`:
   - forget the clip in Bluetooth settings, then pair: it must go straight through (`earclip: bond … -> bonded`, no `dropped at stage BOND`);
   - do a short training and export it: the zip has `v2/` with every stream (ppg rows ≈ 100 × seconds; `ibi.csv` `engine_kept`);
   - the share sheet opens the zip.

   Then fast-forward the PR branch to it (`git push origin claude/earclip-raw-capture:claude/zen-elbakyan-82adb6`) and update the PR description.
2. **[Android]** The known order-dependent Robolectric leak (`UncaughtExceptionsBeforeTest`) still hits `CameraUiTest` in the full suite; it passes alone. `stopContainers()` is only in `PairingScreenTest` — extend it to the other UI tests.
3. **[Firmware]** Flash 9F:C0 to v0.3.0-40.
4. **[Hardware]** A guided recording on v0.3.0-40 with an H10, to check:
   - ARTIFACT flags on the chewing / talking blocks;
   - beats continuing through an AGC re-run ("Run gain protocol");
   - IBI agreement with the H10 at rest (target ±10 ms).
5. **[Hardware/firmware]** Measure the +20 dBm battery cost while streaming (PPK2) and settle the default. Light sleep in TEST-build standby (the real standby saving) is not started.
6. **[iOS]** Start the earclip port from `EARCLIP_V2_MOBILE_PORT_HANDOFF.md` (iOS is the spec per the apps' rules; Android went first, decision D34 there).
7. **[Dashboard]** The coherence-engine feed and the session-summary RMSSD still take flagged beats (interval bounds only). Decide whether they follow the HRV rule (`isArtifactBeat`).
8. **[Dashboard]** UI for the new knobs (`ble_tx_dbm`, `agc_step_comp`, `idle_kick_pair_s`): tester page only today.
9. **[Board rev V2.2]** R1 → pull-down (removes 33 µA from OFF).
10. **[Firmware]** Production builds (NARBIS_TEST_MODE 0) have not been run on hardware with any of this. The pairing window, the idle kick and the pairing grace were exercised in TEST builds only.
