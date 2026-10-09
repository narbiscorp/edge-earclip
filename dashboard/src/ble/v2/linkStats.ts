/*
 * linkStats.ts — link-health bookkeeping for a V2 earclip stream.
 *
 * Answers "is the data I'm looking at complete and trustworthy?" without a
 * logic analyser: lost PPG batches (seq gaps), stream restarts, batches the
 * firmware itself flagged (clipped, AGC settling, off-ear, gated), decode
 * failures, the sample rate implied by the DEVICE clock, and how far the
 * device's own drop / I²C error counters moved since we started watching.
 *
 * Pure (no BLE, no DOM): narbisDevice feeds it live, and the recording
 * export replays the stored batches through a fresh instance so the zip's
 * link_stats.json describes exactly the data in the zip.
 */
import {
  ACCF_FIFO_OVERRUN, PPGF_AGC_SETTLING, PPGF_CLIPPED, PPGF_GATE, PPGF_WEAR_OFF,
  RATE_SPS,
  type V2AccelBatch, type V2PpgBatch, type V2Status,
} from './protocol';

export interface V2LinkStatsSnapshot {
  /** Host ms when counting started (connect, or recording start). */
  since: number;
  ppgBatches: number;
  ppgSamples: number;
  /** Batches missing between consecutive seq numbers (BLE or device drops). */
  ppgLostBatches: number;
  /** seq went backwards — the device restarted acquisition (seq resets to 0). */
  ppgSeqRestarts: number;
  clippedBatches: number;
  agcSettlingBatches: number;
  wearOffBatches: number;
  gatedBatches: number;
  /** Nominal rate of the latest batch. */
  nominalSps: number | null;
  /** Rate implied by the device clock over the current gap-free run. */
  measuredSps: number | null;
  ibiPackets: number;
  ibiRecords: number;
  ibiLostPackets: number;
  accelBatches: number;
  accelSamples: number;
  accelLostBatches: number;
  /** Accel batches flagged FIFO_OVERRUN (the LIS2DH12 FIFO filled before drain). */
  accelFifoOverruns: number;
  eventPackets: number;
  statusFrames: number;
  parseErrors: number;
  lastParseError: string | null;
  /** Device notification-drop counter (STATUS) — first seen and latest. */
  deviceDropsStart: number | null;
  deviceDrops: number | null;
  /** Device I²C error counter (STATUS) — first seen and latest. */
  i2cErrorsStart: number | null;
  i2cErrors: number | null;
}

const U32 = 0x1_0000_0000;
const SEQ_RESTART = -1;
const SEQ_DUPLICATE = -2;

/** Packets lost between `last` and `seq` on a u32 counter that restarts at
 * 0 whenever acquisition starts (firmware acq_afe.c "seq contract: 0 at
 * start"). SEQ_RESTART when it went backwards, SEQ_DUPLICATE when equal. */
function seqDelta(last: number, seq: number): number {
  const diff = (seq - last + U32) % U32;
  if (diff === 0) return SEQ_DUPLICATE;
  if (diff >= U32 / 2) return SEQ_RESTART;
  return diff - 1;
}

export class V2LinkStats {
  private s: V2LinkStatsSnapshot = V2LinkStats.empty(0);
  private lastPpgSeq: number | null = null;
  private lastIbiSeq: number | null = null;
  private lastAccelSeq: number | null = null;
  /* Measured-rate run: restarted on a rate change, stream restart or lost
   * batch, so one dropout can't bias the estimate. */
  private runRate: number | null = null;
  private runT0Us = 0;
  private runLastT0Us = 0;
  private runLastN = 0;
  private runSamplesBeforeLast = 0;
  private runLostMark = 0;

  constructor(nowMs = 0) {
    this.reset(nowMs);
  }

  static empty(since: number): V2LinkStatsSnapshot {
    return {
      since, ppgBatches: 0, ppgSamples: 0, ppgLostBatches: 0, ppgSeqRestarts: 0,
      clippedBatches: 0, agcSettlingBatches: 0, wearOffBatches: 0, gatedBatches: 0,
      nominalSps: null, measuredSps: null,
      ibiPackets: 0, ibiRecords: 0, ibiLostPackets: 0,
      accelBatches: 0, accelSamples: 0, accelLostBatches: 0, accelFifoOverruns: 0,
      eventPackets: 0,
      statusFrames: 0, parseErrors: 0, lastParseError: null,
      deviceDropsStart: null, deviceDrops: null, i2cErrorsStart: null, i2cErrors: null,
    };
  }

  reset(nowMs: number): void {
    this.s = V2LinkStats.empty(nowMs);
    this.lastPpgSeq = null;
    this.lastIbiSeq = null;
    this.lastAccelSeq = null;
    this.runRate = null;
  }

  onPpg(b: Pick<V2PpgBatch, 'seq' | 't0Us' | 'rateCode' | 'flags' | 'ir'>): void {
    const s = this.s;
    const n = b.ir.length;
    s.ppgBatches += 1;
    s.ppgSamples += n;
    if (b.flags & PPGF_CLIPPED) s.clippedBatches += 1;
    if (b.flags & PPGF_AGC_SETTLING) s.agcSettlingBatches += 1;
    if (b.flags & PPGF_WEAR_OFF) s.wearOffBatches += 1;
    if (b.flags & PPGF_GATE) s.gatedBatches += 1;
    s.nominalSps = RATE_SPS[b.rateCode] ?? null;

    let restarted = false;
    if (this.lastPpgSeq !== null) {
      const d = seqDelta(this.lastPpgSeq, b.seq);
      if (d === SEQ_RESTART) {
        s.ppgSeqRestarts += 1;
        restarted = true;
      } else if (d > 0) {
        s.ppgLostBatches += d;
      }
    }
    this.lastPpgSeq = b.seq;

    if (restarted || this.runRate !== b.rateCode || b.t0Us <= this.runLastT0Us ||
        s.ppgLostBatches !== this.runLostMark) {
      this.runRate = b.rateCode;
      this.runT0Us = b.t0Us;
      this.runSamplesBeforeLast = 0;
      this.runLostMark = s.ppgLostBatches;
    } else {
      this.runSamplesBeforeLast += this.runLastN;
    }
    this.runLastT0Us = b.t0Us;
    this.runLastN = n;
    const spanUs = this.runLastT0Us - this.runT0Us;
    if (spanUs > 0 && this.runSamplesBeforeLast > 0) {
      s.measuredSps = this.runSamplesBeforeLast / (spanUs / 1e6);
    }
  }

  onIbi(seq: number, nRecords: number): void {
    const s = this.s;
    s.ibiPackets += 1;
    s.ibiRecords += nRecords;
    if (this.lastIbiSeq !== null) {
      const d = seqDelta(this.lastIbiSeq, seq);
      if (d > 0) s.ibiLostPackets += d;
    }
    this.lastIbiSeq = seq;
  }

  onAccel(b: Pick<V2AccelBatch, 'seq' | 'flags' | 'x'>): void {
    const s = this.s;
    s.accelBatches += 1;
    s.accelSamples += b.x.length;
    if (b.flags & ACCF_FIFO_OVERRUN) s.accelFifoOverruns += 1;
    if (this.lastAccelSeq !== null) {
      const d = seqDelta(this.lastAccelSeq, b.seq);
      if (d > 0) s.accelLostBatches += d;
    }
    this.lastAccelSeq = b.seq;
  }

  onEvent(): void {
    this.s.eventPackets += 1;
  }

  onStatus(st: Pick<V2Status, 'notifDropCount' | 'i2cErrCount'>): void {
    const s = this.s;
    s.statusFrames += 1;
    if (s.deviceDropsStart === null) s.deviceDropsStart = st.notifDropCount;
    if (s.i2cErrorsStart === null) s.i2cErrorsStart = st.i2cErrCount;
    s.deviceDrops = st.notifDropCount;
    s.i2cErrors = st.i2cErrCount;
  }

  onParseError(phase: string, message: string): void {
    this.s.parseErrors += 1;
    this.s.lastParseError = `${phase}: ${message}`;
  }

  snapshot(): V2LinkStatsSnapshot {
    return { ...this.s };
  }
}
