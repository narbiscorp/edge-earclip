import { describe, it, expect, vi, afterEach } from 'vitest';
import { ClockCorrector, patFor, recentMedian } from '../ptt';

afterEach(() => vi.useRealTimers());

describe('pulse arrival time pieces', () => {
  it('moves mapped times onto the fastest packet of the last minute', () => {
    const c = new ClockCorrector(60_000);
    expect(c.offset()).toBeNull();
    // Mapped 450 ms late (a stale first-packet anchor); packets take 20-200 ms.
    for (let i = 0; i < 100; i++) {
      const sent = 10_000 + i * 500;
      c.observe(sent + 450, sent + 20 + (i % 9) * 20);
    }
    expect(c.offset()).toBe(-430); // corrected = mapped - 430 = sent + 20
    // A minute on, the old minimum has left the window.
    for (let i = 0; i < 150; i++) {
      const sent = 70_000 + i * 500;
      c.observe(sent + 450, sent + 60 + (i % 3) * 10);
    }
    expect(c.offset()).toBe(-390);
  });

  it('pairs a beat with the latest R 80-600 ms before it', () => {
    const r = [1000, 1900, 2800];
    expect(patFor(2100, r)).toBe(200);
    expect(patFor(1950, r)).toBeNull(); // 50 ms after an R is too soon, and the R before is 950 ms back
    expect(patFor(1990, r)).toBe(90);
    expect(patFor(2400, r)).toBe(500);
    expect(patFor(900, r)).toBeNull();
  });

  it('takes a median of the last n', () => {
    expect(recentMedian([5, 1, 9, 300, 7], 3)).toBe(9);
    expect(recentMedian([4, 2], 5)).toBe(3);
    expect(recentMedian([], 5)).toBeNull();
  });
});

describe('live PAT from H10 ECG + earclip beats, with both clocks mis-anchored', () => {
  it('reads the true 250 ms through a 400 ms H10 and a 450 ms earclip anchor error', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { polarH10 } = await import('../../ble/polarH10');
    const { narbisDevice } = await import('../../ble/narbisDevice');
    const { patBuffer, pttStats } = await import('../../state/pttState');
    const FS = 130, PAT = 250, T0 = 1_000_000;
    const beats: number[] = [];
    for (let t = T0 + 500; t < T0 + 40_000; t += 900) beats.push(t);
    const g = (t: number, mu: number, sd: number) => Math.exp(-0.5 * ((t - mu) / sd) ** 2);
    const lead = (t: number) => beats.reduce((a, b) => (Math.abs(t - b) < 400 ? a + 1000 * g(t, b, 9) - 250 * g(t, b + 25, 9) + 200 * g(t, b + 280, 45) : a), 0);

    // Interleave ECG frames (73 samples), earclip PPG batches and beat records in time order.
    const events: Array<{ at: number; fire: () => void }> = [];
    const N = 73;
    for (let k = 0; k * N < 40 * FS; k++) {
      const last = T0 + ((k + 1) * N - 1) * (1000 / FS);
      const samples = Array.from({ length: N }, (_, i) => lead(T0 + (k * N + i) * (1000 / FS)));
      const lat = 25 + (k % 4) * 30;
      events.push({ at: last + lat, fire: () => polarH10.dispatchEvent(new CustomEvent('ecgReceived', { detail: { samples, lastSampleMs: last + 400, sampleRateHz: FS } })) });
    }
    for (let k = 0; k < 40 * 100 / 6; k++) {
      const newest = T0 + (k * 6 + 5) * 10;
      events.push({ at: newest + 15 + (k % 5) * 20, fire: () => narbisDevice.dispatchEvent(new CustomEvent('v2PpgReceived', { detail: { batch: { ir: [0, 0, 0, 0, 0, 0] }, hostFirstMs: newest - 50 + 450, periodMs: 10 } })) });
    }
    for (const b of beats) {
      const pulse = b + PAT;
      events.push({ at: pulse + 200, fire: () => narbisDevice.dispatchEvent(new CustomEvent('v2IbiReceived', { detail: { seq: 0, records: [{ tBeatUs: 0, ibiMs: 900, confidence: 90, flags: 0x04, hostMs: pulse + 450 }] } })) });
    }
    events.sort((a, b) => a.at - b.at);
    for (const e of events) {
      vi.setSystemTime(e.at);
      e.fire();
    }
    const pats = patBuffer.getAll().map((s) => s.value.pat);
    expect(pats.length).toBeGreaterThan(30);
    // Each clock lands on its fastest packet: R reads 25 ms late, the pulse 15 ms late, so PAT - 10.
    for (const p of pats.slice(5)) expect(Math.abs(p - (PAT - 10))).toBeLessThan(3);
    expect(pttStats.paired).toBe(pats.length);
  });
});
