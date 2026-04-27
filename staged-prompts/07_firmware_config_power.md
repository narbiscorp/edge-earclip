# Stage 07 — Firmware: Config persistence, mode controller, power management

## Task

Runtime config system, mode state machine, light sleep integration, battery monitoring.

## Prerequisites

Stage 06 complete. ESP-NOW and BLE both work.

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
   - States: BOOT, IDLE, EDGE_ONLY, HYBRID, OTA_UPDATING
   - Transitions on config write, OTA start/complete
   - Clean transport switching on transition
   - Persist last-active mode in NVS

3. **`firmware/main/power_mgmt.c/h`**:
   - Configure light sleep allowed during idle
   - `esp_pm_configure()` with appropriate config
   - PM locks to prevent sleep during BLE notification bursts
   - Battery monitoring task (10-second interval):
     - Read battery voltage via ADC
     - Compute SOC% from LiPo discharge curve (lookup table)
     - Update battery service
     - Low-battery warning at 15%
     - Hook for OTA refusal below 30%

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
- Battery curve: 4.2V=100%, 3.7V=50%, 3.4V=5% — lookup table with linear interpolation
- Apply functions must be thread-safe (config write from BLE task, applied by other tasks)

## Success criteria

- Config writes from BLE take effect within 1 second
- Power cycle → last-active mode and config restored
- Battery percentage tracks accurately
- Light sleep happens — average current drops vs Stage 06
- Power targets:
  - EDGE_ONLY: ≤9 mA average
  - HYBRID + BATCHED: ≤11 mA
  - HYBRID + LOW_LATENCY + RAW_PPG: ≤13 mA
- Mode transitions don't lose beats

## Do not

- Add OTA logic yet (Stage 08)
- Use deep sleep
- Block in config apply path

## When done

Report measured current per mode, runtime on 100 mAh battery, apply latency per parameter type.
