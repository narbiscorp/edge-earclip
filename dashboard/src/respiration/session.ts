/*
 * session.ts — device wiring + the 1 Hz analysis tick.
 *
 * Owns three things and nothing else:
 *   1. Subscribing to the Polar H10 (RR + 3-axis ACC) and the Narbis earclip
 *      (IBI), and appending everything they emit to `sessionLog`.
 *   2. Feeding the SAME beats and ACC packets into the app-side Coherence
 *      Engine, so the coherence plotted here is the engine's real output rather
 *      than a reimplementation of it.
 *   3. Ticking once a second: hand the analysis window to the metrics worker,
 *      merge the engine status into the result, append one MetricRow.
 *
 * The engine is started in Mode A with a no-op lens sink. Mode A is the honest
 * choice for an analysis tool: it follows the breath the subject is actually
 * taking instead of pacing them toward a rate, so the coherence trace describes
 * the session rather than steering it. No glasses are driven from this page.
 */
import MetricsWorker from '../workers/metricsWorker?worker';
import type { MetricsRequest, MetricsResult } from '../workers/metricsWorker';
import {
  polarH10,
  type PolarBeatEvent,
  type PolarAccEvent,
  type PolarEcgEvent,
  type PolarAccInfoDetail,
} from '../ble/polarH10';
import { narbisDevice, type NarbisBeatEvent } from '../ble/narbisDevice';
import { coherenceEngine, type EngineStatus } from '../engine/coherenceEngine';
import { RespirationFromACC } from '../engine/respirationFromAcc';
import { DEFAULT_TUNABLES } from '../engine/tunables';
import {
  NARBIS_BEAT_FLAG_ARTIFACT,
  NARBIS_BEAT_FLAG_LOW_SQI,
  NARBIS_BEAT_FLAG_LOW_CONFIDENCE,
} from '../ble/parsers';
import { sessionLog, type BeatSource, type MetricRow } from './log';

const ARTIFACT_FLAGS =
  NARBIS_BEAT_FLAG_ARTIFACT | NARBIS_BEAT_FLAG_LOW_SQI | NARBIS_BEAT_FLAG_LOW_CONFIDENCE;

/* An RR outside this band is not a heartbeat — it is a dropped or doubled beat.
 * Flagged, never dropped: it stays in the log and the CSV, and only the
 * analysis window skips it. */
const PLAUSIBLE_IBI_MIN_MS = 300;
const PLAUSIBLE_IBI_MAX_MS = 2000;

export type LogLevel = 'info' | 'warn' | 'error';

export interface SessionEventDetail {
  message: string;
  level: LogLevel;
  timestamp: number;
}

export interface SessionState {
  polar: 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
  earclip: 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
  polarName: string | null;
  earclipName: string | null;
  accStreaming: boolean;
  /** Raw ECG stream (Polar H10 PMD type 0x00, 130 Hz). */
  ecgStreaming: boolean;
  engineRunning: boolean;
  /** Synthetic signal from ?demo=1. Surfaced everywhere it could be mistaken
   * for a measurement, including the export manifest. */
  demo: boolean;
  /** Which beat source drives the HRV metrics + the coherence engine. */
  analysisSource: BeatSource;
  analysisWindowSec: number;
}

const DEFAULT_ANALYSIS_WINDOW_SEC = 64;

class RespirationSession extends EventTarget {
  private worker: Worker | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private requestId = 0;
  private inFlight = false;
  private lastEngineStatus: EngineStatus | null = null;

  /* Our own accelerometer respiration estimator.
   *
   * The engine has one internally, but it only PUBLISHES the measured rate at a
   * breath boundary while a resonance controller exists — i.e. Mode B and
   * Mode C after handoff. This page runs Mode A, where that branch never
   * executes, so `EngineStatus.accMeasuredBpm` is permanently null.
   *
   * Rather than change engine behaviour the glasses depend on, run a second
   * instance of the SAME estimator with the SAME tunables, fed the same
   * samples, and read it at 1 Hz. Identical math, published unconditionally. */
  private resp = new RespirationFromACC({ ...DEFAULT_TUNABLES });

  private state: SessionState = {
    polar: 'disconnected',
    earclip: 'disconnected',
    polarName: null,
    earclipName: null,
    accStreaming: false,
    ecgStreaming: false,
    engineRunning: false,
    demo: false,
    analysisSource: 'h10',
    analysisWindowSec: DEFAULT_ANALYSIS_WINDOW_SEC,
  };

  /** Mark this session as demo-driven. The synthetic source dispatches on the
   * real PolarH10 event surface, so the only thing that must change is that we
   * stop trying to open a GATT accelerometer stream that does not exist. */
  setDemo(demo: boolean): void {
    this.patch({ demo });
  }

  getState(): SessionState {
    return { ...this.state };
  }

  getEngineStatus(): EngineStatus | null {
    return this.lastEngineStatus;
  }

  private patch(next: Partial<SessionState>): void {
    this.state = { ...this.state, ...next };
    this.dispatchEvent(new CustomEvent<SessionState>('state', { detail: this.getState() }));
  }

  private log(message: string, level: LogLevel = 'info'): void {
    this.dispatchEvent(
      new CustomEvent<SessionEventDetail>('log', {
        detail: { message, level, timestamp: Date.now() },
      }),
    );
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /** Attach BLE listeners and start the analysis tick. Idempotent. */
  start(): void {
    if (this.worker) return;
    this.worker = new MetricsWorker();
    this.worker.addEventListener('message', this.onWorkerMessage);

    polarH10.addEventListener('connected', this.onPolarConnected as EventListener);
    polarH10.addEventListener('disconnected', this.onPolarDisconnected as EventListener);
    polarH10.addEventListener('beatReceived', this.onPolarBeat as EventListener);
    polarH10.addEventListener('accReceived', this.onPolarAcc as EventListener);
    polarH10.addEventListener('ecgReceived', this.onPolarEcg as EventListener);
    polarH10.addEventListener('accInfo', this.onPolarAccInfo as EventListener);

    narbisDevice.addEventListener('connected', this.onEarclipConnected as EventListener);
    narbisDevice.addEventListener('disconnected', this.onEarclipDisconnected as EventListener);
    narbisDevice.addEventListener('beatReceived', this.onEarclipBeat as EventListener);

    this.timer = setInterval(() => this.tick(), 1000);
  }

  /** Detach everything. Leaves the log intact — teardown is not a data event. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.worker) {
      this.worker.removeEventListener('message', this.onWorkerMessage);
      this.worker.terminate();
      this.worker = null;
    }
    polarH10.removeEventListener('connected', this.onPolarConnected as EventListener);
    polarH10.removeEventListener('disconnected', this.onPolarDisconnected as EventListener);
    polarH10.removeEventListener('beatReceived', this.onPolarBeat as EventListener);
    polarH10.removeEventListener('accReceived', this.onPolarAcc as EventListener);
    polarH10.removeEventListener('ecgReceived', this.onPolarEcg as EventListener);
    polarH10.removeEventListener('accInfo', this.onPolarAccInfo as EventListener);
    narbisDevice.removeEventListener('connected', this.onEarclipConnected as EventListener);
    narbisDevice.removeEventListener('disconnected', this.onEarclipDisconnected as EventListener);
    narbisDevice.removeEventListener('beatReceived', this.onEarclipBeat as EventListener);
    this.resp.reset();
    this.stopEngine();
  }

  setAnalysisSource(source: BeatSource): void {
    if (source === this.state.analysisSource) return;
    this.patch({ analysisSource: source });
    this.log(`Analysis source → ${source === 'h10' ? 'Polar H10' : 'Narbis earclip'}`);
    // The engine's ingest gate and Mode B eligibility both depend on the source,
    // so restart it rather than feeding a stream it thinks came from elsewhere.
    if (this.state.engineRunning) {
      this.stopEngine();
      this.startEngine();
    }
  }

  setAnalysisWindowSec(sec: number): void {
    this.patch({ analysisWindowSec: sec });
  }

  // ── connection ───────────────────────────────────────────────────────────

  async connectPolar(): Promise<void> {
    this.patch({ polar: 'connecting' });
    try {
      await polarH10.connect();
    } catch (err) {
      this.patch({ polar: 'disconnected' });
      this.log(`Polar H10 connect failed: ${(err as Error).message}`, 'error');
      throw err;
    }
  }

  async disconnectPolar(): Promise<void> {
    await polarH10.disconnect();
  }

  async connectEarclip(): Promise<void> {
    this.patch({ earclip: 'connecting' });
    try {
      await narbisDevice.connect();
    } catch (err) {
      this.patch({ earclip: 'disconnected' });
      this.log(`Earclip connect failed: ${(err as Error).message}`, 'error');
      throw err;
    }
  }

  async disconnectEarclip(): Promise<void> {
    await narbisDevice.disconnect();
  }

  /** The accelerometer stream is what makes this a RESPIRATION tool rather than
   * an HRV tool — it is the only independent measurement of the breath. */
  async startAcc(): Promise<void> {
    try {
      await polarH10.startAccStream();
      this.patch({ accStreaming: polarH10.isAccStreaming });
    } catch (err) {
      this.patch({ accStreaming: false });
      this.log(`ACC stream failed: ${(err as Error).message}`, 'error');
      throw err;
    }
  }

  async stopAcc(): Promise<void> {
    await polarH10.stopAccStream();
    this.patch({ accStreaming: false });
  }

  /** Raw ECG. Off by default: it is 130 Hz of data nobody needs for respiration work, and it
   * costs H10 battery. Turn it on when you actually want to look at the waveform. */
  async startEcg(): Promise<void> {
    try {
      await polarH10.startEcgStream();
      this.patch({ ecgStreaming: polarH10.isEcgStreaming });
    } catch (err) {
      this.patch({ ecgStreaming: false });
      this.log(`ECG stream failed: ${(err as Error).message}`, 'error');
      throw err;
    }
  }

  async stopEcg(): Promise<void> {
    await polarH10.stopEcgStream();
    this.patch({ ecgStreaming: false });
  }

  // ── engine ───────────────────────────────────────────────────────────────

  startEngine(): void {
    if (this.state.engineRunning) return;
    coherenceEngine.start({
      mode: 'modeA',
      source: this.state.analysisSource === 'h10' ? 'polarH10' : 'edgeRelay',
      tunables: { ...DEFAULT_TUNABLES },
      // Nothing is driven from this page — the lens sink exists only because the
      // engine requires one. Analysis must not put light in anyone's eyes.
      onLens: () => {},
    });
    this.patch({ engineRunning: true });
    this.log('Coherence engine started (Mode A — follow, no pacing)');
  }

  stopEngine(): void {
    if (!this.state.engineRunning) return;
    coherenceEngine.stop();
    this.lastEngineStatus = null;
    this.patch({ engineRunning: false });
    this.log('Coherence engine stopped');
  }

  // ── device events ────────────────────────────────────────────────────────

  private onPolarConnected = (ev: CustomEvent<{ name: string }>): void => {
    this.patch({ polar: 'connected', polarName: ev.detail.name });
    this.log(`Polar H10 connected: ${ev.detail.name}`);
    if (!this.state.engineRunning) this.startEngine();
    // Auto-start ACC: it is the point of this page, and asking twice is friction.
    // The demo source emits ACC frames itself, with no GATT session to open.
    if (!this.state.demo) {
      void this.startAcc().catch(() => {
        /* already surfaced via the accInfo/error log */
      });
    }
  };

  private onPolarDisconnected = (ev: CustomEvent<{ reason: string }>): void => {
    const reconnecting = ev.detail.reason === 'gatt';
    this.patch({
      polar: reconnecting ? 'reconnecting' : 'disconnected',
      accStreaming: false,
      ecgStreaming: false,
      polarName: reconnecting ? this.state.polarName : null,
    });
    this.log(`Polar H10 disconnected (${ev.detail.reason})`, reconnecting ? 'warn' : 'info');
    coherenceEngine.onDisconnect();
    // The strap may come back on a different body — never carry a breathing
    // estimate across the gap.
    this.resp.reset();
  };

  private onPolarAccInfo = (ev: CustomEvent<PolarAccInfoDetail>): void => {
    this.log(`ACC: ${ev.detail.message}`, ev.detail.level);
    if (ev.detail.level !== 'error') this.patch({ accStreaming: polarH10.isAccStreaming });
  };

  private onPolarBeat = (ev: CustomEvent<PolarBeatEvent>): void => {
    const { rrIntervals_ms, beatTimestamps, bpm } = ev.detail;
    for (let i = 0; i < rrIntervals_ms.length; i++) {
      const ibi = rrIntervals_ms[i];
      // Prefer the monotonic per-RR clock; fall back to notify time only if the
      // strap sent an RR count the clock did not cover.
      const t = beatTimestamps[i] ?? ev.detail.timestamp;
      sessionLog.addBeat(t, ibi, ibi > 0 ? 60000 / ibi : bpm, 'h10', !isPlausible(ibi));
    }
    if (this.state.analysisSource === 'h10' && rrIntervals_ms.length > 0) {
      coherenceEngine.onH10RR(rrIntervals_ms, 100, ev.detail.timestamp / 1000);
    }
  };

  private onPolarAcc = (ev: CustomEvent<PolarAccEvent>): void => {
    const { samples, lastSampleMs, sampleRateHz } = ev.detail;
    sessionLog.addAccBlock(samples, lastSampleMs, sampleRateHz);
    if (coherenceEngine.running) coherenceEngine.onAccPacket(samples, lastSampleMs / 1000);
    // Same per-sample stamping the engine uses: the newest sample lands at the
    // frame timestamp and the rest are spaced backwards from it.
    const tArrivalS = lastSampleMs / 1000;
    const n = samples.length;
    for (let i = 0; i < n; i++) {
      this.resp.push(
        samples[i].x,
        samples[i].y,
        samples[i].z,
        tArrivalS - (n - 1 - i) / Math.max(1, sampleRateHz),
      );
    }
    if (!this.state.accStreaming) this.patch({ accStreaming: true });
  };

  private onPolarEcg = (ev: CustomEvent<PolarEcgEvent>): void => {
    const { samples, lastSampleMs, sampleRateHz } = ev.detail;
    sessionLog.addEcgBlock(samples, lastSampleMs, sampleRateHz);
    if (!this.state.ecgStreaming) this.patch({ ecgStreaming: true });
  };

  private onEarclipConnected = (ev: CustomEvent<{ name: string }>): void => {
    this.patch({ earclip: 'connected', earclipName: ev.detail.name });
    this.log(`Earclip connected: ${ev.detail.name}`);
  };

  private onEarclipDisconnected = (ev: CustomEvent<{ reason: string }>): void => {
    const reconnecting = ev.detail.reason === 'gatt';
    this.patch({
      earclip: reconnecting ? 'reconnecting' : 'disconnected',
      earclipName: reconnecting ? this.state.earclipName : null,
    });
    this.log(`Earclip disconnected (${ev.detail.reason})`, reconnecting ? 'warn' : 'info');
  };

  private onEarclipBeat = (ev: CustomEvent<NarbisBeatEvent>): void => {
    const b = ev.detail;
    const flagged = (b.flags & ARTIFACT_FLAGS) !== 0 || !isPlausible(b.ibi_ms);
    sessionLog.addBeat(b.timestamp, b.ibi_ms, b.bpm, 'earclip', flagged);
    if (this.state.analysisSource === 'earclip' && !flagged) {
      coherenceEngine.onRR(b.ibi_ms, b.confidence, b.timestamp / 1000);
    }
  };

  // ── 1 Hz analysis ────────────────────────────────────────────────────────

  private tick(): void {
    if (!this.worker || this.inFlight) return;
    // Nothing has ever arrived — don't manufacture a row. A metrics stream that
    // starts before the first heartbeat is a stream of fabricated values.
    if (sessionLog.beatCount === 0) return;
    const now = Date.now();
    const win = sessionLog.analysisWindow(
      this.state.analysisWindowSec,
      now,
      this.state.analysisSource,
    );
    // Lomb-Scargle on 3 points is noise, not a spectrum. Below this we still
    // emit a row so the 1 Hz series has no silent hole, but with every computed
    // field null rather than zero.
    if (win.times_s.length < 4) {
      this.appendRow(now, win.times_s.length, null);
      return;
    }
    this.inFlight = true;
    const msg: MetricsRequest = {
      type: 'compute',
      requestId: ++this.requestId,
      times_s: win.times_s,
      ibis_ms: win.ibis_ms,
      beat_ms: win.beat_ms,
    };
    // Transfer the buffers — they are freshly built per tick and never reused.
    this.worker.postMessage(msg, [win.times_s.buffer, win.ibis_ms.buffer, win.beat_ms.buffer]);
  }

  private onWorkerMessage = (ev: MessageEvent<MetricsResult>): void => {
    this.inFlight = false;
    const r = ev.data;
    if (!r || r.type !== 'result') return;
    this.appendRow(Date.now(), r.beatCount, r);
  };

  /** Merge the worker result (may be absent on a short window) with the live
   * engine status into one row. Engine fields are read at append time so they
   * are as fresh as the tick, not as fresh as the worker round trip. */
  private appendRow(t: number, beatCount: number, r: MetricsResult | null): void {
    const st = this.state.engineRunning ? coherenceEngine.getStatus() : null;
    this.lastEngineStatus = st;
    // Prefer the engine's own reading when it has one (Mode B/C); otherwise use
    // our parallel estimator, which is the only source in Mode A.
    const accResp = this.resp.estimate();
    const accRespBpm = st?.accMeasuredBpm ?? (accResp ? accResp.bpm : null);
    const accRespConfidence = st?.accMeasuredBpm != null
      ? st.accRespConfidence
      : accResp
        ? accResp.confidence
        : null;
    const row: MetricRow = {
      t,
      beatCount,
      windowSec: this.state.analysisWindowSec,
      meanHr: r ? r.time.meanHr : null,
      sdnn: r ? r.time.sdnn : null,
      rmssd: r ? r.time.rmssd : null,
      pnn50: r ? r.time.pnn50 : null,
      lf: r ? r.freq.lf : null,
      hf: r ? r.freq.hf : null,
      lfHfRatio: r ? r.freq.lfHfRatio : null,
      totalPower: r ? r.freq.totalPower : null,
      engineCoherence: st ? st.coherence : null,
      engineCr: st ? st.cr : null,
      engineRespHz: st ? st.respHz : null,
      enginePacerBpm: st ? st.pacerBpm : null,
      breathHeartCoherence: st ? st.breathHeartCoherence : null,
      breathHeartPhaseDeg: st ? st.breathHeartPhaseDeg : null,
      accRespBpm,
      accRespConfidence,
      hmCoherence: r ? r.hmCoherence.score : null,
      resonanceCoherence: r ? r.resonanceCoherence.score : null,
      resonanceFreqHz: r ? r.resonanceCoherence.peakFreq_hz : null,
      firmwareCoherence: r?.firmwareCoherence ?? null,
      firmwareRespHz: r?.firmwareRespFreq_hz ?? null,
    };
    sessionLog.addMetric(row);
    this.dispatchEvent(new CustomEvent<MetricRow>('metric', { detail: row }));
  }
}

function isPlausible(ibiMs: number): boolean {
  return ibiMs >= PLAUSIBLE_IBI_MIN_MS && ibiMs <= PLAUSIBLE_IBI_MAX_MS;
}

export const respirationSession = new RespirationSession();
