# Pairing & device feedback guide

This is the user-facing reference for "what is the device doing right now?" Covers the earclip's onboard LED, the Edge glasses' lens patterns, button gestures, and how to pair with both the dashboard and the glasses. Written for the simplest case (one earclip, one pair of glasses, one laptop) — read top to bottom and you should be able to pair from cold without asking questions.

## Earclip onboard LED

The orange user LED on the side of the XIAO ESP32-C6 (GPIO15) is the earclip's only user-facing output. The brightness is sine-driven via PWM with gamma correction, so all transitions are smooth — no square-wave flicker.

| Pattern | Meaning |
|---|---|
| **Smooth fade in → brief hold → fade out** (~1.5 s after power-up) | Booting |
| **Continuous breathing**, 1 Hz, ~60 % peak | Advertising — discoverable, not yet streaming |
| **Single soft pulse every 5 s** (~600 ms half-sine, ~30 % peak) | At least one central is subscribed and IBI is flowing |
| **Double pulse every 5 s** (two 250 ms pulses with a 200 ms gap, ~50 % peak) | Battery below ~20 % |
| **Rapid 2 Hz pulse, full brightness, ~10 s** then off | Battery below ~5 % — shutdown imminent. The earclip will quiet down on its own; this is the last warning before it goes dark. |
| **Off** | Deep sleep, unpowered, or no-active-state idle |

If the LED stays off after powering on:
- Check the battery is connected and has charge. Plug into USB-C for 5 minutes.
- If still nothing, the firmware may have crashed mid-boot — connect USB, run `idf.py monitor` to see the boot log.

Priority: battery alerts override BLE state, so a low-battery double-pulse will replace the breathing/streaming pattern until the battery recovers above ~25 %. Once recovered, the LED returns to whichever BLE state is currently true (PAIRING if no peer connected, STREAMING if one is). The red charging LED on the XIAO PMIC is independent and not driven by firmware — it lights automatically while plugged in.

If the LED stays off after powering on:
- Check the battery is connected and has charge. Plug into USB-C for 5 minutes.
- If still nothing, the firmware may have crashed mid-boot — connect USB, run `idf.py monitor` to see the boot log.

## Earclip button (D2 / GPIO2)

There's exactly one gesture today:

| Gesture | What happens |
|---|---|
| Hold ≥ 2 s | Enters deep sleep. The user LED goes off as the chip tears down. Release at any time before 2 s to cancel — there's no visual feedback during the hold. |
| Press once (from deep sleep) | Wakes the chip. The boot fade-in animation lights ~1 s after press. |

There is no "factory reset" or "clear pairing" gesture on the earclip itself. To re-pair to a different host, use the host's "Forget" control (dashboard) or the dashboard's "Re-pair earclip" button (glasses).

## Edge glasses lens patterns

The Edge glasses use the lens opacity itself as their primary indicator. Three patterns are relevant for earclip pairing:

| Pattern | Meaning | Mnemonic |
|---|---|---|
| **5 slow pulses + 3 s clear hold** | Finger detected on Edge's local PulseSensor | `5 = finger on Edge` |
| **3 slow pulses, no hold** | Earclip linked (BLE central reached READY, IBI flowing) | `3 = earclip linked` |
| **2 fast pulses** | Earclip lost (BLE disconnect from earclip) | `2 = earclip lost` |

Other lens patterns (1-pulse boot indicator, breathe waveform, beat pulse, coherence-driven opacity) belong to the active PPG program, not pairing. See the Edge firmware's `main.c` header comments for the full catalog.

The disambiguation matters because before this change the 5-pulse pattern was used for *both* "finger on Edge" and "earclip linked" — visually indistinguishable. The new 3-pulse signature for earclip-link removes the ambiguity.

## Pairing with the dashboard

1. Power the earclip. Confirm the LED is breathing 1 Hz (= advertising).
2. Open the dashboard in Chrome, Edge, or Brave on a desktop or Android device. Web Bluetooth does not work in Firefox or on iOS Safari.
3. Click **Connect Earclip** in the top-right.
4. Pick `Narbis Earclip XXXXXX` from the browser's BLE chooser and click **Pair**.
5. The header pill should go from amber-pulsing → green within 2–3 s. While the handshake is in progress, a sub-line shows the current phase (`waiting for device picker → connecting GATT → discovering services → discovering characteristics → subscribing to notifications → ready`).
6. Once subscribed, the LED switches to a single soft pulse every 5 s (the streaming heartbeat).

### If the chooser doesn't show the earclip

- Confirm the earclip's LED is breathing (= advertising). If it's pulsing once every 5 s, it's already streaming to a central — the slot may still be available (the earclip supports three simultaneous centrals) but the chooser may not list a device that's already connected to the same browser tab. Refresh the page or check the existing connection.
- Confirm Bluetooth is enabled on the host machine.
- On Windows, WinRT sometimes strips 128-bit service UUIDs from advertisements. The dashboard falls back to a name filter (`Narbis Earclip` prefix), so the device should still appear.

### If pairing fails or needs multiple attempts

This used to happen because the dashboard's old "Forget" button only cleared `localStorage` — it didn't release the Web Bluetooth permission, so the browser kept handing back a stale device handle whose cached GATT services no longer matched the running firmware. **Fixed**: the new Forget button calls `device.forget()` which properly clears the browser's permission grant.

If you still hit "Stale BLE cache. Click Forget then Connect" after these changes:
1. Click **Forget** in the header.
2. Verify the earclip is no longer listed at `chrome://settings/content/bluetoothDevices`. (This is the test that proves `device.forget()` ran.)
3. Click **Connect Earclip** again.

If repeatedly broken across devices, file an issue with browser version + OS — `device.forget()` shipped in Chrome 114 (May 2023); older browsers fall back to disconnect-only and will still need the multi-attempt workaround.

## Pairing with the glasses

The glasses' BLE central scans automatically on boot. No explicit pair button.

1. Power the earclip. LED breathes (= advertising).
2. Power the glasses.
3. Wait. First-ever pairing takes up to 30 s (general scan, picks the strongest-RSSI Narbis Earclip in range and saves its MAC to NVS). Subsequent pairings take ~5 s (directed scan against the saved MAC).
4. Successful pair = **3 slow lens pulses on the glasses** + earclip LED switches from breathing to one soft pulse every 5 s.

### Re-pairing to a different earclip

The glasses cache the last earclip's MAC in NVS and will keep doing fast directed scans for it. To force a rescan:

1. Connect the dashboard to the glasses.
2. Click **Re-pair earclip** in the header.
3. Confirm the prompt. The glasses drop their saved MAC, the relay badge in the header goes amber (`scanning earclip…`), and the next discoverable Narbis Earclip in range pairs.

### If the glasses won't pair

- Confirm both devices are powered. Earclip LED breathing, glasses powered (lens active).
- Confirm the earclip isn't already saturated with three centrals (dashboard + glasses + debug slot).
- Click "Re-pair earclip" from the dashboard, then power-cycle the glasses to clear any stuck central state.
- If the glasses repeatedly time out their general scan, the earclip may not be advertising. Check the earclip LED — if it's not breathing, pairing won't work no matter what the glasses do.

## Putting it all together — happy path

Ear off, both devices powered:
- Earclip LED: breathing 1 Hz (advertising)
- Glasses lenses: active program (breathe / heartbeat / coherence)

Glasses pair with earclip (within ~30 s of glasses boot):
- Earclip LED: switches to one soft pulse every 5 s (streaming)
- Glasses lenses: 3 slow pulses then resume program

Dashboard joins (clicked Connect Earclip):
- Earclip LED: stays at one pulse every 5 s (streaming — same state, two centrals)
- Dashboard pill: green, "Earclip: Narbis Earclip XXXXXX · 4.05 V · 78 %"
- Dashboard Edge pill: green with "⇄ Earclip linked" relay badge

Battery drops below ~20 %:
- Earclip LED: double pulse every 5 s (overrides streaming heartbeat)
- Plug into USB-C; once SoC recovers above ~25 % the LED returns to streaming.

Press earclip button for 2 s:
- Earclip LED: goes off as the chip tears down
- Both lenses do "2 fast pulses" (earclip lost)
- Dashboard goes amber, relay badge goes amber
- Earclip enters deep sleep — LED off

Press button again to wake. Cycle repeats from boot fade-in.
