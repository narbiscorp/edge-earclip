import { describe, it, expect } from 'vitest';
import { signalBars, signalBarsGlyph } from '../signalBars';
import { parseV2Status, STATUS_SIZE } from '../../ble/v2/protocol';

describe('earclip signal as five bars', () => {
  it('buckets dBm like a phone: >= -55 five ... below -95 none', () => {
    expect([-40, -55, -56, -65, -70, -75, -80, -85, -90, -95, -96, -110].map(signalBars))
      .toEqual([5, 5, 4, 4, 3, 3, 2, 2, 1, 1, 0, 0]);
    expect(signalBars(null)).toBeNull();
    expect(signalBarsGlyph(-70)).toBe('▮▮▮▯▯');
    expect(signalBarsGlyph(null)).toBe('');
  });

  it("reads STATUS byte 30 as the link RSSI (proto 1.5); 127 and older firmware's 0 are unknown", () => {
    const b = new Uint8Array(STATUS_SIZE);
    const v = new DataView(b.buffer);
    v.setInt8(30, -58);
    expect(parseV2Status(v).connRssiDbm).toBe(-58);
    v.setInt8(30, 127);
    expect(parseV2Status(v).connRssiDbm).toBeNull();
    v.setInt8(30, 0);
    expect(parseV2Status(v).connRssiDbm).toBeNull();
  });
});
