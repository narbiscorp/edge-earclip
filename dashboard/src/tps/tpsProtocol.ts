// VENDORED from narbiscorp/edge-ThoughtTechnology tps/protocol/tpsProtocol.ts — the reference
// implementation of the TPS biofeedback protocol. Do not edit here: change the reference, regenerate
// its vectors, then re-copy this file and src/tps/vectors/*.json.

/**
 * TPS biofeedback protocol — "Relax" (temperature ↑, skin conductance ↓, HRV ↑).
 *
 * Reference implementation. Spec: ../docs/TPS_BIOFEEDBACK_PROTOCOL.md. The Swift port
 * (edge-iOS-HRV) and the Kotlin port (edge-Android-HRV) replay the same vectors in
 * ./vectors and must match this file: duty exactly, R to 1e-6.
 *
 * Platform-neutral on purpose: no DOM, no Node, no timers. The host feeds the latest
 * sensor values as they arrive and calls tick() at ~10 Hz with its own clock.
 *
 * Written so it can be stripped of types by Node (no enums, no parameter properties).
 */

export interface TpsTunables {
  /** Seconds of valid contact used to capture the temperature / SC baseline. */
  baselineS: number
  /** Seconds of valid HRV used to capture the LF % baseline (starts when HRV first validates). */
  hrvBaselineS: number
  /** °C of rise above baseline that counts as full reward. */
  tempSpanC: number
  tauTempS: number
  /** Relative SC drop (fraction of baseline) that counts as full reward. */
  scSpanRel: number
  /** µS floor for the SC baseline so dry skin cannot explode the relative change. */
  scFloorUs: number
  tauScS: number
  /** Rising SC slope (µS/s) that counts as a full skin-conductance response. */
  scrSlopeUsPerS: number
  /** How much a full SCR subtracts from the SC score. */
  scrPenalty: number
  lfNeutralPct: number
  lfSpanPct: number
  tauHrvS: number
  wTemp: number
  wSc: number
  wHrv: number
  tauOutS: number
  /** Lens darkness (0 clear … 100 dark) when R = 0, during baseline, and when contact is lost. */
  neutralDuty: number
  gain: number
  maxSlewPerS: number
  deadband: number
  /** Contact lost for longer than this restarts the baseline. */
  baselineResetS: number
}

export const DEFAULT_TUNABLES: TpsTunables = {
  baselineS: 60,
  hrvBaselineS: 30,
  tempSpanC: 1.0,
  tauTempS: 5,
  scSpanRel: 0.3,
  scFloorUs: 0.5,
  tauScS: 3,
  scrSlopeUsPerS: 0.5,
  scrPenalty: 0.5,
  lfNeutralPct: 40,
  lfSpanPct: 30,
  tauHrvS: 4,
  wTemp: 0.35,
  wSc: 0.35,
  wHrv: 0.3,
  tauOutS: 2,
  neutralDuty: 40,
  gain: 0.8,
  maxSlewPerS: 60,
  deadband: 2,
  baselineResetS: 120,
}

export type TpsPhase = 'idle' | 'baseline' | 'training' | 'contact_lost'

export interface TpsChannelValidity {
  temp: boolean
  sc: boolean
  hrv: boolean
}

export interface TpsBaseline {
  tempC: number | null
  scUs: number | null
  lfPct: number | null
}

/** One row of the protocol chart; published on every tick. */
export interface TpsProtocolFrame {
  t: number
  phase: TpsPhase
  tempC: number | null
  scUs: number | null
  hr: number | null
  lfPct: number | null
  lfPower: number | null
  /** Per-channel scores, −1 … +1 (+1 = fully relaxed vs. baseline); null while invalid. */
  sTemp: number | null
  sSc: number | null
  sHrv: number | null
  /** Smoothed relaxation index, −1 … +1; null until the first valid channel. */
  r: number | null
  /** Lens darkness actually commanded this tick (after slew + dead-band), 0 … 100. */
  duty: number
  /** True when `duty` changed on this tick (i.e. the host should write it). */
  dutyChanged: boolean
  valid: TpsChannelValidity
  moving: boolean
  contact: boolean
  baseline: TpsBaseline
}

/** Window (seconds) over which the SC slope is measured for SCR detection. */
const SCR_WINDOW_S = 1.0
/** Minimum span of SC samples needed before a slope is trusted. */
const SCR_MIN_SPAN_S = 0.5
/** Seconds the output stays held after movement stops. */
const MOVE_HOLD_AFTER_S = 1.0
/** Seconds to ramp to neutral after contact is lost. */
const CONTACT_LOST_RAMP_S = 2.0

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/** EMA step with a time constant; alpha = 1 − e^(−dt/τ). */
const emaStep = (prev: number | null, next: number, dt: number, tauS: number): number => {
  if (prev === null) return next
  if (tauS <= 0) return next
  const a = 1 - Math.exp(-dt / tauS)
  return prev + a * (next - prev)
}

interface Accumulator {
  sum: number
  n: number
}

interface ScSample {
  t: number
  v: number
}

export class TpsProtocolEngine {
  readonly tunables: TpsTunables

  // Latest inputs
  private tempC: number | null = null
  private scUs: number | null = null
  private hr: number | null = null
  private lfPct: number | null = null
  private lfPower: number | null = null
  private hrvMissingS = 0
  private hrvSeen = false
  private contact = false
  private moving = false

  // Timing
  private lastTickT: number | null = null
  private contactStartT: number | null = null
  private contactLostT: number | null = null
  private movingStopT: number | null = null

  // Baseline capture
  private phase: TpsPhase = 'idle'
  private tempAcc: Accumulator = { sum: 0, n: 0 }
  private scAcc: Accumulator = { sum: 0, n: 0 }
  private lfAcc: Accumulator = { sum: 0, n: 0 }
  private hrvBaselineStartT: number | null = null
  private baseline: TpsBaseline = { tempC: null, scUs: null, lfPct: null }

  // Scores
  private sTemp: number | null = null
  private sScTonic: number | null = null
  private sHrv: number | null = null
  private rSmooth: number | null = null
  private scHistory: ScSample[] = []

  // Output
  private duty: number
  private lastEmittedDuty: number
  private dutyPos: number

  constructor(tunables?: Partial<TpsTunables>) {
    this.tunables = { ...DEFAULT_TUNABLES, ...(tunables ?? {}) }
    this.duty = this.tunables.neutralDuty
    this.lastEmittedDuty = this.tunables.neutralDuty
    this.dutyPos = this.tunables.neutralDuty
  }

  /** Forget everything, including the baseline. Use at session start. */
  reset(): void {
    this.tempC = null
    this.scUs = null
    this.hr = null
    this.lfPct = null
    this.lfPower = null
    this.hrvMissingS = 0
    this.hrvSeen = false
    this.contact = false
    this.moving = false
    this.lastTickT = null
    this.contactStartT = null
    this.contactLostT = null
    this.movingStopT = null
    this.resetBaseline()
    this.rSmooth = null
    this.duty = this.tunables.neutralDuty
    this.lastEmittedDuty = this.tunables.neutralDuty
    this.dutyPos = this.tunables.neutralDuty
  }

  private resetBaseline(): void {
    this.phase = 'idle'
    this.tempAcc = { sum: 0, n: 0 }
    this.scAcc = { sum: 0, n: 0 }
    this.lfAcc = { sum: 0, n: 0 }
    this.hrvBaselineStartT = null
    this.baseline = { tempC: null, scUs: null, lfPct: null }
    this.sTemp = null
    this.sScTonic = null
    this.sHrv = null
    this.scHistory = []
  }

  // ---- inputs -------------------------------------------------------------

  onTemperature(c: number, _tS?: number): void {
    if (!Number.isFinite(c)) return
    this.tempC = c
  }

  onSkinConductance(us: number, tS: number): void {
    if (!Number.isFinite(us)) return
    this.scUs = us
    this.scHistory.push({ t: tS, v: us })
    // keep a little more than the window so the oldest sample straddles it
    const cutoff = tS - SCR_WINDOW_S * 1.5
    while (this.scHistory.length > 2 && this.scHistory[0].t < cutoff) this.scHistory.shift()
  }

  onHeartRate(bpm: number): void {
    if (!Number.isFinite(bpm)) return
    this.hr = bpm
  }

  /**
   * HRV from the SDK: lfPct is the LF band percentage (0–100), lfPower the absolute LF
   * power, missingS the seconds the 64 s window is missing (0 = trustworthy).
   */
  onHrv(lfPct: number, lfPower: number, missingS: number, _tS?: number): void {
    if (!Number.isFinite(lfPct)) return
    this.lfPct = lfPct
    this.lfPower = Number.isFinite(lfPower) ? lfPower : null
    this.hrvMissingS = Number.isFinite(missingS) && missingS > 0 ? missingS : 0
    this.hrvSeen = true
  }

  onContact(on: boolean, tS: number): void {
    if (on === this.contact) return
    this.contact = on
    if (on) {
      this.contactLostT = null
      if (this.phase === 'idle') {
        this.contactStartT = tS
        this.phase = 'baseline'
      } else if (this.phase === 'contact_lost') {
        this.phase = this.baseline.tempC === null && this.baseline.scUs === null ? 'baseline' : 'training'
        if (this.phase === 'baseline') this.contactStartT = tS
      }
    } else {
      this.contactLostT = tS
      if (this.phase !== 'idle') this.phase = 'contact_lost'
      this.scHistory = []
    }
  }

  onMovement(moving: boolean, tS: number): void {
    if (moving === this.moving) return
    this.moving = moving
    if (!moving) this.movingStopT = tS
  }

  // ---- tick ---------------------------------------------------------------

  tick(tS: number): TpsProtocolFrame {
    const tn = this.tunables
    const dt = this.lastTickT === null ? 0.1 : Math.max(1e-3, tS - this.lastTickT)
    this.lastTickT = tS

    // Contact lost long enough → the next contact starts a fresh baseline.
    if (this.phase === 'contact_lost' && this.contactLostT !== null && tS - this.contactLostT > tn.baselineResetS) {
      this.resetBaseline()
      this.phase = 'contact_lost'
    }

    // Baseline capture (temperature + SC), only while in contact.
    if (this.phase === 'baseline' && this.contact && this.contactStartT !== null) {
      if (this.tempC !== null) { this.tempAcc.sum += this.tempC; this.tempAcc.n++ }
      if (this.scUs !== null) { this.scAcc.sum += this.scUs; this.scAcc.n++ }
      if (tS - this.contactStartT >= tn.baselineS) {
        this.baseline.tempC = this.tempAcc.n > 0 ? this.tempAcc.sum / this.tempAcc.n : null
        this.baseline.scUs = this.scAcc.n > 0 ? this.scAcc.sum / this.scAcc.n : null
        this.phase = 'training'
      }
    }

    // HRV baseline runs on its own clock: from the first trustworthy HRV value.
    const hrvTrust = this.hrvSeen && this.lfPct !== null && this.hrvMissingS === 0 && this.contact
    if (hrvTrust && this.baseline.lfPct === null && this.phase === 'training') {
      if (this.hrvBaselineStartT === null) this.hrvBaselineStartT = tS
      this.lfAcc.sum += this.lfPct as number
      this.lfAcc.n++
      if (tS - this.hrvBaselineStartT >= tn.hrvBaselineS) {
        this.baseline.lfPct = this.lfAcc.sum / this.lfAcc.n
      }
    }

    const training = this.phase === 'training'
    const valid: TpsChannelValidity = {
      temp: training && this.contact && this.tempC !== null && this.baseline.tempC !== null,
      sc: training && this.contact && this.scUs !== null && this.baseline.scUs !== null,
      hrv: training && hrvTrust && this.baseline.lfPct !== null,
    }

    // ---- per-channel scores
    if (valid.temp) {
      const dT = (this.tempC as number) - (this.baseline.tempC as number)
      this.sTemp = emaStep(this.sTemp, clamp(dT / tn.tempSpanC, -1, 1), dt, tn.tauTempS)
    }

    let sSc: number | null = null
    if (valid.sc) {
      const base = Math.max(this.baseline.scUs as number, tn.scFloorUs)
      const r = ((this.scUs as number) - (this.baseline.scUs as number)) / base
      this.sScTonic = emaStep(this.sScTonic, clamp(-r / tn.scSpanRel, -1, 1), dt, tn.tauScS)
      const slope = this.scSlope(tS)
      const pScr = clamp(slope / tn.scrSlopeUsPerS, 0, 1)
      sSc = clamp(this.sScTonic - tn.scrPenalty * pScr, -1, 1)
    }

    if (valid.hrv) {
      const lf = this.lfPct as number
      const sAbs = clamp((lf - tn.lfNeutralPct) / tn.lfSpanPct, -1, 1)
      const sRel = clamp((lf - (this.baseline.lfPct as number)) / tn.lfSpanPct, -1, 1)
      this.sHrv = emaStep(this.sHrv, 0.5 * sAbs + 0.5 * sRel, dt, tn.tauHrvS)
    }

    // ---- combine
    let wSum = 0
    let acc = 0
    if (valid.temp && this.sTemp !== null) { acc += tn.wTemp * this.sTemp; wSum += tn.wTemp }
    if (valid.sc && sSc !== null) { acc += tn.wSc * sSc; wSum += tn.wSc }
    if (valid.hrv && this.sHrv !== null) { acc += tn.wHrv * this.sHrv; wSum += tn.wHrv }
    const anyValid = wSum > 0

    // ---- target duty
    const holdForMovement =
      this.moving || (this.movingStopT !== null && tS - this.movingStopT < MOVE_HOLD_AFTER_S)

    let target: number
    let slew = tn.maxSlewPerS
    if (this.phase === 'contact_lost') {
      target = tn.neutralDuty
      slew = Math.max(slew, Math.abs(this.dutyPos - tn.neutralDuty) / CONTACT_LOST_RAMP_S)
    } else if (!training) {
      target = tn.neutralDuty
    } else if (holdForMovement || !anyValid) {
      target = this.dutyPos
    } else {
      const r = acc / wSum
      this.rSmooth = emaStep(this.rSmooth, r, dt, tn.tauOutS)
      target = clamp(tn.neutralDuty - tn.gain * 100 * this.rSmooth, 0, 100)
    }

    // ---- slew limit + dead-band
    const maxStep = slew * dt
    const delta = clamp(target - this.dutyPos, -maxStep, maxStep)
    this.dutyPos = clamp(this.dutyPos + delta, 0, 100)
    const rounded = Math.round(this.dutyPos)
    let dutyChanged = false
    if (Math.abs(rounded - this.lastEmittedDuty) >= tn.deadband || (rounded !== this.lastEmittedDuty && (rounded === 0 || rounded === 100))) {
      this.lastEmittedDuty = rounded
      this.duty = rounded
      dutyChanged = true
    }

    return {
      t: tS,
      phase: this.phase,
      tempC: this.tempC,
      scUs: this.scUs,
      hr: this.hr,
      lfPct: this.lfPct,
      lfPower: this.lfPower,
      sTemp: valid.temp ? this.sTemp : null,
      sSc: valid.sc ? sSc : null,
      sHrv: valid.hrv ? this.sHrv : null,
      r: this.rSmooth,
      duty: this.duty,
      dutyChanged,
      valid,
      moving: this.moving,
      contact: this.contact,
      baseline: { ...this.baseline },
    }
  }

  /** Rising SC slope (µS/s) over the last ~1 s; 0 when there is not enough history. */
  private scSlope(tS: number): number {
    const h = this.scHistory
    if (h.length < 2) return 0
    const newest = h[h.length - 1]
    // oldest sample inside the window
    let oldest = h[0]
    for (let i = 0; i < h.length; i++) {
      if (h[i].t >= tS - SCR_WINDOW_S) { oldest = h[i]; break }
    }
    const span = newest.t - oldest.t
    if (span < SCR_MIN_SPAN_S) return 0
    return (newest.v - oldest.v) / span
  }
}
