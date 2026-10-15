// VENDORED from narbiscorp/edge-ThoughtTechnology tps/protocol/scenarios.ts (see tpsProtocol.ts banner).

/**
 * Deterministic synthetic TPS sessions used both by the tests and to generate the golden
 * vectors the Swift and Kotlin ports replay. No randomness: every port must produce the same
 * input stream from the same scenario name.
 *
 * Each scenario is a function of time returning the sensor state at that instant; `sample()`
 * turns it into the event stream a real SDK would deliver (temperature ~1 Hz, SC 4 Hz,
 * HRV 4 Hz after 64 s, contact/movement edges).
 */

export interface ScenarioState {
  tempC: number
  scUs: number
  hr: number
  /** null before the SDK's 64 s window has filled. */
  lfPct: number | null
  lfPower: number | null
  hrvMissingS: number
  contact: boolean
  moving: boolean
}

export type Scenario = (t: number) => ScenarioState

export interface ScenarioEvent {
  t: number
  kind: 'temp' | 'sc' | 'hr' | 'hrv' | 'contact' | 'moving'
  v: number
  v2?: number
  v3?: number
}

const lerp = (a: number, b: number, u: number): number => a + (b - a) * Math.min(1, Math.max(0, u))

/** Calm session: hand warms 1.5 °C, SC falls 25 %, LF % climbs to 75 once HRV is in. */
export const relax: Scenario = (t) => ({
  tempC: 31.0 + 1.5 * (t / 300),
  scUs: 4.0 * (1 - 0.25 * (t / 300)),
  hr: 68 - 4 * (t / 300),
  lfPct: t < 64 ? null : lerp(35, 75, (t - 64) / 120),
  lfPower: t < 64 ? null : lerp(400, 1400, (t - 64) / 120),
  hrvMissingS: 0,
  contact: true,
  moving: false,
})

/** Settled client who gets a stressful thought at 200 s: SCR burst, cooling, LF % collapse. */
export const stress: Scenario = (t) => {
  const stressed = t >= 200 && t < 260
  const scr = t >= 200 && t < 203 ? (t - 200) / 3 : t >= 203 && t < 215 ? 1 - (t - 203) / 12 : 0
  return {
    tempC: 33.0 - (stressed ? 0.5 * Math.min(1, (t - 200) / 30) : t >= 260 ? 0.5 * Math.max(0, 1 - (t - 260) / 60) : 0),
    scUs: 3.0 + 1.0 * scr + (stressed ? 0.3 : 0),
    hr: stressed ? 82 : 66,
    lfPct: t < 64 ? null : stressed ? 25 : 65,
    lfPower: t < 64 ? null : stressed ? 300 : 1100,
    hrvMissingS: 0,
    contact: true,
    moving: false,
  }
}

/** Artifacts: movement 150–160 s, contact lost 250–258 s, HRV window interrupted 260–300 s. */
export const artifacts: Scenario = (t) => ({
  tempC: 32.0 + 0.5 * (t / 300),
  scUs: 3.5 - 0.3 * (t / 300),
  hr: 70,
  lfPct: t < 64 ? null : 60,
  lfPower: t < 64 ? null : 900,
  hrvMissingS: t >= 260 && t < 300 ? 8 : 0,
  contact: !(t >= 250 && t < 258),
  moving: t >= 150 && t < 160,
})

export const SCENARIOS: Record<string, Scenario> = { relax, stress, artifacts }

/** Turn a scenario into the event stream a real SDK would deliver, over `durationS`. */
export function sample(scenario: Scenario, durationS: number): ScenarioEvent[] {
  const ev: ScenarioEvent[] = []
  let prevContact: boolean | null = null
  let prevMoving: boolean | null = null
  // 20 Hz master clock so 4 Hz and 1 Hz streams fall on exact instants
  const steps = Math.round(durationS * 20)
  for (let i = 0; i <= steps; i++) {
    const t = i / 20
    const s = scenario(t)
    if (s.contact !== prevContact) { ev.push({ t, kind: 'contact', v: s.contact ? 1 : 0 }); prevContact = s.contact }
    if (s.moving !== prevMoving) { ev.push({ t, kind: 'moving', v: s.moving ? 1 : 0 }); prevMoving = s.moving }
    if (!s.contact) continue
    if (i % 20 === 0) ev.push({ t, kind: 'temp', v: round(s.tempC, 3) })
    if (i % 5 === 0) ev.push({ t, kind: 'sc', v: round(s.scUs, 4) })
    if (i % 20 === 10) ev.push({ t, kind: 'hr', v: round(s.hr, 1) })
    if (i % 5 === 2 && s.lfPct !== null) ev.push({ t, kind: 'hrv', v: round(s.lfPct, 3), v2: round(s.lfPower ?? 0, 1), v3: s.hrvMissingS })
  }
  return ev
}

const round = (v: number, d: number): number => Math.round(v * 10 ** d) / 10 ** d
