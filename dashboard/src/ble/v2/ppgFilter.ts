/*
 * ppgFilter.ts — host-side display/analysis filter chain for V2 raw PPG.
 *
 * The device streams raw 22-bit AFE counts: a large DC pedestal (tissue +
 * LED coupling) with a pulsatile AC component typically 0.1–2 % of it. Plotted
 * raw, the heartbeat is invisible. This chain is what makes the wave readable:
 *
 *   raw → DC remove (1-pole HP) → band-pass (cascaded biquads) → [mains notch] → out
 *
 * The mains notch ([MainsNotch]) also runs on its own over the Raw chart, which plots counts and
 * never goes through the rest of the chain: lights put tens of thousands of counts of hum on it.
 *
 * Coefficients are RBJ-cookbook biquads, recomputed whenever the rate or a
 * corner changes. Everything is streaming/stateful so it can run per-sample as
 * BLE batches arrive.
 *
 * Sign convention: in transmissive PPG more blood absorbs more light, so a
 * systolic peak is a DIP in raw counts. `invert` (default true) flips the
 * output so peaks point up, matching how clinicians expect to read a
 * plethysmogram — and matching what the beat detector wants.
 */

export interface PpgFilterConfig {
  /** samples per second of the incoming stream */
  sampleRate: number;
  /** DC-removal high-pass corner, Hz. Below ~0.3 Hz baseline wander survives;
   * above ~0.8 Hz the pulse waveform's shape starts to distort. */
  hpFc: number;
  /** band-pass low corner, Hz (≈ lowest plausible heart rate) */
  bpLo: number;
  /** band-pass high corner, Hz (harmonics above ~8 Hz are noise for PPG) */
  bpHi: number;
  /** Mains frequency to notch, Hz: 60, 50, or 0 = off. Notched where it lands once sampled
   * ([mainsAliasesHz]), on the Raw and the Filtered charts. Display only: recordings keep the counts. */
  mainsHz: MainsHz;
  /** flip so systolic peaks point up (see note above) */
  invert: boolean;
}

/** The mains to notch: 60 Hz (the default, North America), 50 Hz, or 0 = off. */
export type MainsHz = 0 | 50 | 60;

export const PPG_FILTER_DEFAULTS: PpgFilterConfig = {
  sampleRate: 100,
  hpFc: 0.5,
  bpLo: 0.5,
  bpHi: 8.0,
  mainsHz: 60,
  invert: true,
};

interface BiquadCoeffs { b0: number; b1: number; b2: number; a1: number; a2: number }

/** Direct-form-I biquad. DF-I is chosen over DF-II for numerical headroom:
 * the input here is a large-amplitude count signal before DC removal. */
class Biquad {
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;
  constructor(private c: BiquadCoeffs) {}
  reset(): void { this.x1 = this.x2 = this.y1 = this.y2 = 0; }
  /** Start as if [x] had been the input forever — for a unity-DC-gain section (a notch) that is
   * also the output, so a pedestal of ~10^6 counts passes without a startup transient. */
  prime(x: number): void { this.x1 = this.x2 = this.y1 = this.y2 = x; }
  setCoeffs(c: BiquadCoeffs): void { this.c = c; }
  step(x: number): number {
    const { b0, b1, b2, a1, a2 } = this.c;
    const y = b0 * x + b1 * this.x1 + b2 * this.x2 - a1 * this.y1 - a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

function lowpass(fs: number, fc: number, q: number): BiquadCoeffs {
  const w0 = (2 * Math.PI * fc) / fs;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const alpha = sw / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 - cw) / 2) / a0,
    b1: (1 - cw) / a0,
    b2: ((1 - cw) / 2) / a0,
    a1: (-2 * cw) / a0,
    a2: (1 - alpha) / a0,
  };
}

function highpass(fs: number, fc: number, q: number): BiquadCoeffs {
  const w0 = (2 * Math.PI * fc) / fs;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const alpha = sw / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 + cw) / 2) / a0,
    b1: (-(1 + cw)) / a0,
    b2: ((1 + cw) / 2) / a0,
    a1: (-2 * cw) / a0,
    a2: (1 - alpha) / a0,
  };
}

function notch(fs: number, f0: number, q: number): BiquadCoeffs {
  const w0 = (2 * Math.PI * f0) / fs;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const alpha = sw / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: 1 / a0,
    b1: (-2 * cw) / a0,
    b2: 1 / a0,
    a1: (-2 * cw) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** Aliases below this are left alone: they sit on the pulse and its harmonics (or on the DC
 * pedestal itself), and a notch there would cost more of the waveform than it removes. */
const MIN_ALIAS_HZ = 12;
/** Wide on purpose: the AFE's real rate is ~99.4–99.7 sps, not 100, which moves the aliases
 * by up to ~1 Hz; nothing the PPG needs lives anywhere near them. */
const MAINS_NOTCH_Q = 3;

/**
 * Where mains interference lands in a stream sampled at [fs]: harmonics 1..[harmonics] of
 * [mainsHz] folded into 0..fs/2, the ones too close to the pulse dropped, duplicates merged.
 *
 * Nothing above fs/2 exists in a sampled signal, so a notch "at 60 Hz" on a 100 sps stream is
 * impossible — the old one was clamped to 47.5 Hz and did nothing. Hum arrives ALIASED: 60 Hz
 * wiring folds to 40 Hz, and lights flicker at twice the mains (120 Hz), which folds to 20 Hz;
 * 180 and 240 Hz land on 20 and 40 again. 50 Hz mains folds to the Nyquist edge (notched just
 * below it) and its 100 Hz flicker to ~0 Hz, which no notch can take without the pedestal.
 */
export function mainsAliasesHz(mainsHz: number, fs: number, harmonics = 4): number[] {
  if (!(mainsHz > 0) || !(fs > 0)) return [];
  const nyq = fs / 2;
  const out: number[] = [];
  for (let k = 1; k <= harmonics; k++) {
    let a = (k * mainsHz) % fs;
    if (a > nyq) a = fs - a;
    a = Math.min(a, nyq * 0.99);
    if (a < MIN_ALIAS_HZ) continue;
    if (out.some((x) => Math.abs(x - a) < 1)) continue;
    out.push(a);
  }
  return out.sort((x, y) => x - y);
}

/**
 * The mains notch: one biquad notch per alias ([mainsAliasesHz]), primed with the first sample so
 * a raw pedestal passes untouched. No sections (off, or nothing to notch) passes samples through.
 */
export class MainsNotch {
  private sections: Biquad[] = [];
  private primed = false;
  private aliases: number[] = [];

  constructor(private mainsHz: number, private fs: number) {
    this.rebuild();
  }

  /** Where it is notching, Hz (empty when off). */
  get notchesHz(): number[] { return this.aliases; }

  update(mainsHz: number, fs: number): void {
    if (mainsHz === this.mainsHz && fs === this.fs) return;
    this.mainsHz = mainsHz;
    this.fs = fs;
    this.rebuild();
  }

  reset(): void {
    this.sections.forEach((s) => s.reset());
    this.primed = false;
  }

  step(x: number): number {
    if (this.sections.length === 0) return x;
    if (!this.primed) {
      this.primed = true;
      this.sections.forEach((s) => s.prime(x));
    }
    let y = x;
    for (const s of this.sections) y = s.step(y);
    return y;
  }

  private rebuild(): void {
    this.aliases = mainsAliasesHz(this.mainsHz, this.fs);
    this.sections = this.aliases.map((f) => new Biquad(notch(this.fs, f, MAINS_NOTCH_Q)));
    this.primed = false;
  }
}

/** Clamp corners to something the sample rate can actually represent, so a
 * bad UI value degrades instead of producing NaN-poisoned filter state. */
function sane(cfg: PpgFilterConfig): PpgFilterConfig {
  const fs = Math.max(1, cfg.sampleRate);
  const nyq = fs / 2;
  const hpFc = Math.min(Math.max(cfg.hpFc, 0.01), nyq * 0.9);
  const bpLo = Math.min(Math.max(cfg.bpLo, 0.01), nyq * 0.9);
  const bpHi = Math.min(Math.max(cfg.bpHi, bpLo + 0.05), nyq * 0.95);
  const mainsHz: MainsHz = cfg.mainsHz === 50 || cfg.mainsHz === 0 ? cfg.mainsHz : 60;
  return { ...cfg, sampleRate: fs, hpFc, bpLo, bpHi, mainsHz };
}

export class PpgFilter {
  private cfg: PpgFilterConfig;
  private dcHp: Biquad;
  private bpHp: Biquad;
  private bpLp1: Biquad;
  private bpLp2: Biquad;
  private mains: MainsNotch;
  private primed = false;

  constructor(cfg: Partial<PpgFilterConfig> = {}) {
    this.cfg = sane({ ...PPG_FILTER_DEFAULTS, ...cfg });
    const c = this.cfg;
    this.dcHp = new Biquad(highpass(c.sampleRate, c.hpFc, 0.707));
    this.bpHp = new Biquad(highpass(c.sampleRate, c.bpLo, 0.707));
    /* Two cascaded LP sections ≈ 4th-order roll-off, Butterworth Qs. */
    this.bpLp1 = new Biquad(lowpass(c.sampleRate, c.bpHi, 0.541));
    this.bpLp2 = new Biquad(lowpass(c.sampleRate, c.bpHi, 1.307));
    this.mains = new MainsNotch(c.mainsHz, c.sampleRate);
  }

  get config(): PpgFilterConfig { return this.cfg; }

  /** Re-derive coefficients in place. State is kept (so the trace doesn't
   * jump) unless the sample rate changed, which invalidates it entirely. */
  update(patch: Partial<PpgFilterConfig>): void {
    const next = sane({ ...this.cfg, ...patch });
    const rateChanged = next.sampleRate !== this.cfg.sampleRate;
    this.cfg = next;
    this.dcHp.setCoeffs(highpass(next.sampleRate, next.hpFc, 0.707));
    this.bpHp.setCoeffs(highpass(next.sampleRate, next.bpLo, 0.707));
    this.bpLp1.setCoeffs(lowpass(next.sampleRate, next.bpHi, 0.541));
    this.bpLp2.setCoeffs(lowpass(next.sampleRate, next.bpHi, 1.307));
    this.mains.update(next.mainsHz, next.sampleRate);
    if (rateChanged) this.reset();
  }

  reset(): void {
    this.dcHp.reset(); this.bpHp.reset();
    this.bpLp1.reset(); this.bpLp2.reset();
    this.mains.reset();
    this.primed = false;
  }

  /** Filter one raw sample. */
  push(raw: number): number {
    if (!Number.isFinite(raw)) return 0;
    /* Prime the DC section with the first sample so the filter doesn't spend
     * seconds slewing up from zero on a pedestal of ~10^6 counts. */
    if (!this.primed) {
      this.primed = true;
      for (let i = 0; i < 4; i++) this.dcHp.step(raw);
    }
    let y = this.dcHp.step(raw);
    y = this.bpHp.step(y);
    y = this.bpLp1.step(y);
    y = this.bpLp2.step(y);
    y = this.mains.step(y);
    return this.cfg.invert ? -y : y;
  }
}
