import { describe, it, expect } from 'vitest';
import { LinkStatsTracker, TPS_DATA_CHAR, TPS_DATA_SERVICE, TPS_FRAME_BYTES, toHex } from '../../ble/tpsDevice';

describe('TPS link statistics', () => {
  it('counts notifications, bytes and frames and measures gaps', () => {
    const tr = new LinkStatsTracker(2000);
    tr.onPacket(1000, 70);
    tr.onPacket(1100, 70);
    tr.onPacket(1300, 35);
    const s = tr.stats;
    expect(s.notifications).toBe(3);
    expect(s.bytes).toBe(175);
    expect(s.frames).toBe(Math.floor(175 / TPS_FRAME_BYTES));
    expect(s.firstAt).toBe(1000);
    expect(s.lastAt).toBe(1300);
    expect(s.lastGapMs).toBe(200);
    expect(s.maxGapMs).toBe(200);
    expect(s.sizes).toEqual({ 70: 2, 35: 1 });
  });

  it('measures rates over the sliding window', () => {
    const tr = new LinkStatsTracker(2000);
    // 10 packets of 70 B, 100 ms apart → 10 notif/s, 700 B/s, 100 frames/s
    for (let i = 0; i < 10; i++) tr.onPacket(1000 + i * 100, 70);
    expect(tr.stats.notifPerSec).toBeCloseTo(10, 5);
    expect(tr.stats.bytesPerSec).toBeCloseTo(700, 5);
    expect(tr.stats.framesPerSec).toBeCloseTo(100, 5);
    // packets older than the window fall out of the rate but not out of the totals
    tr.onPacket(10000, 70);
    expect(tr.stats.notifications).toBe(11);
    expect(tr.stats.notifPerSec).toBe(0);
  });

  it('reset clears everything', () => {
    const tr = new LinkStatsTracker();
    tr.onPacket(1, 7);
    tr.reset();
    expect(tr.stats.notifications).toBe(0);
    expect(tr.stats.firstAt).toBeNull();
    expect(tr.stats.sizes).toEqual({});
  });
});

describe('TPS constants and helpers', () => {
  it('uses the TT service / characteristic UUIDs and the nominal frame size', () => {
    expect(TPS_DATA_SERVICE).toBe('0200180d-4202-eba1-ed11-5e727adcdef0');
    expect(TPS_DATA_CHAR).toBe('02002b08-4202-eba1-ed11-5e727adcdef0');
    expect(TPS_FRAME_BYTES).toBe(7);
  });

  it('formats hex with a cap', () => {
    expect(toHex(new Uint8Array([0, 15, 255]))).toBe('00 0f ff');
    expect(toHex(new Uint8Array(70), 4)).toBe('00 00 00 00 … (+66)');
  });
});
