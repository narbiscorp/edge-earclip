/*
 * roundtrip.ts — TypeScript-side cross-language round-trip test.
 *
 * Reads protocol/test/golden_packets.txt (produced by the C-side roundtrip),
 * deserializes each line, asserts each parsed field against its expected
 * canonical value, then re-serializes and asserts byte-identical hex.
 *
 * Run with:  npx tsx protocol/test/roundtrip.ts
 * Exit 0 on success, non-zero on any mismatch.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  NarbisMsgType,
  NarbisPeerRole,
  NarbisBleProfile,
  NarbisDataFormat,
  NarbisDetectorMode,
  NarbisConfigAckStatus,
  NARBIS_BEAT_FLAG_LOW_CONFIDENCE,
  NARBIS_DIAG_STREAM_PRE_FILTER,
  NARBIS_DIAG_STREAM_POST_FILTER,
  NARBIS_RAW_PPG_MAX_SAMPLES,
  type NarbisPacket,
  type NarbisRuntimeConfig,
  deserializePacket,
  serializePacket,
  deserializeConfig,
  serializeConfig,
} from "../narbis_protocol.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = join(__dirname, "golden_packets.txt");

let failures = 0;

function check(cond: boolean, what: string): void {
  if (!cond) {
    console.error(`FAIL: ${what}`);
    failures++;
  }
}

function eq<T>(label: string, got: T, want: T): void {
  if (got !== want) {
    console.error(`FAIL: ${label}: got ${String(got)}, want ${String(want)}`);
    failures++;
  }
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("odd-length hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function assertReencode(label: string, hex: string, pkt: NarbisPacket): void {
  const reencoded = bytesToHex(serializePacket(pkt));
  if (reencoded !== hex) {
    console.error(`FAIL: ${label} re-encode:\n  want ${hex}\n  got  ${reencoded}`);
    failures++;
  }
}

function assertReencodeConfig(label: string, hex: string, cfg: NarbisRuntimeConfig): void {
  const reencoded = bytesToHex(serializeConfig(cfg));
  if (reencoded !== hex) {
    console.error(`FAIL: ${label} re-encode:\n  want ${hex}\n  got  ${reencoded}`);
    failures++;
  }
}

interface GoldenLine {
  label: string;
  hex: string;
  bytes: Uint8Array;
}

function parseGolden(text: string): Map<string, GoldenLine> {
  const out = new Map<string, GoldenLine>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const sp = line.indexOf(" ");
    if (sp < 0) continue;
    const label = line.substring(0, sp);
    const hex = line.substring(sp + 1).trim();
    out.set(label, { label, hex, bytes: hexToBytes(hex) });
  }
  return out;
}

// ---------- per-line checks (must mirror roundtrip.c canonical values) ----------

function checkIbi(g: GoldenLine): void {
  const pkt = deserializePacket(g.bytes);
  eq("IBI msg_type", pkt.header.msg_type, NarbisMsgType.IBI);
  eq("IBI device_id", pkt.header.device_id, 0x42);
  eq("IBI seq_num", pkt.header.seq_num, 0x1234);
  eq("IBI timestamp_ms", pkt.header.timestamp_ms, 0xdeadbeef);
  eq("IBI protocol_version", pkt.header.protocol_version, 1);
  if (pkt.payload.type !== NarbisMsgType.IBI) {
    failures++; return;
  }
  eq("IBI ibi_ms", pkt.payload.ibi.ibi_ms, 850);
  eq("IBI confidence_x100", pkt.payload.ibi.confidence_x100, 95);
  eq("IBI flags", pkt.payload.ibi.flags, NARBIS_BEAT_FLAG_LOW_CONFIDENCE);
  assertReencode("IBI", g.hex, pkt);
}

function checkRawPpg(g: GoldenLine): void {
  const pkt = deserializePacket(g.bytes);
  eq("RAW_PPG msg_type", pkt.header.msg_type, NarbisMsgType.RAW_PPG);
  eq("RAW_PPG device_id", pkt.header.device_id, 0x01);
  eq("RAW_PPG seq_num", pkt.header.seq_num, 0x0001);
  eq("RAW_PPG timestamp_ms", pkt.header.timestamp_ms, 1000);
  if (pkt.payload.type !== NarbisMsgType.RAW_PPG) {
    failures++; return;
  }
  eq("RAW_PPG sample_rate_hz", pkt.payload.raw_ppg.sample_rate_hz, 200);
  eq("RAW_PPG n_samples", pkt.payload.raw_ppg.n_samples, 5);
  for (let i = 0; i < 5; i++) {
    eq(`RAW_PPG samples[${i}].red`, pkt.payload.raw_ppg.samples[i].red, 100000 + i);
    eq(`RAW_PPG samples[${i}].ir`,  pkt.payload.raw_ppg.samples[i].ir,  200000 + i);
  }
  assertReencode("RAW_PPG", g.hex, pkt);
}

function checkRawPpgFull(g: GoldenLine): void {
  const pkt = deserializePacket(g.bytes);
  eq("RAW_PPG_FULL msg_type", pkt.header.msg_type, NarbisMsgType.RAW_PPG);
  eq("RAW_PPG_FULL seq_num", pkt.header.seq_num, 0x0002);
  eq("RAW_PPG_FULL timestamp_ms", pkt.header.timestamp_ms, 2000);
  if (pkt.payload.type !== NarbisMsgType.RAW_PPG) {
    failures++; return;
  }
  eq("RAW_PPG_FULL n_samples", pkt.payload.raw_ppg.n_samples, NARBIS_RAW_PPG_MAX_SAMPLES);
  for (let i = 0; i < NARBIS_RAW_PPG_MAX_SAMPLES; i++) {
    eq(`RAW_PPG_FULL[${i}].red`, pkt.payload.raw_ppg.samples[i].red, (0xaa000000 | i) >>> 0);
    eq(`RAW_PPG_FULL[${i}].ir`,  pkt.payload.raw_ppg.samples[i].ir,  (0xbb000000 | i) >>> 0);
  }
  assertReencode("RAW_PPG_FULL", g.hex, pkt);
}

function checkBattery(g: GoldenLine): void {
  const pkt = deserializePacket(g.bytes);
  eq("BATTERY msg_type", pkt.header.msg_type, NarbisMsgType.BATTERY);
  if (pkt.payload.type !== NarbisMsgType.BATTERY) {
    failures++; return;
  }
  eq("BATTERY mv", pkt.payload.battery.mv, 3850);
  eq("BATTERY soc_pct", pkt.payload.battery.soc_pct, 72);
  eq("BATTERY charging", pkt.payload.battery.charging, 1);
  assertReencode("BATTERY", g.hex, pkt);
}

function checkSqi(g: GoldenLine): void {
  const pkt = deserializePacket(g.bytes);
  eq("SQI msg_type", pkt.header.msg_type, NarbisMsgType.SQI);
  if (pkt.payload.type !== NarbisMsgType.SQI) {
    failures++; return;
  }
  eq("SQI sqi_x100", pkt.payload.sqi.sqi_x100, 87);
  eq("SQI dc_red", pkt.payload.sqi.dc_red, 123456);
  eq("SQI dc_ir", pkt.payload.sqi.dc_ir, 654321);
  eq("SQI perfusion_idx_x1000", pkt.payload.sqi.perfusion_idx_x1000, 1234);
  assertReencode("SQI", g.hex, pkt);
}

function checkHeartbeat(g: GoldenLine): void {
  const pkt = deserializePacket(g.bytes);
  eq("HEARTBEAT msg_type", pkt.header.msg_type, NarbisMsgType.HEARTBEAT);
  if (pkt.payload.type !== NarbisMsgType.HEARTBEAT) {
    failures++; return;
  }
  eq("HEARTBEAT uptime_s", pkt.payload.heartbeat.uptime_s, 3600);
  eq("HEARTBEAT free_heap", pkt.payload.heartbeat.free_heap, 200000);
  eq("HEARTBEAT rssi_dbm", pkt.payload.heartbeat.rssi_dbm, -55);
  const expectedMode =
    ((NarbisBleProfile.LOW_LATENCY & 0x03) << 2) |
    ((NarbisDataFormat.IBI_PLUS_RAW & 0x03) << 4);
  eq("HEARTBEAT mode_byte", pkt.payload.heartbeat.mode_byte, expectedMode);
  eq("HEARTBEAT reserved", pkt.payload.heartbeat.reserved, 0);
  assertReencode("HEARTBEAT", g.hex, pkt);
}

function checkConfigAck(g: GoldenLine): void {
  const pkt = deserializePacket(g.bytes);
  eq("CONFIG_ACK msg_type", pkt.header.msg_type, NarbisMsgType.CONFIG_ACK);
  if (pkt.payload.type !== NarbisMsgType.CONFIG_ACK) {
    failures++; return;
  }
  eq("CONFIG_ACK config_version", pkt.payload.config_ack.config_version, 1);
  eq("CONFIG_ACK status", pkt.payload.config_ack.status, NarbisConfigAckStatus.OK);
  eq("CONFIG_ACK field_id", pkt.payload.config_ack.field_id, 0xff);
  assertReencode("CONFIG_ACK", g.hex, pkt);
}

function checkConfig(g: GoldenLine): void {
  const cfg = deserializeConfig(g.bytes);
  eq("CONFIG config_version", cfg.config_version, 4);
  eq("CONFIG sample_rate_hz", cfg.sample_rate_hz, 200);
  eq("CONFIG led_red_ma_x10", cfg.led_red_ma_x10, 70);
  eq("CONFIG led_ir_ma_x10", cfg.led_ir_ma_x10, 70);
  eq("CONFIG agc_enabled", cfg.agc_enabled, 1);
  eq("CONFIG agc_update_period_ms", cfg.agc_update_period_ms, 200);
  eq("CONFIG agc_target_dc_min", cfg.agc_target_dc_min, 50000);
  eq("CONFIG agc_target_dc_max", cfg.agc_target_dc_max, 200000);
  eq("CONFIG agc_step_ma_x10", cfg.agc_step_ma_x10, 5);
  eq("CONFIG bandpass_low_hz_x100", cfg.bandpass_low_hz_x100, 50);
  eq("CONFIG bandpass_high_hz_x100", cfg.bandpass_high_hz_x100, 800);
  eq("CONFIG elgendi_w1_ms", cfg.elgendi_w1_ms, 111);
  eq("CONFIG elgendi_w2_ms", cfg.elgendi_w2_ms, 667);
  eq("CONFIG elgendi_beta_x1000", cfg.elgendi_beta_x1000, 20);
  eq("CONFIG sqi_threshold_x100", cfg.sqi_threshold_x100, 50);
  eq("CONFIG ibi_min_ms", cfg.ibi_min_ms, 300);
  eq("CONFIG ibi_max_ms", cfg.ibi_max_ms, 2000);
  eq("CONFIG ibi_max_delta_pct", cfg.ibi_max_delta_pct, 30);
  eq("CONFIG ble_profile", cfg.ble_profile, NarbisBleProfile.BATCHED);
  eq("CONFIG data_format", cfg.data_format, NarbisDataFormat.IBI_ONLY);
  eq("CONFIG ble_batch_period_ms", cfg.ble_batch_period_ms, 500);
  eq("CONFIG diagnostics_enabled", cfg.diagnostics_enabled, 1);
  eq("CONFIG light_sleep_enabled", cfg.light_sleep_enabled, 1);
  eq(
    "CONFIG diagnostics_mask",
    cfg.diagnostics_mask,
    NARBIS_DIAG_STREAM_PRE_FILTER | NARBIS_DIAG_STREAM_POST_FILTER,
  );
  eq("CONFIG battery_low_mv", cfg.battery_low_mv, 3300);
  // Adaptive-detector fields (config_version 4).
  eq("CONFIG detector_mode", cfg.detector_mode, NarbisDetectorMode.ADAPTIVE);
  eq("CONFIG template_max_beats", cfg.template_max_beats, 10);
  eq("CONFIG template_warmup_beats", cfg.template_warmup_beats, 4);
  eq("CONFIG kalman_warmup_beats", cfg.kalman_warmup_beats, 5);
  eq("CONFIG template_window_ms", cfg.template_window_ms, 200);
  eq("CONFIG ncc_min_x1000", cfg.ncc_min_x1000, 500);
  eq("CONFIG ncc_learn_min_x1000", cfg.ncc_learn_min_x1000, 750);
  eq("CONFIG kalman_q_ms2", cfg.kalman_q_ms2, 400);
  eq("CONFIG kalman_r_ms2", cfg.kalman_r_ms2, 2500);
  eq("CONFIG kalman_sigma_x10", cfg.kalman_sigma_x10, 30);
  eq("CONFIG watchdog_max_consec_rejects", cfg.watchdog_max_consec_rejects, 5);
  eq("CONFIG watchdog_silence_ms", cfg.watchdog_silence_ms, 4000);
  eq("CONFIG alpha_min_x1000", cfg.alpha_min_x1000, 10);
  eq("CONFIG alpha_max_x1000", cfg.alpha_max_x1000, 500);
  eq("CONFIG agc_adaptive_step", cfg.agc_adaptive_step, 1);
  eq("CONFIG refractory_ibi_pct", cfg.refractory_ibi_pct, 60);
  assertReencodeConfig("CONFIG", g.hex, cfg);
}

function checkPeerRoleEnum(): void {
  // Path B sanity: peer-role wire values must stay 0/1/2.
  eq("NarbisPeerRole.UNKNOWN", NarbisPeerRole.UNKNOWN, 0);
  eq("NarbisPeerRole.DASHBOARD", NarbisPeerRole.DASHBOARD, 1);
  eq("NarbisPeerRole.GLASSES", NarbisPeerRole.GLASSES, 2);
}

function main(): number {
  let text: string;
  try {
    text = readFileSync(GOLDEN_PATH, "utf-8");
  } catch (e) {
    console.error(`FAIL: cannot read ${GOLDEN_PATH}: ${(e as Error).message}`);
    console.error("(run `mingw32-make test` in protocol/test first to generate it)");
    return 2;
  }
  const golden = parseGolden(text);

  const required = [
    "IBI", "RAW_PPG", "RAW_PPG_FULL", "BATTERY", "SQI", "HEARTBEAT", "CONFIG_ACK", "CONFIG",
  ];
  for (const r of required) {
    if (!golden.has(r)) {
      console.error(`FAIL: golden_packets.txt missing label '${r}'`);
      failures++;
    }
  }
  if (failures > 0) return 1;

  checkIbi(golden.get("IBI")!);
  checkRawPpg(golden.get("RAW_PPG")!);
  checkRawPpgFull(golden.get("RAW_PPG_FULL")!);
  checkBattery(golden.get("BATTERY")!);
  checkSqi(golden.get("SQI")!);
  checkHeartbeat(golden.get("HEARTBEAT")!);
  checkConfigAck(golden.get("CONFIG_ACK")!);
  checkConfig(golden.get("CONFIG")!);
  checkPeerRoleEnum();

  if (failures !== 0) {
    console.error(`\nFAILED: ${failures} check(s)`);
    return 1;
  }
  console.log(`OK: TS-side parsed and re-serialized all ${required.length} golden lines`);
  return 0;
}

process.exit(main());
