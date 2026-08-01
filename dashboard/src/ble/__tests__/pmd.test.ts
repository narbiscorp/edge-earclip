/*
 * Polar Measurement Data wire-format tests.
 *
 * These exist because the PMD codecs fail SILENTLY. A settings response parsed at the wrong
 * offset yields an empty list, every start command then falls back to its preferred values, and
 * the accelerometer keeps working because those happen to be valid — so the bug only surfaces
 * later, on a measurement type whose guess the device rejects. Fixtures pin the layout.
 */
import { describe, expect, it } from 'vitest';
import { __pmdInternal } from '../polarH10';

const { parseSettingsResponse, parseEcgFrame, parseAccFrame, buildEcgStart, ctrlStatus, pmdStatusName } =
  __pmdInternal;

const dv = (bytes: number[]): DataView => new DataView(new Uint8Array(bytes).buffer);

/** Control-point response header: F0, opcode, measType, status, moreFrames. */
const respHeader = (opcode: number, measType: number, status = 0, more = 0): number[] => [
  0xf0,
  opcode,
  measType,
  status,
  more,
];

describe('parseSettingsResponse', () => {
  it('reads the TLVs after the more-frames byte, not over it', () => {
    // Real-shaped ACC reply: rates 25/50/100/200, resolution 16, ranges 2/4/8.
    const resp = dv([
      ...respHeader(0x01, 0x02),
      0x00, 0x04, 25, 0, 50, 0, 100, 0, 200, 0, // SAMPLE_RATE
      0x01, 0x01, 16, 0, // RESOLUTION
      0x02, 0x03, 2, 0, 4, 0, 8, 0, // RANGE
    ]);
    const m = parseSettingsResponse(resp);
    expect(m.get(0x00)).toEqual([25, 50, 100, 200]);
    expect(m.get(0x01)).toEqual([16]);
    expect(m.get(0x02)).toEqual([2, 4, 8]);
  });

  it('reads the ECG reply (130 Hz, 14-bit)', () => {
    const resp = dv([
      ...respHeader(0x01, 0x00),
      0x00, 0x01, 130, 0,
      0x01, 0x01, 14, 0,
    ]);
    const m = parseSettingsResponse(resp);
    expect(m.get(0x00)).toEqual([130]);
    expect(m.get(0x01)).toEqual([14]);
  });

  it('still reads a reply that omits the more-frames byte', () => {
    const resp = dv([0xf0, 0x01, 0x00, 0x00, 0x00, 0x01, 130, 0]);
    expect(parseSettingsResponse(resp).get(0x00)).toEqual([130]);
  });

  it('returns an empty map for a short error response rather than inventing settings', () => {
    expect(parseSettingsResponse(dv([0xf0, 0x01, 0x00, 0x05])).size).toBe(0);
  });

  it('ignores anything that is not a control-point response', () => {
    expect(parseSettingsResponse(dv([0x00, 0x01, 0x02, 0x03, 0x04, 0x05])).size).toBe(0);
  });
});

describe('ctrlStatus / pmdStatusName', () => {
  it('extracts the status byte', () => {
    expect(ctrlStatus(dv(respHeader(0x02, 0x00, 5)))).toBe(5);
    expect(ctrlStatus(dv(respHeader(0x02, 0x00, 0)))).toBe(0);
  });

  it('returns null when the frame is not a control-point response', () => {
    expect(ctrlStatus(dv([0x00, 0x01]))).toBeNull();
  });

  it('names the codes a rejection actually reports', () => {
    expect(pmdStatusName(5)).toBe('INVALID_PARAMETER');
    expect(pmdStatusName(3)).toBe('NOT_SUPPORTED');
    expect(pmdStatusName(13)).toBe('DEVICE_IN_CHARGER');
    expect(pmdStatusName(99)).toBe('UNKNOWN_99');
  });
});

describe('buildEcgStart', () => {
  it('emits the canonical H10 command when the device offered nothing', () => {
    const { cmd, sampleRateHz } = buildEcgStart(new Map());
    expect(Array.from(cmd)).toEqual([0x02, 0x00, 0x00, 0x01, 0x82, 0x00, 0x01, 0x01, 0x0e, 0x00]);
    expect(sampleRateHz).toBe(130);
  });

  it('echoes back what the device offered', () => {
    const { cmd, sampleRateHz } = buildEcgStart(
      new Map([
        [0x00, [130]],
        [0x01, [14]],
      ]),
    );
    expect(Array.from(cmd)).toEqual([0x02, 0x00, 0x00, 0x01, 0x82, 0x00, 0x01, 0x01, 0x0e, 0x00]);
    expect(sampleRateHz).toBe(130);
  });

  it('takes an offered rate over the preferred one', () => {
    const { cmd, sampleRateHz } = buildEcgStart(new Map([[0x00, [200]]]));
    expect(sampleRateHz).toBe(200);
    expect(Array.from(cmd).slice(4, 6)).toEqual([0xc8, 0x00]);
  });

  it('never includes a RANGE setting — ECG has none and it is rejected', () => {
    const { cmd } = buildEcgStart(new Map([[0x02, [8]]]));
    // TLV type bytes sit at 2 and 6 in a two-setting command.
    expect(cmd.length).toBe(10);
    expect(cmd[2]).toBe(0x00); // SAMPLE_RATE
    expect(cmd[6]).toBe(0x01); // RESOLUTION
  });
});

describe('parseEcgFrame', () => {
  /** type, u64 timestamp, frameType, then 3-byte signed LE samples. */
  const ecgFrame = (samples: number[], frameType = 0x00): DataView => {
    const bytes = [0x00, 1, 2, 3, 4, 5, 6, 7, 8, frameType];
    for (const v of samples) {
      const u = v < 0 ? v + 0x1000000 : v;
      bytes.push(u & 0xff, (u >> 8) & 0xff, (u >> 16) & 0xff);
    }
    return dv(bytes);
  };

  it('decodes signed 24-bit little-endian microvolts', () => {
    expect(parseEcgFrame(ecgFrame([0, 1000, -1000, 8388607, -8388608]))).toEqual([
      0, 1000, -1000, 8388607, -8388608,
    ]);
  });

  it('decodes a realistic QRS run', () => {
    const qrs = [-110, -40, 300, 1000, 420, -220, -60];
    expect(parseEcgFrame(ecgFrame(qrs))).toEqual(qrs);
  });

  it('rejects a frame that is not ECG', () => {
    const f = ecgFrame([1, 2, 3]);
    f.setUint8(0, 0x02); // accelerometer
    expect(parseEcgFrame(f)).toEqual([]);
  });

  it('rejects an unknown frame type instead of decoding garbage', () => {
    expect(parseEcgFrame(ecgFrame([1, 2, 3], 0x01))).toEqual([]);
  });

  it('ignores a truncated frame', () => {
    expect(parseEcgFrame(dv([0x00, 1, 2, 3]))).toEqual([]);
  });
});

describe('parseAccFrame (unchanged by the ECG work)', () => {
  it('decodes a raw int16 triplet frame', () => {
    const bytes = [0x02, 1, 2, 3, 4, 5, 6, 7, 8, 0x01];
    const push = (v: number): void => {
      const u = v < 0 ? v + 0x10000 : v;
      bytes.push(u & 0xff, (u >> 8) & 0xff);
    };
    push(-38);
    push(112);
    push(978);
    push(-35);
    push(115);
    push(981);
    expect(parseAccFrame(dv(bytes))).toEqual([
      { x: -38, y: 112, z: 978 },
      { x: -35, y: 115, z: 981 },
    ]);
  });

  it('ignores an ECG frame arriving on the shared characteristic', () => {
    expect(parseAccFrame(dv([0x00, 1, 2, 3, 4, 5, 6, 7, 8, 0x00, 1, 2, 3, 4, 5, 6]))).toEqual([]);
  });
});
