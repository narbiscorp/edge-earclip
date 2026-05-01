# Stage 07 — Firmware: Config persistence, mode controller, power management

## Task

Runtime config system, mode state machine, light sleep integration, battery monitoring.

## Prerequisites

Stage 06 complete. ESP-NOW and BLE both work.

## Replace stub from earlier stages

**`power_mgmt_get_battery(uint16_t *mv, uint8_t *soc_pct)`** currently returns fake placeholder values (4000 mV / 80%) with an `ESP_LOGW("power_mgmt", "STUB: ...")` warning that fires every time it's called. This stage replaces the stub with a real implementation:
- ADC read of the XIAO C6's battery voltage divider pin
- Voltage-to-percentage conversion via a LiPo discharge curve lookup table
- Removal of the `ESP_LOGW("STUB: ...")` line
- Removal of the corresponding TODO.md entry

Verify before completing this stage: the "STUB" warning no longer appears in UART logs after a power cycle.

## What to build

1. **`firmware/main/config_manager.c/h`**:
   - On boot: load `narbis_runtime_config_t` from NVS, fall back to defaults if missing/invalid
   - CRC validation
   - `config_get(out)`, `config_apply(new_config)` — apply changes live, persist on success
   - Differential application: identify changed fields, call appropriate apply functions:
     - sample rate / pulse width → `ppg_driver_reconfigure()`
     - LED currents → `ppg_driver_set_led_current()`
     - bandpass cutoffs → `elgendi_reconfigure_filter()`
     - Elgendi params → `elgendi_set_params()`
     - IBI validation → `beat_validator_set_params()`
     - transport mode → `app_state_transition()`
     - BLE profile → `ble_transport_set_profile()`
   - Return error if any apply fails — leave system in previous state

2. **`firmware/main/app_state.c/h`** — mode state machine:
   - States: BOOT, IDLE, STREAMING, OTA_UPDATING (Path B collapsed EDGE_ONLY/HYBRID into STREAMING)
   - Transitions on config write, OTA start/complete
   - Clean transport switching on transition
   - Persist last-active mode in NVS

3. **`firmware/main/power_mgmt.c/h`**:
   - Configure light sleep allowed during idle
   - `esp_pm_configure()` with appropriate config
   - PM locks to prevent sleep during BLE notification bursts
   - **Battery monitoring (replaces Stage 05 stub):**
     - Read battery voltage via ADC (use the XIAO C6's battery sense pin — verify current pin from Seeed wiki)
     - Use ADC oneshot mode with appropriate calibration (curve fitting if available)
     - Average several samples to reduce noise
     - Compute SOC% from LiPo discharge curve via lookup table:
       - 4.20V → 100%
       - 4.10V → 90%
       - 4.00V → 75%
       - 3.90V → 60%
       - 3.80V → 45%
       - 3.70V → 30%
       - 3.60V → 15%
       - 3.50V → 5%
       - 3.40V → 0%
       - Linear interpolation between points
     - Read every 10 seconds (battery doesn't change fast)
     - Cache last value so `power_mgmt_get_battery()` returns immediately without waiting for ADC
     - Update battery service via `battery_service_update()`
     - Low-battery warning (`ESP_LOGW`) at 15%
     - Hook for OTA refusal below 30%
   - **Remove the STUB warning** added in Stage 05
   - **Remove the TODO.md entry** for `power_mgmt_get_battery()`

4. **`firmware/main/diagnostics.c/h`**:
   - Single ring buffer for all diagnostic streams
   - Configurable streams: pre-filter signal, post-filter signal, peak candidates, AGC events, FIFO occupancy
   - Bitmask in config controls which are enabled
   - Rate-limited emission via the Diagnostic Streams BLE characteristic

5. **Wire up in main.c**:
   - Boot sequence: NVS → config load → ppg → channel → elgendi → validator → ESP-NOW → BLE → state machine → last-active mode

## Implementation notes

- Light sleep with BLE active: ensure `CONFIG_PM_ENABLE`, `CONFIG_FREERTOS_USE_TICKLESS_IDLE`, NimBLE doesn't prevent sleep
- Wake from light sleep: ~hundreds of µs
- Don't sleep during active BLE notifications — use `esp_pm_lock`
- Battery curve numbers above are starting points; refine with actual measurement against a fully charged and discharged cell
- ADC has noise — average at least 8 samples per reading
- Apply functions must be thread-safe (config write from BLE task, applied by other tasks)

## TODO.md handling

Before starting this stage, **read `TODO.md` at the repo root** and identify all items addressed by this stage. After implementation, remove those items from TODO.md. If new stubs are introduced, add them to TODO.md with the stage where they should be addressed.

## Success criteria

- Config writes from BLE take effect within 1 second
- Power cycle → last-active mode and config restored
- Battery percentage tracks accurately (verify with USB power meter or reference voltmeter)
- No "STUB" warnings appear in UART logs
- Light sleep happens — average current drops vs Stage 06
- Power targets (revised after Path B; see "Power-target history" below):
  - Idle, no central:           target ≤35 mA  / expected 25–35 mA
  - Dashboard only, LOW_LATENCY: target ≤40 mA  / expected 35–40 mA
  - Glasses only, BATCHED:       target ≤30 mA  / expected 20–30 mA
  - Both centrals connected:     target ≤50 mA  / expected 40–50 mA
  - **Non-blocking rule**: if observed lands within 10% over target, ship anyway.
    File a TODO with the negotiated BLE conn interval as the suspected cause.
    Do not block the PR on the PPK2 numbers.
- Mode transitions don't lose beats
- TODO.md no longer contains items addressed by this stage

## Power-target history

The original targets in this stage were:
  - EDGE_ONLY:                    ≤9 mA average
  - HYBRID + BATCHED:             ≤11 mA
  - HYBRID + LOW_LATENCY + RAW_PPG: ≤13 mA

Those numbers were pre-measurement assumptions. PPK2 measurement on real
hardware (Build B: BLE-on, Wi-Fi-off, IDF 5.5, ESP32-C6) recorded **55.92
mA**. The phone-forced 15 ms BLE conn interval is a hard floor that
cannot be reduced via software on this hardware.

Path B (chosen 2026-05-01) removed ESP-NOW entirely, eliminating the
~28 mA continuous Wi-Fi cost. The revised targets above are based on
post-Path-B PPK2 baselines and are honest about what the hardware can
actually deliver.

## Path B PPK2 measurements (recorded as captured)

| Scenario                          | Target  | Expected   | Measured   | Notes |
|-----------------------------------|---------|------------|------------|-------|
| Idle, no central                  | ≤35 mA  | 25–35 mA   | **21.36 mA** | 2026-05-01, 4.037 V supply, 10 s window, AGC railed @ 20 mA LED (no finger). Better than expected — light sleep engaging at 83% SLEEP-40M. |
| Dashboard only, LOW_LATENCY       | ≤40 mA  | 35–40 mA   | _pending_  | |
| Glasses only, BATCHED             | ≤30 mA  | 20–30 mA   | _pending_  | |
| Both centrals connected           | ≤50 mA  | 40–50 mA   | _pending_  | |
| Battery life @ dashboard-only, 100 mAh LiPo | — | — | _pending_ | |

**Δ vs Build B baseline (55.92 mA):** −34.56 mA on idle-no-central.
That's the entire ~28 mA Wi-Fi/ESP-NOW cost plus ~6.6 mA from BT modem
sleep + light-sleep engagement that Wi-Fi was previously blocking.

## Do not

- Add OTA logic yet (Stage 08)
- Use deep sleep
- Block in config apply path
- Leave the STUB warning in place

## When done

Report measured current per mode, runtime on 100 mAh battery, apply latency per parameter type, and confirm TODO.md was cleaned up.
