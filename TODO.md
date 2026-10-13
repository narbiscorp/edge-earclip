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

## V2.1 earclip ("PPG Clip": XIAO ESP32-C6 + AFE4404 + LIS2DH12) — status 2026-10-12

### Where everything lives
- **Firmware:** `narbiscorp/narbis-earclip-fw` (local `C:\Users\dgrec\Downloads\PPG Clip\narbis-earclip-fw`),
  master @ `c8b91ec` (pushed 2026-10-12) = v0.3.0-46, protocol 1.4 (adaptive refractory, two-level motion gate,
  `tools/replay/`, tester step 15). Functest image `vendor/narbis-earclip-functest.bin`
  (build: `tools/make_factory_image.ps1`; flash at 0x0 with esptool). The repo has no CI.
- **Replay + H10 scoring:** `tools/replay/` in the firmware repo re-runs the firmware's own beat detection on a dashboard
  recording with any knob settings and scores each guided block against the H10 (`replay_session.py <session.zip>`).
- **Dashboard:** `dashboard/` here, live at https://narbiscorp.github.io/edge-earclip/app.html (`0bff73d`: device-driven
  AGC panel, "Run gain protocol", run history, ARTIFACT beats; `243cc19` mains notch 60 / 50 / off on the raw trace).
  Tester page `functest/` (step 15 fingertip, protocol 1.4, 91 knobs). MOTION flag names `b03712d`. All live.
- **Mobile port spec:** `EARCLIP_V2_MOBILE_PORT_HANDOFF.md` (this repo's root).
- **Android HRV app:** `narbiscorp/edge-Android-HRV` PR #1, fast-forwarded to `a35902d` (pairing fix, raw capture, UI-test
  leak fix; Note9 re-test passed 2026-10-11). LOCAL, not pushed, on branch `claude/earclip-raw-capture`
  (worktree `C:\CODE\edge-Android-HRV\.claude\worktrees\earclip-raw-capture`):
  - `b213c4e` the HR number follows kept beats (no doubled ~160 bpm), and a steady battery figure on the earclip chip;
  - `f0a1bcd` review screen: average resonance frequency of the Follow trainings;
  - `b6795ca` Settle & Find renamed Discovery, the earclip runs it as an experiment (PPG baseline breathing, accel logged
    beside it in `resp.csv`);
  - the protocol 1.4 MOTION flag names.

  Debug APK with a side-by-side id (`com.narbis.edge.hrv.earclip`, debug `applicationIdSuffix ".earclip"`), installed on
  the Note9 through `b6795ca`.
- **iOS HRV app** (`narbiscorp/edge-iOS-HRV`): no earclip work yet.

### Boards
| board | BLE | USB | firmware |
|---|---|---|---|
| `58:E6:C5:15:A9:74` | `…A9:76` | COM25 | functest **v0.3.0-49** (the working board; flashed 2026-10-13, bonds and knobs wiped) |
| `A0:F2:62:85:9F:C0` | `…9F:C2` | COM21 | functest v0.3.0-34 (flaky battery connector; set aside) |
| `A0:F2:62:85:A7:90`, `…D1:C0` | | | old bench -21 / functest -22 |

A clip that turned itself OFF drops off USB — press its button before flashing.

### Decisions (and why)
- **AGC = optimizer (agc_mode 2, default).**
  - Behaviour: solves the LED currents and TIA gain for ~1.05 M raw (50 % FS) around preferred 25/20 mA. It locks after 6 clean beats or 8 s steady, and then holds.
  - Re-runs: only when raw leaves target ± 500 k for 15 s, or after 3 s of clipping — never within 180 s of a lock. The user asked for ±400 k; 500 k was kept because it is wider (fewer re-runs, the stated goal).
  - In band near the preferred currents it holds still (v0.3.0-34 — breathing had made the LEDs dither ±1-2 mA and it never locked).
- **AGC step compensation (v0.3.0-36, knob `agc_step_comp`).** The DSP + beat chain is rescaled across every LED/gain step instead of gating ~2 s per step; the settle window now only annotates the PPG stream.
- **Beats only while worn. ARTIFACT (proto 1.3, IBI flag 0x10):** the interval is >15 % off both the median of the last 5 and the last one. Still sent, with confidence capped at 20; the dashboard keeps it out of HRV.
- **Adaptive refractory (v0.3.0-42, `refract_frac_pct` 60 %).** After a beat, the detector ignores 60 % of the median clean interval, so the second hump of a pulse can't count while talking or chewing.
- **Two-level motion gate (v0.3.0-46, protocol 1.4).**
  - Accel energy over `gate_acc_thr` (8000) but under `gate_acc_hard_thr` (200000) no longer gates: beats are found through it and flagged MOTION (IBI 0x20, PPG batch 0x80).
  - Over 200 k (taking the clip off reads 0.87-4.5 M) it gates as before.
  - Why: every chewing, talking and foot-tap gate in three guided H10 runs was the accel gate, and it lost 40-70 % of the beats there.
  - Replayed: chew / talk beats found went from 32-51 % to 81-92 %, with false beats about the same; intervals during motion are 7-13 ms median off the H10.
  - MOTION beats stay in HR, the HRS and HRV, but do not count toward an AGC lock.
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
1. **[Hardware]** A guided run with the H10 on v0.3.0-49 (A9:74; re-pair the phone first, its bond was wiped). Also check the new button timing: hold 3 s = off, 1 s = on (the boot log prints how the 1 s split, with ~200 ms of it an estimate).
   - Score it with `tools/replay/replay_session.py --config live`.
   - Expect chew / talk found ≥ 80 %, MOTION on those beats, and rest unchanged (live 2026-10-12, run 1: 100 % found, median 3-4 ms, 95-97 % within 10 ms).
2. **[Android, hardware]** Test the installed build on the Note9:
   - HR never doubles;
   - the battery % on the earclip chip (`battery=` in `strap-pmd.log`);
   - the review screen's resonance line;
   - Discovery on the H10, and on the earclip (experimental), with an export to check `resp.csv`.

   Then push the branch to PR #1.
3. **[Oximeter]** When the Innovo iP900BP-B arrives: connect it from the dashboard ("Connect Oximeter"). If it reports none of the known services, read its service UUID from this PC (bleak) and add it to `OXIMETER_SERVICES` in `dashboard/src/ble/innovoOximeter.ts`. Then wear both and use "fit from oximeter" (pulse-ox chart → cal). A breath-hold or altitude dip gives the 4-point spread that fits the slope b too.
4. **[Report]** A motion section in the training report from the accel energy and MOTION flags (dashboard and app). Proposed, not yet agreed.
5. **[Hardware]** The third guided subject's pulse was weak (AC/DC 0.66 %), and only 58-65 % of beats were found even at rest (37-65 % in motion). Try placement and the LED currents first.
6. **[Hardware/firmware]** Measure the +20 dBm battery cost while streaming (PPK2) and settle the default. Light sleep in TEST-build standby (the real standby saving) is not started.
7. **[iOS]** Start the earclip port from `EARCLIP_V2_MOBILE_PORT_HANDOFF.md` (iOS is the spec per the apps' rules; Android went first, decision D34 there).
8. **[Dashboard]** The coherence-engine feed and the session-summary RMSSD still take flagged beats (interval bounds only). Decide whether they follow the HRV rule (`isArtifactBeat`).
9. **[Dashboard]** UI for the new knobs (`ble_tx_dbm`, `agc_step_comp`, `idle_kick_pair_s`, `refract_frac_pct`, `gate_acc_hard_thr`): tester page only today.
10. **[Board rev V2.2]** R1 → pull-down (removes 33 µA from OFF).
11. **[Firmware]** Production builds (NARBIS_TEST_MODE 0) have not been run on hardware with any of this. The pairing window, the idle kick and the pairing grace were exercised in TEST builds only.
