idf_component_register(
    SRCS         "ppg_channel.c"
    INCLUDE_DIRS "include"
    REQUIRES     narbis_protocol ppg_driver_max3010x esp_timer
)
