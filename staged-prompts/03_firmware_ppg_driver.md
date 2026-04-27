# Stage 03 — Firmware: PPG sensor driver

## Task

Implement the MAX30102 / MAX30101 driver. Auto-detect chip, configure FIFO, read samples on interrupt, expose clean API to upper layers.

## Prerequisites

Stage 02 complete. Project compiles. Hardware: at least one MAX30102 or MAX30101 board wired up.

## Hardware wiring

- VIN → 3V3 (NOT 5V)
- GND → GND
- SDA → D4 (GPIO22)
- SCL → D5 (GPIO23)
- INT → D0 (GPIO0)

## What to build

1. **`firmware/components/ppg_driver_max3010x/max3010x_regs.h`** — register map for both chips. Comments noting which registers exist on which chip.

2. **`firmware/components/ppg_driver_max3010x/max3010x_driver.h`** — public API:
   - `esp_err_t ppg_driver_init(const ppg_driver_config_t *cfg)` — init I2C, detect chip, configure FIFO
   - `ppg_chip_type_t ppg_driver_get_chip_type(void)` — MAX30102 or MAX30101
   - `esp_err_t ppg_driver_set_led_current(ppg_led_t led, uint8_t milliamps)` — for AGC
   - `esp_err_t ppg_driver_set_sample_rate(uint16_t hz)`
   - `esp_err_t ppg_driver_register_sample_callback(ppg_sample_callback_t cb)`
   - Sample struct: `{timestamp_us, red, ir, green, channels_active}`

3. **`firmware/components/ppg_driver_max3010x/max3010x_driver.c`**:
   - I2C init at 400 kHz, address 0x57
   - GPIO interrupt setup on INT pin (GPIO0), FreeRTOS semaphore-based dispatch
   - Chip detection via Part ID register (0xFF) and Revision ID (0xFE) — handle the case where Part ID is the same and use revision or feature probe
   - FIFO configuration: SpO2 mode (red+IR) for both chips, optionally green for MAX30101
   - FIFO read in dedicated FreeRTOS task triggered by IRQ semaphore
   - Per-sample timestamp via `esp_timer_get_time()` at IRQ time, back-computed for samples in the burst
   - LED current control via LED1_PA, LED2_PA, LED3_PA registers
   - Pulse width (411µs default for 18-bit) and ADC range configuration

4. **Update `firmware/main/main.c`** to wire up the driver:
   - Init driver with default config (200 Hz, IR channel, 7 mA LED currents)
   - Register a callback that ESP_LOGIs the first 10 samples then stops
   - Verify chip detection log message
   - Verify samples flow at 200 Hz (check timestamp deltas)

## Implementation notes

- Sample data is 18 bits per channel (in 18-bit mode), packed 3 bytes per channel in FIFO
- IRQ handler is short — `xSemaphoreGiveFromISR()` only. Real work in dispatch task.
- FIFO read should be a single I2C burst transfer
- Don't use floating point in the driver

## Success criteria

- Boot logs show: chip type detected (MAX30102 or MAX30101), default config loaded, samples flowing
- Sample rate matches configuration (timestamp deltas ~5ms at 200 Hz)
- LED current changes are visible (raw DC level changes when LED current changes)
- 1-hour run with no memory leaks
- No watchdog resets

## Do not

- Add Elgendi or DSP yet (Stage 04)
- Add transport code yet
- Block in IRQ handler

## When done

Report:
- Both chips detected correctly (if you have both)
- Sample rate accuracy
- Memory usage of the driver component
