/*
 * roundtrip.c — exhaustive serialize/deserialize test for narbis_protocol.
 *
 * Builds one canonical instance of every message type plus a runtime config,
 * serializes each, deserializes it back, and asserts memcmp equality. Also
 * writes hex dumps of every canonical packet to golden_packets.txt for the
 * TypeScript-side test (roundtrip.ts) to consume.
 *
 * Exit code: 0 on success, non-zero on any failure.
 */

#include "../narbis_protocol.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int failures = 0;

static void check(int cond, const char *what)
{
    if (!cond) {
        fprintf(stderr, "FAIL: %s\n", what);
        failures++;
    }
}

static void hex_line(FILE *f, const char *label, const uint8_t *buf, size_t n)
{
    fprintf(f, "%s ", label);
    for (size_t i = 0; i < n; i++) {
        fprintf(f, "%02x", buf[i]);
    }
    fprintf(f, "\n");
}

/* Generic struct round-trip: serialize pkt, deserialize into out, assert byte
 * equality of (header + payload up to payload_len) and CRC. The unused bytes
 * of the in-memory union are not part of the wire format and may differ. */
static void roundtrip_packet(const narbis_packet_t *pkt, const char *label, FILE *gold)
{
    uint8_t buf[NARBIS_MAX_FRAME_SIZE];
    size_t n = 0;
    int rc = narbis_packet_serialize(buf, sizeof(buf), pkt, &n);
    if (rc != 0) {
        fprintf(stderr, "FAIL: %s serialize rc=%d\n", label, rc);
        failures++;
        return;
    }
    hex_line(gold, label, buf, n);

    narbis_packet_t out;
    rc = narbis_packet_deserialize(buf, n, &out);
    if (rc != 0) {
        fprintf(stderr, "FAIL: %s deserialize rc=%d\n", label, rc);
        failures++;
        return;
    }

    /* Compare header (with the protocol_version + reserved + payload_len that
     * serialize fills in). */
    narbis_header_t expected = pkt->header;
    expected.protocol_version = NARBIS_PROTOCOL_VERSION;
    expected.reserved = 0;
    expected.payload_len = (uint16_t)narbis_payload_size(pkt);
    if (memcmp(&expected, &out.header, sizeof(expected)) != 0) {
        fprintf(stderr, "FAIL: %s header memcmp\n", label);
        failures++;
        return;
    }

    /* Compare payload bytes up to payload_len. */
    size_t plen = narbis_payload_size(pkt);
    if (memcmp(&pkt->payload, &out.payload, plen) != 0) {
        fprintf(stderr, "FAIL: %s payload memcmp (%zu bytes)\n", label, plen);
        failures++;
        return;
    }

    /* Re-serialize the deserialized packet and confirm bit-identical wire
     * bytes. This catches any non-determinism in serialize. */
    uint8_t buf2[NARBIS_MAX_FRAME_SIZE];
    size_t n2 = 0;
    rc = narbis_packet_serialize(buf2, sizeof(buf2), &out, &n2);
    check(rc == 0, label);
    check(n == n2, label);
    check(memcmp(buf, buf2, n) == 0, label);
}

static void test_ibi(FILE *gold)
{
    narbis_packet_t pkt;
    memset(&pkt, 0, sizeof(pkt));
    pkt.header.msg_type = NARBIS_MSG_IBI;
    pkt.header.device_id = 0x42;
    pkt.header.seq_num = 0x1234;
    pkt.header.timestamp_ms = 0xDEADBEEFu;
    pkt.payload.ibi.ibi_ms = 850;
    pkt.payload.ibi.confidence_x100 = 95;
    pkt.payload.ibi.flags = NARBIS_BEAT_FLAG_LOW_CONFIDENCE;
    roundtrip_packet(&pkt, "IBI", gold);
}

static void test_raw_ppg(FILE *gold)
{
    narbis_packet_t pkt;
    memset(&pkt, 0, sizeof(pkt));
    pkt.header.msg_type = NARBIS_MSG_RAW_PPG;
    pkt.header.device_id = 0x01;
    pkt.header.seq_num = 0x0001;
    pkt.header.timestamp_ms = 1000;
    pkt.payload.raw_ppg.sample_rate_hz = 200;
    pkt.payload.raw_ppg.n_samples = 5;
    for (uint16_t i = 0; i < 5; i++) {
        pkt.payload.raw_ppg.samples[i].red = 100000u + i;
        pkt.payload.raw_ppg.samples[i].ir  = 200000u + i;
    }
    roundtrip_packet(&pkt, "RAW_PPG", gold);
}

static void test_raw_ppg_full(FILE *gold)
{
    /* Worst-case packet: full frame with 29 samples. Verifies the boundary. */
    narbis_packet_t pkt;
    memset(&pkt, 0, sizeof(pkt));
    pkt.header.msg_type = NARBIS_MSG_RAW_PPG;
    pkt.header.device_id = 0x01;
    pkt.header.seq_num = 0x0002;
    pkt.header.timestamp_ms = 2000;
    pkt.payload.raw_ppg.sample_rate_hz = 200;
    pkt.payload.raw_ppg.n_samples = NARBIS_RAW_PPG_MAX_SAMPLES;
    for (uint16_t i = 0; i < NARBIS_RAW_PPG_MAX_SAMPLES; i++) {
        pkt.payload.raw_ppg.samples[i].red = 0xAA000000u | i;
        pkt.payload.raw_ppg.samples[i].ir  = 0xBB000000u | i;
    }
    roundtrip_packet(&pkt, "RAW_PPG_FULL", gold);
}

static void test_battery(FILE *gold)
{
    narbis_packet_t pkt;
    memset(&pkt, 0, sizeof(pkt));
    pkt.header.msg_type = NARBIS_MSG_BATTERY;
    pkt.header.device_id = 0x01;
    pkt.header.seq_num = 0x0003;
    pkt.header.timestamp_ms = 3000;
    pkt.payload.battery.mv = 3850;
    pkt.payload.battery.soc_pct = 72;
    pkt.payload.battery.charging = 1;
    roundtrip_packet(&pkt, "BATTERY", gold);
}

static void test_sqi(FILE *gold)
{
    narbis_packet_t pkt;
    memset(&pkt, 0, sizeof(pkt));
    pkt.header.msg_type = NARBIS_MSG_SQI;
    pkt.header.device_id = 0x01;
    pkt.header.seq_num = 0x0004;
    pkt.header.timestamp_ms = 4000;
    pkt.payload.sqi.sqi_x100 = 87;
    pkt.payload.sqi.dc_red = 123456u;
    pkt.payload.sqi.dc_ir = 654321u;
    pkt.payload.sqi.perfusion_idx_x1000 = 1234;
    roundtrip_packet(&pkt, "SQI", gold);
}

static void test_heartbeat(FILE *gold)
{
    /* mode_byte still packs three 2-bit fields for byte-layout compat with
     * older NVS blobs and the existing dashboard parser. transport bits
     * are now always 0 (Path B has only one transport, BLE). */
    narbis_packet_t pkt;
    memset(&pkt, 0, sizeof(pkt));
    pkt.header.msg_type = NARBIS_MSG_HEARTBEAT;
    pkt.header.device_id = 0x01;
    pkt.header.seq_num = 0x0005;
    pkt.header.timestamp_ms = 5000;
    pkt.payload.heartbeat.uptime_s = 3600;
    pkt.payload.heartbeat.free_heap = 200000;
    pkt.payload.heartbeat.rssi_dbm = -55;
    pkt.payload.heartbeat.mode_byte = (uint8_t)(
        ((NARBIS_BLE_LOW_LATENCY & 0x03) << 2) |
        ((NARBIS_DATA_IBI_PLUS_RAW & 0x03) << 4));
    pkt.payload.heartbeat.reserved = 0;
    roundtrip_packet(&pkt, "HEARTBEAT", gold);
}

static void test_config_ack(FILE *gold)
{
    narbis_packet_t pkt;
    memset(&pkt, 0, sizeof(pkt));
    pkt.header.msg_type = NARBIS_MSG_CONFIG_ACK;
    pkt.header.device_id = 0x01;
    pkt.header.seq_num = 0x0006;
    pkt.header.timestamp_ms = 6000;
    pkt.payload.config_ack.config_version = 1;
    pkt.payload.config_ack.status = NARBIS_CFG_ACK_OK;
    pkt.payload.config_ack.field_id = 0xFF;
    roundtrip_packet(&pkt, "CONFIG_ACK", gold);
}

static void test_config(FILE *gold)
{
    narbis_runtime_config_t cfg;
    memset(&cfg, 0, sizeof(cfg));
    cfg.config_version       = 4;
    cfg.sample_rate_hz       = 200;
    cfg.led_red_ma_x10       = 70;
    cfg.led_ir_ma_x10        = 70;
    cfg.agc_enabled          = 1;
    cfg.agc_update_period_ms = 200;
    cfg.agc_target_dc_min    = 50000;
    cfg.agc_target_dc_max    = 200000;
    cfg.agc_step_ma_x10      = 5;
    cfg.bandpass_low_hz_x100 = 50;
    cfg.bandpass_high_hz_x100 = 800;
    cfg.elgendi_w1_ms        = 111;
    cfg.elgendi_w2_ms        = 667;
    cfg.elgendi_beta_x1000   = 20;
    cfg.sqi_threshold_x100   = 50;
    cfg.ibi_min_ms           = 300;
    cfg.ibi_max_ms           = 2000;
    cfg.ibi_max_delta_pct    = 30;
    cfg.ble_profile          = NARBIS_BLE_BATCHED;
    cfg.data_format          = NARBIS_DATA_IBI_ONLY;
    cfg.ble_batch_period_ms  = 500;
    cfg.diagnostics_enabled  = 1;
    cfg.light_sleep_enabled  = 1;
    cfg.diagnostics_mask     = NARBIS_DIAG_STREAM_PRE_FILTER | NARBIS_DIAG_STREAM_POST_FILTER;
    cfg.battery_low_mv       = 3300;
    /* Adaptive-detector fields (config_version 4). */
    cfg.detector_mode              = NARBIS_DETECTOR_ADAPTIVE;
    cfg.template_max_beats         = 10;
    cfg.template_warmup_beats      = 4;
    cfg.kalman_warmup_beats        = 5;
    cfg.template_window_ms         = 200;
    cfg.ncc_min_x1000              = 500;
    cfg.ncc_learn_min_x1000        = 750;
    cfg.kalman_q_ms2               = 400;
    cfg.kalman_r_ms2               = 2500;
    cfg.kalman_sigma_x10           = 30;
    cfg.watchdog_max_consec_rejects = 5;
    cfg.watchdog_silence_ms        = 4000;
    cfg.alpha_min_x1000            = 10;
    cfg.alpha_max_x1000            = 500;
    cfg.elgendi_loose_mode         = 1;
    cfg.refractory_ibi_pct         = 60;

    uint8_t buf[256];
    size_t n = 0;
    int rc = narbis_config_serialize(buf, sizeof(buf), &cfg, &n);
    check(rc == 0, "CONFIG serialize");
    check(n == NARBIS_CONFIG_WIRE_SIZE, "CONFIG wire size");
    hex_line(gold, "CONFIG", buf, n);

    narbis_runtime_config_t out;
    memset(&out, 0xAA, sizeof(out));
    rc = narbis_config_deserialize(buf, n, &out);
    check(rc == 0, "CONFIG deserialize");
    check(memcmp(&cfg, &out, sizeof(cfg)) == 0, "CONFIG memcmp");
}

static void test_crc_smoke(void)
{
    /* Reference vector: CRC-16-CCITT-FALSE("123456789") = 0x29B1 */
    const uint8_t v[] = "123456789";
    uint16_t got = narbis_crc16_ccitt_false(v, 9);
    check(got == 0x29B1, "CRC-16-CCITT-FALSE check vector");
    if (got != 0x29B1) {
        fprintf(stderr, "  expected 0x29B1, got 0x%04X\n", got);
    }
}

static void test_peer_role_enum(void)
{
    /* Path B: peer-role values are written 1 byte to NARBIS_CHR_PEER_ROLE.
     * Validate the enum numbering hasn't drifted. */
    check(NARBIS_PEER_ROLE_UNKNOWN   == 0, "NARBIS_PEER_ROLE_UNKNOWN==0");
    check(NARBIS_PEER_ROLE_DASHBOARD == 1, "NARBIS_PEER_ROLE_DASHBOARD==1");
    check(NARBIS_PEER_ROLE_GLASSES   == 2, "NARBIS_PEER_ROLE_GLASSES==2");
}

static void test_corruption_detected(void)
{
    /* Build a valid IBI packet, flip one byte, confirm deserialize rejects. */
    narbis_packet_t pkt;
    memset(&pkt, 0, sizeof(pkt));
    pkt.header.msg_type = NARBIS_MSG_IBI;
    pkt.header.device_id = 0x01;
    pkt.payload.ibi.ibi_ms = 800;
    uint8_t buf[NARBIS_MAX_FRAME_SIZE];
    size_t n = 0;
    int rc = narbis_packet_serialize(buf, sizeof(buf), &pkt, &n);
    check(rc == 0, "corruption-test serialize");

    buf[NARBIS_HEADER_SIZE] ^= 0x01; /* flip a bit in the payload */
    narbis_packet_t out;
    rc = narbis_packet_deserialize(buf, n, &out);
    check(rc != 0, "corruption rejected (CRC mismatch)");
}

int main(void)
{
    test_crc_smoke();

    FILE *gold = fopen("golden_packets.txt", "w");
    if (!gold) {
        fprintf(stderr, "FAIL: open golden_packets.txt for write\n");
        return 1;
    }

    test_ibi(gold);
    test_raw_ppg(gold);
    test_raw_ppg_full(gold);
    test_battery(gold);
    test_sqi(gold);
    test_heartbeat(gold);
    test_config_ack(gold);
    test_config(gold);

    fclose(gold);

    test_peer_role_enum();
    test_corruption_detected();

    if (failures != 0) {
        fprintf(stderr, "\nFAILED: %d check(s) failed\n", failures);
        return 1;
    }
    printf("OK: all round-trip checks passed; golden_packets.txt written\n");
    return 0;
}
