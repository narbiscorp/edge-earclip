idf_component_register(
    SRCS "led_status.c"
    INCLUDE_DIRS "include"
    REQUIRES driver esp_timer
)
