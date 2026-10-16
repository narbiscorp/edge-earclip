/*
 * signalBars.ts — Bluetooth signal strength as five bars, like a phone's cell signal.
 * Shared buckets (dBm) with the Android app: >= -55 five, -65 four, -75 three, -85 two,
 * -95 one, below that none.
 */
const STEPS = [-55, -65, -75, -85, -95];

/** 0..5 bars for an RSSI in dBm; null for unknown. */
export function signalBars(dbm: number | null | undefined): number | null {
  if (dbm == null || !Number.isFinite(dbm)) return null;
  const i = STEPS.findIndex((s) => dbm >= s);
  return i < 0 ? 0 : 5 - i;
}

/** "▮▮▮▯▯" for 3 of 5 bars; '' for unknown. */
export function signalBarsGlyph(dbm: number | null | undefined): string {
  const n = signalBars(dbm);
  return n === null ? '' : '▮'.repeat(n) + '▯'.repeat(5 - n);
}
