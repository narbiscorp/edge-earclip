# Stage 04 — Firmware: Channel/AGC/Elgendi/Validator

## Task

Implement the DSP pipeline: channel selection, DC removal, AGC, bandpass filter, Elgendi peak detection, IBI validation.

## Prerequisites

Stage 03 complete. Driver streams raw samples.

## What to build

1. **`firmware/components/ppg_channel/`**:
   - Public API: select channel (RED/IR/GREEN/AUTO), enable/disable AGC, set AGC target
   - Receives raw samples, emits processed samples (`ppg_processed_sample_t`)
   - DC baseline tracking via single-pole IIR (~5 sec time constant default)
   - AGC adjusts LED current when DC drifts out of target range (rate-limited, max 1 adjustment per 2 seconds)
   - Saturation flag when raw sample is at ADC max
   - All math in fixed-point (no FP in hot path)

2. **`firmware/components/elgendi/`**:
   - Bandpass: 2nd-order Butterworth biquad, 0.5–8 Hz default, configurable
   - Pre-compute coefficients at init, store as `static const`
   - Direct Form II Transposed for stability
   - Q-format fixed-point throughout (document the format)
   - Elgendi algorithm: square signal → MA_W1 (~111ms) and MA_W2 (~667ms) → block detection where MA_W1 > MA_W2 + alpha*RMS → local max within block = peak
   - Refractory period (300 ms default)
   - Output: beat_event_t with timestamp and IBI

3. **`firmware/components/beat_validator/`**:
   - Plausibility: 300ms < IBI < 2000ms
   - Continuity: |IBI - running_median| < continuity_pct * running_median
   - Running median over last 10 IBIs
   - Always emit — flag artifacts via `is_artifact`, don't drop

4. **Wire up in `firmware/main/main.c`**:
   - Driver → Channel → Elgendi → Validator
   - Final callback: `ESP_LOGI` each beat with IBI, BPM, artifact flag

## Implementation notes

- Filter coefficient design: use scipy.signal in Python to compute Butterworth biquad coefficients, paste as comments + const arrays
- Test signal: `firmware/main/test_inject.c` — inject synthetic 1Hz sine wave, verify beats at 1-second intervals

## Success criteria

- Wearing the earclip produces beats at your actual heart rate ±2 BPM
- IBI values reasonable (700-1100ms at rest)
- Artifacts flagged during deliberate motion but still emitted
- 30+ minute run with no crashes
- CPU load under 5% (verify with `vTaskGetRunTimeStats`)

## Do not

- Add transport yet (Stage 05)
- Use FP in `process_sample` hot path
- Use a different algorithm than Elgendi

## When done

Report beat detection accuracy vs wrist pulse count, IBI variability range, CPU usage.
