/*
 * ble_ota.c — Nordic-style DFU port from Edge firmware.
 *
 * Wire protocol (verbatim from Edge — see staged-prompts/08_firmware_ota.md):
 *
 *   Service 0x00FF
 *     0xFF01 Control (read+write)   2-byte commands [op, param]
 *     0xFF02 Data    (write+WoR)    raw firmware bytes, 4 KB pages
 *     0xFF03 Status  (notify)       result frames, 3..7 bytes
 *
 *   Opcodes:  0xA8 START, 0xA9 FINISH, 0xAA CANCEL,
 *             0xAD PAGE_CONFIRM (param 0x01 commit / 0x00 resend)
 *
 *   Status:   0x01 READY, 0x03 SUCCESS, 0x04 ERROR, 0x05 CANCELLED,
 *             0x06 PAGE_CRC, 0x07 PAGE_OK, 0x08 PAGE_RESEND
 *
 * Earclip safety additions (not in Edge):
 *   - 30 % battery gate via power_mgmt_can_ota()         → ERR_LOW_BATTERY (0x06)
 *   - ESP32-C6 chip-id check on the image header         → ERR_CHIP_MISMATCH (0x07)
 *   - Re-entry guard (refuse START during active OTA)    → ERR_ALREADY_IN_OTA (0x08)
 *   - First-connect rollback validity self-test on boot
 *
 * Concurrency:
 *   - Slow IDF calls (esp_ota_begin/end/abort, set_boot_partition) run on
 *     a dedicated task fed via xQueue. BLE callbacks return immediately.
 *   - Page commits (PAGE_CONFIRM 0x01 → esp_ota_write) run inline in the
 *     BLE callback — same as Edge. Webapp uses WriteWithResponse for that
 *     opcode so flow control absorbs the ~tens-of-ms flash write.
 *   - All shared state is guarded by a single FreeRTOS mutex.
 */

#include "ble_ota.h"

#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#include "esp_app_format.h"
#include "esp_chip_info.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_rom_crc.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "host/ble_gatt.h"
#include "host/ble_hs_mbuf.h"
#include "host/ble_uuid.h"
#include "os/os_mbuf.h"
#include "sdkconfig.h"

#include "app_state.h"
#include "narbis_protocol.h"
#include "power_mgmt.h"
#include "transport_ble.h"

static const char *TAG = "ble_ota";

/* ============================================================================
 * Tunables (see also Kconfig.projbuild "OTA")
 * ========================================================================= */

#ifndef CONFIG_NARBIS_OTA_VALIDITY_TIMEOUT_S
#define CONFIG_NARBIS_OTA_VALIDITY_TIMEOUT_S 60
#endif

#define OTA_TASK_STACK_BYTES 4096
#define OTA_TASK_PRIORITY    (tskIDLE_PRIORITY + 4)
#define OTA_QUEUE_DEPTH      4

#define VALIDITY_TASK_STACK_BYTES 3072
#define VALIDITY_TASK_PRIORITY    (tskIDLE_PRIORITY + 2)

#define ESP_IMAGE_HEADER_BYTES 24u  /* esp_image_header_t */
#define ESP_IMAGE_CHIP_ID_OFF  12u  /* offset of chip_id field within header */
#define ESP_CHIP_ID_ESP32C6_VAL ESP_CHIP_ID_ESP32C6  /* IDF: 0x000D */

/* ============================================================================
 * UUIDs
 * ========================================================================= */

static const ble_uuid16_t SVC_UUID     = BLE_UUID16_INIT(NARBIS_OTA_SVC_UUID16);
static const ble_uuid16_t CHR_CTRL_UUID = BLE_UUID16_INIT(NARBIS_OTA_CHR_CONTROL_UUID16);
static const ble_uuid16_t CHR_DATA_UUID = BLE_UUID16_INIT(NARBIS_OTA_CHR_DATA_UUID16);
static const ble_uuid16_t CHR_STAT_UUID = BLE_UUID16_INIT(NARBIS_OTA_CHR_STATUS_UUID16);

/* ============================================================================
 * State
 * ========================================================================= */

typedef enum {
    OTA_TASK_BEGIN = 1,
    OTA_TASK_FINISH,
    OTA_TASK_CANCEL,
} ota_task_cmd_t;

static SemaphoreHandle_t s_mtx;
static QueueHandle_t     s_cmd_q;
static TaskHandle_t      s_ota_task;

/* GATT value handles — Status is the only one we need for notify. */
static uint16_t s_h_ctrl;
static uint16_t s_h_data;
static uint16_t s_h_stat;

/* OTA session state — accessed from BLE callbacks AND the OTA task,
 * always under s_mtx. */
static bool                  s_in_ota_mode;
static esp_ota_handle_t      s_ota_handle;
static const esp_partition_t *s_ota_part;
static uint8_t              *s_page_buf;       /* 4096 B, heap-allocated per session */
static size_t                s_page_offset;
static uint16_t              s_page_num;
static bool                  s_page_pending;   /* true while waiting for PAGE_CONFIRM */
static size_t                s_bytes_written;
static bool                  s_image_header_validated;

/* ============================================================================
 * Status notify helpers
 *
 * Notifications are 3..7 bytes. We acquire the BLE-active pm_lock around
 * the submit — same pattern as transport_ble_notify().
 * ========================================================================= */

static int notify_status(const uint8_t *frame, uint16_t len)
{
    uint16_t conn = transport_ble_get_conn_handle();
    if (conn == 0xFFFF || s_h_stat == 0) {
        /* Either no central connected or service not yet registered.
         * Frames are advisory — drop silently. */
        return 0;
    }
    struct os_mbuf *om = ble_hs_mbuf_from_flat(frame, len);
    if (om == NULL) return -1;
    power_mgmt_acquire_ble_active();
    int rc = ble_gatts_notify_custom(conn, s_h_stat, om);
    power_mgmt_release_ble_active();
    if (rc != 0) {
        ESP_LOGD(TAG, "notify rc=%d len=%u", rc, len);
    }
    return rc;
}

static void notify_simple4(uint8_t code)
{
    uint8_t f[4] = { code, 0, 0, 0 };
    (void)notify_status(f, sizeof(f));
}

static void notify_error(uint8_t err_code)
{
    uint8_t f[4] = { NARBIS_OTA_ST_ERROR, err_code, 0, 0 };
    (void)notify_status(f, sizeof(f));
    ESP_LOGW(TAG, "ERROR 0x%02x", err_code);
}

static void notify_page_event(uint8_t code, uint16_t page)
{
    uint8_t f[3] = { code, (uint8_t)(page >> 8), (uint8_t)(page & 0xFF) };
    (void)notify_status(f, sizeof(f));
}

static void notify_page_crc(uint16_t page, uint32_t crc_le)
{
    uint8_t f[7] = {
        NARBIS_OTA_ST_PAGE_CRC,
        (uint8_t)(page >> 8), (uint8_t)(page & 0xFF),
        /* CRC is little-endian on the wire — matches webapp's
         * DataView.getUint32(off, true) parse. */
        (uint8_t)(crc_le & 0xFF),
        (uint8_t)((crc_le >> 8) & 0xFF),
        (uint8_t)((crc_le >> 16) & 0xFF),
        (uint8_t)((crc_le >> 24) & 0xFF),
    };
    (void)notify_status(f, sizeof(f));
}

/* ============================================================================
 * Session lifecycle (called only from the OTA task)
 * ========================================================================= */

static void session_reset_locked(void)
{
    s_in_ota_mode  = false;
    s_ota_handle   = 0;
    s_ota_part     = NULL;
    s_page_offset  = 0;
    s_page_num     = 0;
    s_page_pending = false;
    s_bytes_written = 0;
    s_image_header_validated = false;
    if (s_page_buf) {
        free(s_page_buf);
        s_page_buf = NULL;
    }
}

static void task_begin(void)
{
    xSemaphoreTake(s_mtx, portMAX_DELAY);
    bool already = s_in_ota_mode;
    xSemaphoreGive(s_mtx);

    if (already) {
        notify_error(NARBIS_OTA_ERR_ALREADY_IN_OTA);
        return;
    }

    /* Battery gate. With the divider stub (NARBIS_BATT_DIVIDER_PRESENT=n)
     * this returns true (stub SoC = 80%). Once the hardware mod is in,
     * it gates real readings at 30%. */
    if (!power_mgmt_can_ota()) {
        notify_error(NARBIS_OTA_ERR_LOW_BATTERY);
        return;
    }

    const esp_partition_t *part = esp_ota_get_next_update_partition(NULL);
    if (part == NULL) {
        notify_error(NARBIS_OTA_ERR_NO_PARTITION);
        return;
    }

    uint8_t *buf = malloc(NARBIS_OTA_PAGE_SIZE);
    if (buf == NULL) {
        ESP_LOGE(TAG, "page_buf malloc failed");
        notify_error(NARBIS_OTA_ERR_BEGIN);
        return;
    }

    esp_ota_handle_t handle = 0;
    esp_err_t err = esp_ota_begin(part, OTA_SIZE_UNKNOWN, &handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_ota_begin: %s", esp_err_to_name(err));
        free(buf);
        notify_error(NARBIS_OTA_ERR_BEGIN);
        return;
    }

    /* Suspends mode-change requests, kills ESP-NOW sends. */
    (void)app_state_notify_ota_started();

    xSemaphoreTake(s_mtx, portMAX_DELAY);
    s_ota_handle    = handle;
    s_ota_part      = part;
    s_page_buf      = buf;
    s_page_offset   = 0;
    s_page_num      = 0;
    s_page_pending  = false;
    s_bytes_written = 0;
    s_image_header_validated = false;
    s_in_ota_mode   = true;
    xSemaphoreGive(s_mtx);

    ESP_LOGI(TAG, "BEGIN: target=%s subtype=0x%02x size=%lu",
             part->label, part->subtype, (unsigned long)part->size);
    notify_simple4(NARBIS_OTA_ST_READY);
}

static void task_finish(void)
{
    xSemaphoreTake(s_mtx, portMAX_DELAY);
    bool active = s_in_ota_mode;
    esp_ota_handle_t handle = s_ota_handle;
    const esp_partition_t *part = s_ota_part;
    /* Snapshot the partial-tail state, then drain it under the lock. */
    size_t   tail_len   = (s_page_pending ? 0 : s_page_offset);
    uint8_t *tail_buf   = (tail_len > 0) ? s_page_buf : NULL;
    bool     tail_taken = false;
    if (tail_len > 0) {
        /* Caller will write the tail outside the lock (flash write is
         * slow). Move ownership — clear the page slot so the cancel path
         * does not double-free if it fires. */
        tail_taken = true;
    }
    xSemaphoreGive(s_mtx);

    if (!active) {
        notify_error(NARBIS_OTA_ERR_NOT_IN_OTA);
        return;
    }

    if (tail_taken) {
        esp_err_t werr = esp_ota_write(handle, tail_buf, tail_len);
        if (werr != ESP_OK) {
            ESP_LOGE(TAG, "tail write: %s", esp_err_to_name(werr));
            (void)esp_ota_abort(handle);
            xSemaphoreTake(s_mtx, portMAX_DELAY);
            session_reset_locked();
            xSemaphoreGive(s_mtx);
            (void)app_state_notify_ota_complete(ESP_FAIL);
            notify_error(NARBIS_OTA_ERR_WRITE);
            return;
        }
    }

    esp_err_t err = esp_ota_end(handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_ota_end: %s", esp_err_to_name(err));
        xSemaphoreTake(s_mtx, portMAX_DELAY);
        session_reset_locked();
        xSemaphoreGive(s_mtx);
        (void)app_state_notify_ota_complete(ESP_FAIL);
        notify_error(NARBIS_OTA_ERR_END);
        return;
    }

    err = esp_ota_set_boot_partition(part);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "set_boot_partition: %s", esp_err_to_name(err));
        xSemaphoreTake(s_mtx, portMAX_DELAY);
        session_reset_locked();
        xSemaphoreGive(s_mtx);
        (void)app_state_notify_ota_complete(ESP_FAIL);
        notify_error(NARBIS_OTA_ERR_END);
        return;
    }

    ESP_LOGI(TAG, "SUCCESS — rebooting in 500 ms (target=%s)", part->label);
    notify_simple4(NARBIS_OTA_ST_SUCCESS);
    (void)app_state_notify_ota_complete(ESP_OK);

    /* Give NimBLE time to ship the SUCCESS notification before we drop
     * the radio. Edge waits 500 ms here too. */
    vTaskDelay(pdMS_TO_TICKS(500));
    esp_restart();
}

static void task_cancel(void)
{
    xSemaphoreTake(s_mtx, portMAX_DELAY);
    bool active = s_in_ota_mode;
    esp_ota_handle_t handle = s_ota_handle;
    if (active) {
        session_reset_locked();
    }
    xSemaphoreGive(s_mtx);

    if (active) {
        (void)esp_ota_abort(handle);
        (void)app_state_notify_ota_complete(ESP_FAIL);
        ESP_LOGI(TAG, "CANCELLED");
    }
    notify_simple4(NARBIS_OTA_ST_CANCELLED);
}

static void ota_task(void *arg)
{
    (void)arg;
    for (;;) {
        ota_task_cmd_t cmd;
        if (xQueueReceive(s_cmd_q, &cmd, portMAX_DELAY) != pdTRUE) continue;
        switch (cmd) {
        case OTA_TASK_BEGIN:  task_begin();  break;
        case OTA_TASK_FINISH: task_finish(); break;
        case OTA_TASK_CANCEL: task_cancel(); break;
        }
    }
}

/* ============================================================================
 * GATT access callbacks
 * ========================================================================= */

static int read_om_to_bytes(struct os_mbuf *om, uint8_t *out, size_t max_len, uint16_t *out_len)
{
    uint16_t len = OS_MBUF_PKTLEN(om);
    if (len > max_len) return -1;
    int rc = ble_hs_mbuf_to_flat(om, out, max_len, &len);
    if (rc != 0) return -1;
    *out_len = len;
    return 0;
}

/* Inline page commit / resend — runs from the BLE host thread. Edge does
 * the same; webapp uses WriteWithResponse for PAGE_CONFIRM so its flow
 * control absorbs the flash write latency. */
static int handle_page_confirm(uint8_t param)
{
    xSemaphoreTake(s_mtx, portMAX_DELAY);

    if (!s_in_ota_mode || !s_page_pending) {
        uint16_t page = s_page_num;
        xSemaphoreGive(s_mtx);
        notify_page_event(NARBIS_OTA_ST_PAGE_RESEND, page);
        return 0;
    }

    esp_ota_handle_t handle = s_ota_handle;
    uint16_t page    = s_page_num;
    size_t   page_sz = s_page_offset;
    uint8_t *buf     = s_page_buf;
    bool commit      = (param == 0x01);

    /* Clear pending state up-front so a duplicate PAGE_CONFIRM can't
     * double-write. The actual flash write happens below, outside the
     * lock so we don't block other GATT ops. */
    s_page_pending = false;
    s_page_offset  = 0;
    if (commit) {
        s_page_num++;
    }
    xSemaphoreGive(s_mtx);

    if (commit) {
        esp_err_t err = esp_ota_write(handle, buf, page_sz);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "esp_ota_write page=%u: %s", page, esp_err_to_name(err));
            /* Drop the session — host will see an ERROR notification. */
            xQueueSend(s_cmd_q, &(ota_task_cmd_t){OTA_TASK_CANCEL}, 0);
            notify_error(NARBIS_OTA_ERR_WRITE);
            return 0;
        }
        xSemaphoreTake(s_mtx, portMAX_DELAY);
        s_bytes_written += page_sz;
        xSemaphoreGive(s_mtx);
        notify_page_event(NARBIS_OTA_ST_PAGE_OK, page);
    } else {
        notify_page_event(NARBIS_OTA_ST_PAGE_RESEND, page);
    }
    return 0;
}

static int access_control(uint16_t conn_handle, uint16_t attr_handle,
                          struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn_handle; (void)attr_handle; (void)arg;

    if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        /* Edge defines a readable status byte here. Mirror it: 0x01 if
         * a session is active, else 0x00. */
        uint8_t v = 0;
        xSemaphoreTake(s_mtx, portMAX_DELAY);
        v = s_in_ota_mode ? 0x01 : 0x00;
        xSemaphoreGive(s_mtx);
        int rc = os_mbuf_append(ctxt->om, &v, 1);
        return rc == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) {
        return BLE_ATT_ERR_REQ_NOT_SUPPORTED;
    }

    uint8_t buf[2];
    uint16_t len = 0;
    if (read_om_to_bytes(ctxt->om, buf, sizeof(buf), &len) != 0 || len != 2) {
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }
    uint8_t op = buf[0];
    uint8_t param = buf[1];

    switch (op) {
    case NARBIS_OTA_OP_START: {
        ota_task_cmd_t cmd = OTA_TASK_BEGIN;
        if (xQueueSend(s_cmd_q, &cmd, 0) != pdTRUE) {
            ESP_LOGW(TAG, "queue full on START");
            return BLE_ATT_ERR_UNLIKELY;
        }
        return 0;
    }
    case NARBIS_OTA_OP_FINISH: {
        ota_task_cmd_t cmd = OTA_TASK_FINISH;
        if (xQueueSend(s_cmd_q, &cmd, 0) != pdTRUE) {
            ESP_LOGW(TAG, "queue full on FINISH");
            return BLE_ATT_ERR_UNLIKELY;
        }
        return 0;
    }
    case NARBIS_OTA_OP_CANCEL: {
        ota_task_cmd_t cmd = OTA_TASK_CANCEL;
        if (xQueueSend(s_cmd_q, &cmd, 0) != pdTRUE) {
            ESP_LOGW(TAG, "queue full on CANCEL");
            return BLE_ATT_ERR_UNLIKELY;
        }
        return 0;
    }
    case NARBIS_OTA_OP_PAGE_CONFIRM:
        return handle_page_confirm(param);
    default:
        ESP_LOGW(TAG, "unknown opcode 0x%02x", op);
        return BLE_ATT_ERR_VALUE_NOT_ALLOWED;
    }
}

/* Verifies the chip-id field of the ESP-IDF firmware image header.
 * Called after the first ESP_IMAGE_HEADER_BYTES bytes are buffered. */
static bool verify_chip_id(const uint8_t *page_buf)
{
    /* esp_image_header_t layout:
     *   uint8_t magic;       // 0xE9
     *   uint8_t segment_count;
     *   uint8_t spi_mode;
     *   uint8_t spi_speed:4; spi_size:4;
     *   uint32_t entry_addr;
     *   uint8_t wp_pin;
     *   uint8_t spi_pin_drv[3];
     *   uint16_t chip_id;    // offset 12 (ESP_CHIP_ID_ESP32C6 = 0x000D)
     *   ...
     */
    if (page_buf[0] != ESP_IMAGE_HEADER_MAGIC) {
        ESP_LOGE(TAG, "image magic 0x%02x != 0xE9", page_buf[0]);
        return false;
    }
    uint16_t chip_id = (uint16_t)page_buf[ESP_IMAGE_CHIP_ID_OFF] |
                       ((uint16_t)page_buf[ESP_IMAGE_CHIP_ID_OFF + 1] << 8);
    if (chip_id != ESP_CHIP_ID_ESP32C6_VAL) {
        ESP_LOGE(TAG, "chip_id 0x%04x != ESP32-C6 (0x%04x)",
                 chip_id, (unsigned)ESP_CHIP_ID_ESP32C6_VAL);
        return false;
    }
    return true;
}

static int access_data(uint16_t conn_handle, uint16_t attr_handle,
                       struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn_handle; (void)attr_handle; (void)arg;

    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) {
        return BLE_ATT_ERR_REQ_NOT_SUPPORTED;
    }

    /* Pull the chunk out before grabbing the lock. Edge sized chunks at
     * 244 B; we accept anything up to one page. */
    uint8_t  chunk[NARBIS_OTA_PAGE_SIZE];
    uint16_t chunk_len = 0;
    if (read_om_to_bytes(ctxt->om, chunk, sizeof(chunk), &chunk_len) != 0
        || chunk_len == 0) {
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }

    bool   need_chip_check     = false;
    bool   need_page_complete  = false;
    uint16_t completed_page    = 0;
    uint32_t completed_crc     = 0;

    xSemaphoreTake(s_mtx, portMAX_DELAY);
    if (!s_in_ota_mode) {
        xSemaphoreGive(s_mtx);
        notify_error(NARBIS_OTA_ERR_NOT_IN_OTA);
        /* Edge replies success at the GATT layer here so the host's
         * WriteWithoutResponse pipe doesn't choke — the error is signalled
         * only on the status notify. Mirror that. */
        return 0;
    }
    if (s_page_pending) {
        /* Host shouldn't be sending data while a page is awaiting confirm.
         * Drop silently — host's per-page timeout will fire if it stalls. */
        xSemaphoreGive(s_mtx);
        return 0;
    }

    size_t avail = NARBIS_OTA_PAGE_SIZE - s_page_offset;
    if (chunk_len > avail) {
        /* Should never happen if host respects PAGE_SIZE. Truncate to fit
         * rather than overwrite the buffer. */
        chunk_len = (uint16_t)avail;
    }
    memcpy(s_page_buf + s_page_offset, chunk, chunk_len);
    s_page_offset += chunk_len;

    if (!s_image_header_validated && s_page_offset >= ESP_IMAGE_HEADER_BYTES) {
        need_chip_check = true;
    }
    if (s_page_offset >= NARBIS_OTA_PAGE_SIZE) {
        completed_page = s_page_num;
        completed_crc  = esp_rom_crc32_le(0, s_page_buf, NARBIS_OTA_PAGE_SIZE);
        s_page_pending = true;
        need_page_complete = true;
    }

    /* Snapshot for chip-check before releasing. Buffer pointer stays
     * valid until session_reset_locked() runs (cancel/finish path). */
    uint8_t header_copy[ESP_IMAGE_HEADER_BYTES];
    if (need_chip_check) {
        memcpy(header_copy, s_page_buf, ESP_IMAGE_HEADER_BYTES);
        s_image_header_validated = true;  /* don't recheck */
    }
    xSemaphoreGive(s_mtx);

    if (need_chip_check && !verify_chip_id(header_copy)) {
        ota_task_cmd_t cmd = OTA_TASK_CANCEL;
        (void)xQueueSend(s_cmd_q, &cmd, 0);
        notify_error(NARBIS_OTA_ERR_CHIP_MISMATCH);
        return 0;
    }

    if (need_page_complete) {
        notify_page_crc(completed_page, completed_crc);
    }
    return 0;
}

static int access_status(uint16_t conn_handle, uint16_t attr_handle,
                         struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    /* Notify-only. Reads return empty; writes denied. */
    (void)conn_handle; (void)attr_handle; (void)arg;
    if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) return 0;
    return BLE_ATT_ERR_REQ_NOT_SUPPORTED;
}

/* ============================================================================
 * GATT table
 * ========================================================================= */

static const struct ble_gatt_chr_def OTA_CHRS[] = {
    {
        .uuid       = &CHR_CTRL_UUID.u,
        .access_cb  = access_control,
        .flags      = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_READ,
        .val_handle = &s_h_ctrl,
    },
    {
        .uuid       = &CHR_DATA_UUID.u,
        .access_cb  = access_data,
        .flags      = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_NO_RSP,
        .val_handle = &s_h_data,
    },
    {
        .uuid       = &CHR_STAT_UUID.u,
        .access_cb  = access_status,
        .flags      = BLE_GATT_CHR_F_NOTIFY | BLE_GATT_CHR_F_READ,
        .val_handle = &s_h_stat,
    },
    { 0 }
};

static const struct ble_gatt_svc_def OTA_SVC_DEFS[] = {
    {
        .type            = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid            = &SVC_UUID.u,
        .characteristics = OTA_CHRS,
    },
    { 0 }
};

const struct ble_gatt_svc_def *ble_ota_svc_defs(void)
{
    return OTA_SVC_DEFS;
}

void ble_ota_on_register(struct ble_gatt_register_ctxt *ctxt)
{
    /* Value handles are written directly via the .val_handle pointer in
     * the chr_def table, so this hook only needs to log/observe — but we
     * keep the symbol in the same shape as the other services so
     * transport_ble.c's dispatch loop stays uniform. */
    (void)ctxt;
}

/* ============================================================================
 * Validity self-test
 * ========================================================================= */

static void validity_task(void *arg)
{
    (void)arg;
    const TickType_t timeout = pdMS_TO_TICKS(
        (uint32_t)CONFIG_NARBIS_OTA_VALIDITY_TIMEOUT_S * 1000U);

    ESP_LOGI(TAG, "validity self-test: waiting up to %d s for first BLE connect",
             CONFIG_NARBIS_OTA_VALIDITY_TIMEOUT_S);

    esp_err_t werr = transport_ble_wait_first_connect(
        (uint32_t)CONFIG_NARBIS_OTA_VALIDITY_TIMEOUT_S * 1000U);
    (void)timeout;

    if (werr == ESP_OK) {
        esp_err_t err = esp_ota_mark_app_valid_cancel_rollback();
        if (err == ESP_OK) {
            ESP_LOGI(TAG, "validity self-test: PASS — image marked valid");
        } else {
            ESP_LOGW(TAG, "mark_app_valid_cancel_rollback: %s",
                     esp_err_to_name(err));
        }
    } else {
        ESP_LOGW(TAG, "validity self-test: timeout — bootloader will roll back on next reset");
    }
    vTaskDelete(NULL);
}

esp_err_t ble_ota_validity_selftest_kickoff(void)
{
    const esp_partition_t *running = esp_ota_get_running_partition();
    if (running == NULL) {
        return ESP_OK;  /* nothing meaningful to do */
    }
    if (running->type != ESP_PARTITION_TYPE_APP
        || running->subtype == ESP_PARTITION_SUBTYPE_APP_FACTORY) {
        ESP_LOGI(TAG, "running from %s — no validity check needed", running->label);
        return ESP_OK;
    }

    esp_ota_img_states_t state = ESP_OTA_IMG_UNDEFINED;
    esp_err_t err = esp_ota_get_state_partition(running, &state);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "get_state_partition: %s", esp_err_to_name(err));
        return err;
    }
    if (state != ESP_OTA_IMG_PENDING_VERIFY) {
        ESP_LOGI(TAG, "running %s state=%d — already validated", running->label, (int)state);
        return ESP_OK;
    }

    BaseType_t ok = xTaskCreate(validity_task, "ota_validity", VALIDITY_TASK_STACK_BYTES,
                                NULL, VALIDITY_TASK_PRIORITY, NULL);
    return (ok == pdPASS) ? ESP_OK : ESP_ERR_NO_MEM;
}

/* ============================================================================
 * Init / deinit
 * ========================================================================= */

esp_err_t ble_ota_init(void)
{
    if (s_mtx) return ESP_OK;  /* idempotent */

    s_mtx = xSemaphoreCreateMutex();
    if (s_mtx == NULL) return ESP_ERR_NO_MEM;

    s_cmd_q = xQueueCreate(OTA_QUEUE_DEPTH, sizeof(ota_task_cmd_t));
    if (s_cmd_q == NULL) {
        vSemaphoreDelete(s_mtx);
        s_mtx = NULL;
        return ESP_ERR_NO_MEM;
    }

    BaseType_t ok = xTaskCreate(ota_task, "ble_ota", OTA_TASK_STACK_BYTES,
                                NULL, OTA_TASK_PRIORITY, &s_ota_task);
    if (ok != pdPASS) {
        vQueueDelete(s_cmd_q);
        s_cmd_q = NULL;
        vSemaphoreDelete(s_mtx);
        s_mtx = NULL;
        return ESP_ERR_NO_MEM;
    }

    s_in_ota_mode = false;
    s_page_buf = NULL;
    ESP_LOGI(TAG, "init complete (page=%u chunk=%u)",
             (unsigned)NARBIS_OTA_PAGE_SIZE, (unsigned)NARBIS_OTA_CHUNK_SIZE);
    return ESP_OK;
}

esp_err_t ble_ota_deinit(void)
{
    if (s_ota_task) {
        vTaskDelete(s_ota_task);
        s_ota_task = NULL;
    }
    if (s_cmd_q) {
        vQueueDelete(s_cmd_q);
        s_cmd_q = NULL;
    }
    if (s_mtx) {
        vSemaphoreDelete(s_mtx);
        s_mtx = NULL;
    }
    if (s_page_buf) {
        free(s_page_buf);
        s_page_buf = NULL;
    }
    return ESP_OK;
}
