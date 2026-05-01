idf_component_register(
    SRCS
        "main.c"
    INCLUDE_DIRS "."
    REQUIRES
        nvs_flash
        esp_timer
        esp_pm
        esp_adc
        bt
        esp_app_format
        app_update
        esp_partition
        bootloader_support
        driver
        narbis_protocol
        narbis_ble_central
)
