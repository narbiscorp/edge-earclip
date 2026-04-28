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
