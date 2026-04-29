idf_component_register(
    SRCS         "narbis_esp_now_rx.c"
    INCLUDE_DIRS "include"
    REQUIRES     narbis_protocol esp_wifi esp_now esp_event esp_netif nvs_flash freertos
)
