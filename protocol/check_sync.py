#!/usr/bin/env python3
"""
check_sync.py — verify narbis_protocol.h and narbis_protocol.ts agree.

Catches the drift that actually happens in a single-dev project: a field
added on one side but not the other, or an enum value renumbered. Uses
regex extraction (no full C parser) plus a hand-maintained name alias and
type-equivalence map.

Run before commits. Non-zero exit on drift.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
H_PATH = HERE / "narbis_protocol.h"
TS_PATH = HERE / "narbis_protocol.ts"

# C type → TS type (in spirit). Numbers all collapse to "number" in TS.
C_TO_TS_TYPE = {
    "uint8_t": "number",
    "int8_t": "number",
    "uint16_t": "number",
    "int16_t": "number",
    "uint32_t": "number",
    "int32_t": "number",
    "uint8_t[6]": "Uint8Array",
}

# C struct name (with _t) → TS interface name. Add entries here as new
# structs are introduced; missing entries cause the checker to skip the
# struct (and warn).
STRUCT_ALIASES = {
    "narbis_header_t": "NarbisHeader",
    "narbis_ibi_payload_t": "NarbisIbiPayload",
    "narbis_raw_sample_t": "NarbisRawSample",
    "narbis_raw_ppg_payload_t": "NarbisRawPpgPayload",
    "narbis_battery_payload_t": "NarbisBatteryPayload",
    "narbis_sqi_payload_t": "NarbisSqiPayload",
    "narbis_heartbeat_payload_t": "NarbisHeartbeatPayload",
    "narbis_config_ack_payload_t": "NarbisConfigAckPayload",
    "narbis_runtime_config_t": "NarbisRuntimeConfig",
    "beat_event_t": "BeatEvent",
}

# C enum (with _t) → TS enum name.
ENUM_ALIASES = {
    "narbis_msg_type_t": "NarbisMsgType",
    "narbis_transport_mode_t": "NarbisTransportMode",
    "narbis_ble_profile_t": "NarbisBleProfile",
    "narbis_data_format_t": "NarbisDataFormat",
    "narbis_config_ack_status_t": "NarbisConfigAckStatus",
    "narbis_ota_opcode_t": "NarbisOtaOpcode",
    "narbis_ota_status_t": "NarbisOtaStatus",
    "narbis_ota_error_t": "NarbisOtaError",
}

# C enum value name → TS enum member name. C convention is
# `NARBIS_MSG_IBI`; TS convention is `IBI` (the prefix being implied by
# the enum name itself).
ENUM_MEMBER_PREFIX_STRIP = {
    "narbis_msg_type_t": "NARBIS_MSG_",
    "narbis_transport_mode_t": "NARBIS_TRANSPORT_",
    "narbis_ble_profile_t": "NARBIS_BLE_",
    "narbis_data_format_t": "NARBIS_DATA_",
    "narbis_config_ack_status_t": "NARBIS_CFG_ACK_",
    "narbis_ota_opcode_t": "NARBIS_OTA_OP_",
    "narbis_ota_status_t": "NARBIS_OTA_ST_",
    "narbis_ota_error_t": "NARBIS_OTA_ERR_",
}


# -------------------------------------------------------------- C parsing

C_STRUCT_RE = re.compile(
    r"typedef\s+struct\s+(?:__attribute__\(\(packed\)\)\s*)?\{([^}]*)\}\s*([A-Za-z_][A-Za-z0-9_]*)\s*;",
    re.DOTALL,
)
C_ENUM_RE = re.compile(
    r"typedef\s+enum\s*\{([^}]*)\}\s*([A-Za-z_][A-Za-z0-9_]*)\s*;",
    re.DOTALL,
)
# Field: <type> <name>[<n>]?;
C_FIELD_RE = re.compile(
    r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*\[\s*([A-Za-z0-9_]+)\s*\])?\s*;",
    re.MULTILINE,
)
# Enum member: NAME[ = VALUE]
C_ENUM_MEMBER_RE = re.compile(
    r"^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(0x[0-9A-Fa-f]+|[0-9]+)",
    re.MULTILINE,
)


def strip_c_comments(src: str) -> str:
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.DOTALL)
    src = re.sub(r"//.*?$", "", src, flags=re.MULTILINE)
    return src


def parse_c_header(path: Path):
    raw = path.read_text(encoding="utf-8")
    src = strip_c_comments(raw)
    structs = {}
    for body, name in C_STRUCT_RE.findall(src):
        fields = []
        for ftype, fname, farr in C_FIELD_RE.findall(body):
            t = ftype if not farr else f"{ftype}[{farr}]"
            fields.append((fname, t))
        # Skip the union helper struct's nested entries — the regex only
        # matches packed structs anyway, but unions in narbis_packet_t are
        # not packed-typedef so they won't appear.
        if fields:
            structs[name] = fields
    enums = {}
    for body, name in C_ENUM_RE.findall(src):
        members = [(m, int(v, 0)) for m, v in C_ENUM_MEMBER_RE.findall(body)]
        if members:
            enums[name] = members
    return structs, enums


# -------------------------------------------------------------- TS parsing

TS_INTERFACE_RE = re.compile(
    r"export\s+interface\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([^}]*)\}",
    re.DOTALL,
)
TS_ENUM_RE = re.compile(
    r"export\s+enum\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([^}]*)\}",
    re.DOTALL,
)
# Field: name: type[];?  (we only capture the field name and a coarse type)
TS_FIELD_RE = re.compile(
    r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z_][A-Za-z0-9_<>\[\]\| ]*?)\s*;",
    re.MULTILINE,
)
TS_ENUM_MEMBER_RE = re.compile(
    r"^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(0x[0-9A-Fa-f]+|[0-9]+)",
    re.MULTILINE,
)


def strip_ts_comments(src: str) -> str:
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.DOTALL)
    src = re.sub(r"//.*?$", "", src, flags=re.MULTILINE)
    return src


def parse_ts(path: Path):
    raw = path.read_text(encoding="utf-8")
    src = strip_ts_comments(raw)
    interfaces = {}
    for name, body in TS_INTERFACE_RE.findall(src):
        fields = [(fn, ft.strip()) for fn, ft in TS_FIELD_RE.findall(body)]
        if fields:
            interfaces[name] = fields
    enums = {}
    for name, body in TS_ENUM_RE.findall(src):
        members = [(m, int(v, 0)) for m, v in TS_ENUM_MEMBER_RE.findall(body)]
        if members:
            enums[name] = members
    return interfaces, enums


# -------------------------------------------------------------- comparison

def ts_type_for_c(c_type: str) -> str:
    return C_TO_TS_TYPE.get(c_type, "??")


def compare(c_structs, c_enums, ts_interfaces, ts_enums):
    errors = []
    warnings = []

    # Structs
    for c_name, c_fields in c_structs.items():
        if c_name not in STRUCT_ALIASES:
            warnings.append(f"[skip] C struct {c_name} has no entry in STRUCT_ALIASES")
            continue
        ts_name = STRUCT_ALIASES[c_name]
        if ts_name not in ts_interfaces:
            errors.append(f"struct {c_name} has no TS interface {ts_name}")
            continue
        ts_fields = ts_interfaces[ts_name]
        c_names = [n for n, _ in c_fields]
        ts_names = [n for n, _ in ts_fields]
        if c_names != ts_names:
            errors.append(
                f"struct {c_name} ↔ {ts_name} field-name drift:\n"
                f"  C : {c_names}\n  TS: {ts_names}"
            )
            continue
        # Coarse type check
        for (cn, ct), (tn, tt) in zip(c_fields, ts_fields):
            expected_ts = ts_type_for_c(ct)
            if expected_ts == "??":
                warnings.append(f"  [type] C type '{ct}' for {c_name}.{cn} not in C_TO_TS_TYPE")
                continue
            # TS field type may be `number`, `Uint8Array`, or contain those.
            if expected_ts not in tt:
                errors.append(
                    f"struct {c_name}.{cn} type mismatch: C '{ct}' expects TS '{expected_ts}', got '{tt}'"
                )

    # TS interfaces with no C counterpart (skip the discriminated-union
    # ones — they aren't direct mirrors).
    reverse_alias = {v: k for k, v in STRUCT_ALIASES.items()}
    for ts_name in ts_interfaces:
        if ts_name in reverse_alias:
            continue
        warnings.append(f"[skip] TS interface {ts_name} has no entry in STRUCT_ALIASES")

    # Enums
    for c_name, c_members in c_enums.items():
        if c_name not in ENUM_ALIASES:
            warnings.append(f"[skip] C enum {c_name} has no entry in ENUM_ALIASES")
            continue
        ts_name = ENUM_ALIASES[c_name]
        if ts_name not in ts_enums:
            errors.append(f"enum {c_name} has no TS enum {ts_name}")
            continue
        ts_members = ts_enums[ts_name]
        prefix = ENUM_MEMBER_PREFIX_STRIP.get(c_name, "")
        c_normalized = [(n[len(prefix):] if n.startswith(prefix) else n, v) for n, v in c_members]
        if c_normalized != ts_members:
            errors.append(
                f"enum {c_name} ↔ {ts_name} member drift:\n"
                f"  C (stripped '{prefix}'): {c_normalized}\n  TS: {ts_members}"
            )

    reverse_enum_alias = {v: k for k, v in ENUM_ALIASES.items()}
    for ts_name in ts_enums:
        if ts_name in reverse_enum_alias:
            continue
        warnings.append(f"[skip] TS enum {ts_name} has no entry in ENUM_ALIASES")

    return errors, warnings


# -------------------------------------------------------------- main

def main() -> int:
    if not H_PATH.exists():
        print(f"missing: {H_PATH}", file=sys.stderr)
        return 2
    if not TS_PATH.exists():
        print(f"missing: {TS_PATH}", file=sys.stderr)
        return 2

    c_structs, c_enums = parse_c_header(H_PATH)
    ts_interfaces, ts_enums = parse_ts(TS_PATH)

    errors, warnings = compare(c_structs, c_enums, ts_interfaces, ts_enums)

    for w in warnings:
        print(f"warn: {w}")
    for e in errors:
        print(f"ERROR: {e}")

    if errors:
        print(f"\ncheck_sync: FAILED ({len(errors)} error(s), {len(warnings)} warning(s))")
        return 1
    print(f"check_sync: OK ({len(c_structs)} struct(s), {len(c_enums)} enum(s) checked, "
          f"{len(warnings)} warning(s))")
    return 0


if __name__ == "__main__":
    sys.exit(main())
