/*
 * coherenceEngine.ts — main-thread orchestrator singleton for the app-side Coherence Engine.
 *
 * Adapts the Swift `CoherenceEngine` to the browser: single-threaded (no NSLock), self-driving
 * timers, and a `onDuty` output callback the host wires to the glasses' 0xA5 lens-duty opcode.
 * SessionLogger (offline research export) is intentionally omitted — the dashboard has its own
 * recording pipeline. Status is published via CustomEvents on this EventTarget.
 *
 * Cadences (mirrors the Swift orchestration note):
 *   • on each H10 RR notification  → onH10RR(...)        (ingest + artifact gate + Mode B cycle-clean tally)
 *   • on each H10 ACC packet       → onAccPacket(...)     [Mode B only]
 *   • 1 Hz                         → tick1Hz()            (LS → CR + resp readback → pacer.push)
 *   • per breathing-cycle boundary → onBreathBoundary()   (pacer.latch and/or Mode B controller)
 *   • ~lens rate (default ~12 Hz)  → emit 0–100 duty via onDuty
 */
import { type CoherenceTunables, DEFAULT_TUNABLES } from './tunables';
import { IBIIngest } from './ibiIngest';
import { LombScargleCore } from './lombScargleCore';
import { FollowPacer } from './followPacer';
import { FastAmplitudeTracker } from './fastAmplitude';
import { RespirationFromACC } from './respirationFromAcc';
import { ResonanceController, type ModeBState } from './resonanceController';
import { Program2Lens, breatheFraction, breatheDuty } from './lensPrograms';

export type { EngineMode } from './tunables';

export type HRVSource = 'polarH10' | 'edgeRelay' | 'appleWatch';
export type ActiveEngineMode = 'modeA' | 'modeB';
export type LensStyle = 'breathe' | 'program2';

/** Mode B needs validated RR + an independent respiration channel (H10 ACC). */
function allowsModeB(source: HRVSource): boolean {
  return source === 'polarH10';
}

export interface EngineStatus {
  running: boolean;
  mode: ActiveEngineMode;
  source: HRVSource;
  coherence: number; // squashed lens drive 0..100
  cr: number; // field-standard coherence ratio
  respHz: number; // LS resonance readback
  pacerBpm: number; // current pacer rate
  duty: number; // last lens duty sent 0..100
  beats: number; // beats currently in the analysis window
  // Mode B
  modeBState: ModeBState | null;
  /** The breathing rate (BPM) the controller is currently pacing/testing. */
  modeBCommandedBpm: number | null;
  lockedRF: number | null; // valid only when maintaining
  boundaryLimited: boolean;
  searchAborted: boolean;
  unverifiedDwells: number;
}

export interface StartOptions {
  mode: ActiveEngineMode;
  source: HRVSource;
  tunables: CoherenceTunables;
  /** 0..100 lens brightness ceiling. */
  brightness?: number;
  /** 0..3 difficulty (Program-2 lens only). */
  difficulty?: number;
  lensStyle?: LensStyle;
  /** Persisted per-user resonance frequency for a warm Mode B start. */
  priorRF?: number | null;
  /** Sink for the 0–100 lens duty stream (host wires this to edgeDevice 0xA5). */
  onDuty: (duty: number) => void;
}

const LENS_TICK_MS = 83; // ~12 Hz lens-duty stream (smooth breathing, BLE-friendly)

export class CoherenceEngine extends EventTarget {
  private t: CoherenceTunables = { ...DEFAULT_TUNABLES };
  private source: HRVSource = 'polarH10';
  private mode: ActiveEngineMode = 'modeA';
  private brightness = 100;
  private difficulty = 1;
  private lensStyle: LensStyle = 'breathe';
  private onDuty: ((duty: number) => void) | null = null;

  private ingest = new IBIIngest(this.t);
  private ls = new LombScargleCore(this.t);
  private pacer = new FollowPacer(this.t);
  private program2 = new Program2Lens(this.t);
  private amplitude = new FastAmplitudeTracker(this.t);
  private resp = new RespirationFromACC(this.t);
  private modeB: ResonanceController | null = null;

  private secTimer: ReturnType<typeof setInterval> | null = null;
  private lensTimer: ReturnType<typeof setInterval> | null = null;

  // breath-cycle clock
  private cycleMs = 10_000; // default 6 BPM
  private cycleStartMs = 0;

  // Mode B cycle-clean tally (engine-owned, derived from its own gate)
  private gatedBeatsThisCycle = 0;

  // published outputs
  private _coherence = 0;
  private _cr = 0;
  private _respHz = 0;
  private _lastDuty = 0;

  get running(): boolean {
    return this.secTimer !== null;
  }

  /** Build/replace all sub-components against the current tunables object. */
  private rebuild(): void {
    this.ingest = new IBIIngest(this.t);
    this.ls = new LombScargleCore(this.t);
    this.pacer = new FollowPacer(this.t);
    this.program2 = new Program2Lens(this.t);
    this.amplitude = new FastAmplitudeTracker(this.t);
    this.resp = new RespirationFromACC(this.t);
  }

  start(opts: StartOptions): void {
    this.stop();
    // Copy tunables into our own object so sub-components share one live reference.
    this.t = { ...opts.tunables };
    this.source = opts.source;
    this.mode = opts.mode;
    this.brightness = opts.brightness ?? 100;
    this.difficulty = opts.difficulty ?? 1;
    this.lensStyle = opts.lensStyle ?? 'breathe';
    this.onDuty = opts.onDuty;
    this.rebuild();

    if (this.mode === 'modeB' && allowsModeB(this.source)) {
      this.modeB = new ResonanceController(this.t, opts.priorRF ?? undefined);
      // Snap the pacer to the controller's start rate so the first dwell isn't measured mid-slew.
      this.pacer.snapToBPM(this.modeB.commandedBPM);
    } else {
      this.modeB = null;
    }

    this.cycleMs = this.pacer.latch();
    this.cycleStartMs = nowMs();
    this._coherence = 0;
    this._cr = 0;
    this._respHz = 0;
    this._lastDuty = 0;
    this.gatedBeatsThisCycle = 0;

    this.secTimer = setInterval(() => this.tick1Hz(), 1000);
    this.lensTimer = setInterval(() => this.lensTick(), LENS_TICK_MS);
    this.emitStatus();
  }

  stop(): void {
    if (this.secTimer) {
      clearInterval(this.secTimer);
      this.secTimer = null;
    }
    if (this.lensTimer) {
      clearInterval(this.lensTimer);
      this.lensTimer = null;
    }
    this.modeB = null;
    this.onDuty = null;
    this.ingest.reset();
    this.resp.reset();
    this.emitStatus();
  }

  /** Live-tune: apply changed tunable values without dropping engine state where possible. */
  setTunables(next: CoherenceTunables): void {
    const gridChanged =
      next.lsFreqLo !== this.t.lsFreqLo ||
      next.lsFreqHi !== this.t.lsFreqHi ||
      next.lsDf !== this.t.lsDf;
    // Mutate the shared object in place so every sub-component sees the new values.
    Object.assign(this.t, next);
    if (gridChanged) this.ls = new LombScargleCore(this.t);
  }

  setBrightness(b: number): void {
    this.brightness = Math.max(0, Math.min(100, b));
  }
  setDifficulty(d: number): void {
    this.difficulty = Math.max(0, Math.min(3, Math.round(d)));
  }

  /** Converged Mode B RF (only when maintaining), for the host to persist. */
  storedRF(): number | null {
    return this.modeB?.state === 'maintaining' ? this.modeB.lockedRF : null;
  }

  // --- input callbacks ---

  /** Primary H10 path. `rrsMs` straight from the BLE HR-Measurement parse (oldest-first). */
  onH10RR(rrsMs: number[], confidence: number, tArrivalS: number): void {
    const rr1024 = rrsMs.map((ms) => Math.max(0, Math.min(65535, Math.round((ms * 1024.0) / 1000.0))));
    const tally = this.ingest.pushH10(rr1024, confidence, tArrivalS);
    if (tally.rejected > 0) this.gatedBeatsThisCycle += tally.rejected;
  }

  /** Non-H10 single-beat path (e.g. edge relay / earclip). */
  onRR(rrMs: number, confidence: number, nowS: number): void {
    const ok = this.ingest.push(rrMs, confidence, nowS);
    if (!ok) this.gatedBeatsThisCycle += 1;
  }

  /** H10 ACC packet: a block of samples sharing one arrival time (Mode B only). */
  onAccPacket(samples: Array<{ x: number; y: number; z: number }>, tArrivalS: number): void {
    if (!allowsModeB(this.source)) return;
    const n = samples.length;
    for (let i = 0; i < n; i++) {
      const st = tArrivalS - (n - 1 - i) / Math.max(1.0, this.t.accSampleHz); // newest lands at tArrivalS
      this.resp.push(samples[i].x, samples[i].y, samples[i].z, st);
    }
  }

  /** Single ACC sample (non-batched sources). */
  onAcc(x: number, y: number, z: number, nowS: number): void {
    if (!allowsModeB(this.source)) return;
    this.resp.push(x, y, z, nowS);
  }

  /** Call on source disconnect so a new session never inherits stale state. */
  onDisconnect(): void {
    this.ingest.reset();
    this.resp.reset();
  }

  getStatus(): EngineStatus {
    return {
      running: this.running,
      mode: this.mode,
      source: this.source,
      coherence: this._coherence,
      cr: this._cr,
      respHz: this._respHz,
      pacerBpm: this.pacer.currentQuintet / 5.0,
      duty: this._lastDuty,
      beats: this.ingest.window(this.t.coherenceWindowS).length,
      modeBState: this.modeB?.state ?? null,
      modeBCommandedBpm: this.modeB ? this.modeB.commandedBPM : null,
      lockedRF: this.modeB?.state === 'maintaining' ? this.modeB.lockedRF : null,
      boundaryLimited: this.modeB?.boundaryLimited ?? false,
      searchAborted: this.modeB?.searchAborted ?? false,
      unverifiedDwells: this.modeB?.unverifiedDwells ?? 0,
    };
  }

  // --- timers ---

  /** 1 Hz tick — Mode A coherence + resonance readback. */
  private tick1Hz(): void {
    const r = this.ls.compute(this.ingest.window(this.t.coherenceWindowS));
    if (r) {
      this.pacer.push(r.respPeakMhz); // feeds the follow pacer
      this._coherence = r.cohPercent;
      this._cr = r.cr;
      this._respHz = r.respPeakHz;
    }
    this.emitStatus();
  }

  /** Per breathing-cycle boundary. Advances the pacer (and Mode B controller), returns nothing. */
  private onBreathBoundary(nowS: number): void {
    const cycleClean = this.gatedBeatsThisCycle === 0;
    this.gatedBeatsThisCycle = 0;

    if (this.modeB) {
      const amp = this.amplitude.amplitude(
        this.ingest.window(this.t.coherenceWindowS),
        this.modeB.commandedBPM,
      );
      const r = this.resp.estimate();
      const pacedBPM = this.pacer.currentQuintet / 5.0;
      const bpm = this.modeB.onBreathCycle({
        cycleAmplitude: amp,
        measuredBPM: r ? r.bpm : null,
        respConfidence: r ? r.confidence : 0,
        pacedBPM,
        dwellArtifactClean: cycleClean,
        nowS,
      });
      this.pacer.setTargetBPM(bpm); // Mode B drives; pacer slews smoothly
    }
    this.cycleMs = this.pacer.latch();
    this.emitStatus();
  }

  /** ~12 Hz lens-duty stream + breath-boundary detection. */
  private lensTick(): void {
    const now = nowMs();
    let elapsed = now - this.cycleStartMs;
    if (elapsed >= this.cycleMs) {
      this.onBreathBoundary(now / 1000.0);
      this.cycleStartMs = now;
      elapsed = 0;
    }
    const frac = breatheFraction(Math.floor(elapsed), Math.floor(this.cycleMs), this.t);
    const duty =
      this.lensStyle === 'program2'
        ? this.program2.duty(this._coherence, this.brightness, this.difficulty)
        : breatheDuty(frac, this._coherence, this.brightness, this.t);
    const out = Math.round(Math.max(0, Math.min(100, duty)));
    this._lastDuty = out;
    this.onDuty?.(out);
  }

  private emitStatus(): void {
    this.dispatchEvent(new CustomEvent<EngineStatus>('status', { detail: this.getStatus() }));
  }
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** Shared singleton — mirrors `edgeDevice` / `polarH10`. */
export const coherenceEngine = new CoherenceEngine();
