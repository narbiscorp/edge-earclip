#ifndef NARBIS_BLE_SERVICE_DIS_H
#define NARBIS_BLE_SERVICE_DIS_H

#include "esp_err.h"

#include "host/ble_gatt.h"

#ifdef __cplusplus
extern "C" {
#endif

esp_err_t ble_service_dis_init(void);
esp_err_t ble_service_dis_deinit(void);

/* Returns a NULL-terminated array of GATT service definitions to be passed
 * to ble_gatts_count_cfg / ble_gatts_add_svcs. */
const struct ble_gatt_svc_def *ble_service_dis_svc_defs(void);

/* Called from transport_ble's gatts_register_cb so DIS can cache any
 * value handles it cares about. DIS exposes only static reads so this
 * is a no-op today, but the hook is kept for symmetry. */
void ble_service_dis_on_register(struct ble_gatt_register_ctxt *ctxt);

#ifdef __cplusplus
}
#endif

#endif /* NARBIS_BLE_SERVICE_DIS_H */
