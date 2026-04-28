# firmware/test — bring-up fixtures

Standalone ESP-IDF projects used to validate the earclip's transports against
a real second device. Not part of the earclip build.

## espnow_receiver_fixture

Minimal ESP-NOW receiver. Flash onto any ESP32 (any variant — the default
target is `esp32`). Receives Narbis frames, deserializes via the shared
`narbis_protocol` component, and prints them.

### Build & flash

```bash
cd firmware/test/espnow_receiver_fixture
idf.py set-target esp32          # or esp32c3 / esp32s3 / esp32c6
idf.py -p <RX_PORT> flash monitor
```

On boot you'll see:

```
I (1234) rx: ready  ch=1  my MAC: 24:6f:28:aa:bb:cc
```

Note the MAC — that's what the earclip needs to be paired to.

### Pair the earclip with the receiver

There are two paths to set the partner MAC.

**Build-time (Kconfig fallback)** — used on a fresh device with no NVS pairing:

```bash
cd firmware
idf.py menuconfig
#   → Narbis earclip
#   → "Hardcoded ESP-NOW partner MAC": 24:6F:28:AA:BB:CC
idf.py set-target esp32c6
idf.py -p <TX_PORT> build flash monitor
```

The earclip's boot log will then read:

```
I (...) transport_espnow: peer added 24:6f:28:aa:bb:cc ch=1 src=kconfig
I (...) narbis: wifi MAC <earclip wifi mac>
I (...) narbis: ble  MAC <earclip ble mac>
I (...) narbis: partner  24:6f:28:aa:bb:cc  src=kconfig
```

**Runtime (NVS)** — used once the dashboard pairs the device for real
(Stage 09 wires this into the BLE config-write characteristic). Until the
dashboard exists, you can pre-seat NVS via the `nvs_partition_gen.py` flow
or by calling `transport_espnow_set_partner()` from a debug build hook. On
subsequent boots the log will read `src=nvs`.

To clear an NVS pairing and fall back to the Kconfig MAC:

```bash
cd firmware
idf.py -p <TX_PORT> erase-flash
idf.py -p <TX_PORT> flash monitor
```

### Expected output

Earclip side, once pairing is established and PPG signal is good:

```
I (...) narbis: beat ts=12345 ibi=850 prev=842 bpm=70.5 conf=92 flags=0x00 amp=4321
```

Receiver side:

```
I (...) rx: IBI       seq=42 ts=12345  ibi=850 ms  conf=92  flags=0x00
```

A `BATTERY` line lands every 30 s with the placeholder values from
`power_mgmt_get_battery()` (4000 mV / 80% / not charging) until Stage 06
wires real ADC reads.

### Channel mismatch

If the receiver shows nothing despite the earclip claiming sends are
queued, double-check both sides are on the same Wi-Fi channel. The
receiver hardcodes channel 1 (`RX_CHANNEL` in `main/main.c`); the earclip
uses `CONFIG_NARBIS_ESPNOW_CHANNEL` (default 1). If you change one, change
the other.
