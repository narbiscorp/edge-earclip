# Stage 08 — Firmware: OTA via Nordic-style DFU

## Task

Port Nordic-style DFU OTA from existing Edge firmware to earclip. Same protocol, same webapp.

## Prerequisites

Stages 02-07 complete. All other functionality works.

## Read first

- `CLAUDE.md`
- The existing Edge firmware OTA implementation (point Claude Code at the Edge repo as additional context)
- The existing OTA webapp HTML

## What to build

1. **`firmware/main/ble_ota.c/h`** — Nordic DFU protocol:
   - DFU service UUID matching Edge
   - Control point characteristic (write+notify) for command/response
   - Packet characteristic (write without response) for firmware data
   - State machine: IDLE → STARTING → RECEIVING → VALIDATING → APPLYING → DONE/FAILED
   - Same opcodes as Edge (verify by reading Edge code)
   - Receive firmware in chunks, write to inactive OTA partition via `esp_ota_write()`
   - Verify image integrity per protocol
   - On VALIDATE success: set boot partition, request reboot
   - Rollback support: new firmware doesn't mark valid until self-test passes

2. **Power gate** — refuse OTA below 30% battery:
   - Hook into `power_mgmt` battery monitor
   - Return DFU error code
   - Log message

3. **Validity self-test in main.c**:
   - On boot, if running from OTA slot and not yet marked valid:
     - Wait for BLE up
     - Wait for first BLE client connection (60s timeout)
     - On successful connect: `esp_ota_mark_app_valid_cancel_rollback()`
     - On timeout: do nothing — bootloader rolls back

4. **Verify partition table** has dual app slots + factory + nvs + ota_data (Stage 02 should have set this up).

## Implementation notes

- Don't reinvent — port Edge protocol verbatim
- Use `esp_ota_get_next_update_partition()` to find inactive slot
- Verify firmware image is for ESP32-C6 (header check) — refuse if wrong chip
- Don't accept OTA in OTA_UPDATING mode (prevent re-entry)
- Set transport mode to OTA_UPDATING during update (disables ESP-NOW)

## Success criteria

- Existing OTA webapp (extended for earclip in Stage 15) updates firmware end-to-end
- Power loss during OTA → bootloader recovers to previous slot
- Bad firmware crashes on boot → rolls back automatically within 60 seconds
- Update <60 seconds for ~1 MB image
- Battery gate works (refuses OTA when low)

## Validation

1. Build firmware v1, flash via USB
2. Build firmware v2 with visible change
3. OTA update v1 → v2 via webapp
4. Verify new firmware running
5. Test rollback: build v3 that crashes on boot, attempt OTA, verify rollback
6. Test battery gate: drain to 25%, attempt OTA, verify rejection

## When done

Report OTA success rate, duration, rollback behavior, any incompatibilities with Edge implementation (should be zero).
