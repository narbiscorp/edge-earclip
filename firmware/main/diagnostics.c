/*
 * diagnostics.c — single ring buffer + drain task for diagnostic streams.
 *
 * Wire format per record inside the ring buffer:
 *   [stream_id u8][len u8][payload …]
 *
 * Drain frame (one BLE notification ≤ 120 B):
 *   [seq u16][n u8] then n × {[stream_id u8][len u8][payload …]}
 */

#include "diagnostics.h"

#include <stdatomic.h>
#include <string.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/ringbuf.h"
#include "freertos/task.h"

#include "ble_service_narbis.h"
#include "narbis_protocol.h"
#include "transport_ble.h"

static const char *TAG = "diagnostics";

#define DIAG_RINGBUF_BYTES   4096
#define DIAG_DRAIN_PERIOD_MS 100
#define DIAG_FRAME_BUDGET     120
#define DIAG_TASK_STACK      3072
#define DIAG_TASK_PRIO         3

static RingbufHandle_t s_ring;
static TaskHandle_t    s_drain_task;
static atomic_uint     s_mask;       /* uint8_t in low byte */
static atomic_uint     s_drop_count;
static volatile bool   s_running;
static uint16_t        s_seq;

void diagnostics_set_mask(uint8_t mask)
{
    atomic_store(&s_mask, (unsigned)mask);
}

void diagnostics_push(uint8_t stream_id, const void *payload, size_t len)
{
    if (s_ring == NULL) return;
    if (len > 64) return;
    unsigned mask = atomic_load(&s_mask);
    if ((mask & stream_id) == 0) return;

    uint8_t buf[2 + 64];
    buf[0] = stream_id;
    buf[1] = (uint8_t)len;
    if (len > 0 && payload != NULL) memcpy(buf + 2, payload, len);
    BaseType_t ok = xRingbufferSend(s_ring, buf, 2 + len, 0);
    if (ok != pdTRUE) {
        atomic_fetch_add(&s_drop_count, 1);
    }
}

static void emit_frame(uint8_t *frame, uint16_t frame_len, uint8_t n_records)
{
    if (n_records == 0) return;
    /* Patch the n field at offset 2 (frame[0..1] is seq). */
    frame[2] = n_records;
    (void)transport_ble_notify(BLE_SUB_NARBIS_DIAGNOSTICS, frame, frame_len);
}

static void drain_task(void *arg)
{
    (void)arg;
    uint8_t frame[DIAG_FRAME_BUDGET];
    while (s_running) {
        if (!transport_ble_is_subscribed(BLE_SUB_NARBIS_DIAGNOSTICS)) {
            /* Drain and drop while no subscriber to keep the ring fresh. */
            size_t len = 0;
            void *p;
            while ((p = xRingbufferReceive(s_ring, &len, 0)) != NULL) {
                vRingbufferReturnItem(s_ring, p);
            }
            vTaskDelay(pdMS_TO_TICKS(DIAG_DRAIN_PERIOD_MS));
            continue;
        }

        uint16_t pos = 0;
        uint8_t  n_records = 0;
        frame[pos++] = (uint8_t)(s_seq & 0xFF);
        frame[pos++] = (uint8_t)((s_seq >> 8) & 0xFF);
        frame[pos++] = 0;  /* placeholder for n_records */

        TickType_t timeout = pdMS_TO_TICKS(DIAG_DRAIN_PERIOD_MS);
        while (pos + 66 <= sizeof(frame)) {
            size_t item_len = 0;
            uint8_t *item = (uint8_t *)xRingbufferReceive(s_ring, &item_len, timeout);
            if (item == NULL) break;
            if (item_len <= sizeof(frame) - pos) {
                memcpy(frame + pos, item, item_len);
                pos += (uint16_t)item_len;
                n_records++;
            }
            vRingbufferReturnItem(s_ring, item);
            timeout = 0;  /* don't wait on subsequent items in the same batch */
        }

        if (n_records > 0) {
            emit_frame(frame, pos, n_records);
            s_seq++;
        } else {
            vTaskDelay(pdMS_TO_TICKS(DIAG_DRAIN_PERIOD_MS));
        }
    }
    s_drain_task = NULL;
    vTaskDelete(NULL);
}

esp_err_t diagnostics_init(void)
{
    if (s_ring != NULL) return ESP_ERR_INVALID_STATE;
    s_ring = xRingbufferCreate(DIAG_RINGBUF_BYTES, RINGBUF_TYPE_NOSPLIT);
    if (s_ring == NULL) return ESP_ERR_NO_MEM;

    atomic_store(&s_mask, 0u);
    atomic_store(&s_drop_count, 0u);
    s_seq = 0;
    s_running = true;

    BaseType_t ok = xTaskCreate(drain_task, "diag_drain",
                                DIAG_TASK_STACK, NULL, DIAG_TASK_PRIO, &s_drain_task);
    if (ok != pdPASS) {
        vRingbufferDelete(s_ring);
        s_ring = NULL;
        return ESP_ERR_NO_MEM;
    }
    ESP_LOGI(TAG, "ring=%d B drain=%d ms", DIAG_RINGBUF_BYTES, DIAG_DRAIN_PERIOD_MS);
    return ESP_OK;
}

esp_err_t diagnostics_deinit(void)
{
    s_running = false;
    /* Drain task self-deletes. Ringbuf freed when caller is done. */
    if (s_ring != NULL) {
        vRingbufferDelete(s_ring);
        s_ring = NULL;
    }
    return ESP_OK;
}
