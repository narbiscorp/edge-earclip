/*
 * TPS signal sources. A source emits decoded physiology samples the way the sensor's mobile SDK
 * delivers them on a phone: temperature ~1 Hz, skin conductance a few Hz, heart rate + a beat
 * event per beat, HRV after its analysis window has filled, and contact / movement edges.
 *
 * On the web the only source that can decode today is the simulator (the live BLE stream is
 * encrypted — see ble/tpsDevice.ts). The simulator replays the same deterministic scenarios the
 * protocol's golden vectors are built from, so what you see here is exactly what the phone apps'
 * unit tests assert.
 */
import { SCENARIOS, type Scenario, type ScenarioState } from './tpsScenarios';

export type TpsSampleEvent =
  | { kind: 'temp'; t: number; v: number }
  | { kind: 'sc'; t: number; v: number }
  | { kind: 'hr'; t: number; v: number }
  | { kind: 'beat'; t: number; ibiMs: number }
  | { kind: 'hrv'; t: number; lfPct: number; lfPower: number; missingS: number; vlfPct: number; hfPct: number }
  | { kind: 'contact'; t: number; on: boolean }
  | { kind: 'moving'; t: number; on: boolean };

export type TpsScenarioName = keyof typeof SCENARIOS;
export const SCENARIO_NAMES = Object.keys(SCENARIOS) as TpsScenarioName[];

export const SCENARIO_INFO: Record<TpsScenarioName, { title: string; desc: string }> = {
  relax: { title: 'Relax', desc: 'Hand warms 1.5 °C, skin conductance falls 25 %, LF % climbs to 75 — the lens should clear.' },
  stress: { title: 'Stressful thought', desc: 'Settled client; at 3:20 an SCR burst, cooling and an LF % collapse — the lens should darken fast, then recover.' },
  artifacts: { title: 'Artifacts', desc: 'Movement at 2:30 (hold), contact lost at 4:10 (neutral), HRV window interrupted at 4:20 (HRV greyed).' },
};

export interface TpsSignalSource extends EventTarget {
  readonly kind: 'simulated' | 'live';
  readonly running: boolean;
  start(): void;
  stop(): void;
}

/** `t` on every event is seconds on the host clock (Date.now()/1000) so charts can use epoch ms. */
export class SimulatedTpsSource extends EventTarget implements TpsSignalSource {
  readonly kind = 'simulated' as const;
  private scenario: Scenario;
  private speed: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  private prev: ScenarioState | null = null;
  private nextBeatSimT = 0;
  private tickCount = 0;

  constructor(name: TpsScenarioName = 'relax', speed = 1) {
    super();
    this.scenario = SCENARIOS[name];
    this.speed = speed;
  }

  get running(): boolean { return this.timer !== null; }

  setScenario(name: TpsScenarioName): void {
    this.scenario = SCENARIOS[name];
    this.restartIfRunning();
  }

  setSpeed(speed: number): void {
    this.speed = speed;
    this.restartIfRunning();
  }

  start(): void {
    if (this.timer) return;
    this.startedAt = Date.now();
    this.prev = null;
    this.nextBeatSimT = 0;
    this.tickCount = 0;
    // 20 Hz master clock, matching tps/protocol/scenarios.ts sample() so the 1 Hz / 4 Hz streams fall
    // on the same instants the golden vectors used.
    this.timer = setInterval(() => this.step(), 50 / this.speed);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private restartIfRunning(): void {
    if (!this.running) return;
    this.stop();
    this.start();
  }

  private step(): void {
    const now = Date.now();
    const simT = ((now - this.startedAt) / 1000) * this.speed;
    const tHost = now / 1000;
    const s = this.scenario(simT);
    const i = this.tickCount++;
    if (!this.prev || s.contact !== this.prev.contact) this.emit({ kind: 'contact', t: tHost, on: s.contact });
    if (!this.prev || s.moving !== this.prev.moving) this.emit({ kind: 'moving', t: tHost, on: s.moving });
    this.prev = s;
    if (!s.contact) return;
    if (i % 20 === 0) this.emit({ kind: 'temp', t: tHost, v: s.tempC });
    if (i % 5 === 0) this.emit({ kind: 'sc', t: tHost, v: s.scUs });
    if (i % 20 === 10) this.emit({ kind: 'hr', t: tHost, v: s.hr });
    if (i % 5 === 2 && s.lfPct !== null) {
      const lf = s.lfPct;
      const vlf = Math.max(0, Math.min(100 - lf, 20));
      this.emit({ kind: 'hrv', t: tHost, lfPct: lf, lfPower: s.lfPower ?? 0, missingS: s.hrvMissingS, vlfPct: vlf, hfPct: Math.max(0, 100 - lf - vlf) });
    }
    // Beats: an IBI train from the heart rate with a little respiratory sinus arrhythmia so the
    // IBI graph breathes like a real one.
    while (this.nextBeatSimT <= simT) {
      const hrNow = this.scenario(this.nextBeatSimT).hr;
      const rsa = 1 + 0.04 * Math.sin((2 * Math.PI * this.nextBeatSimT) / 10);
      const ibiMs = (60000 / Math.max(30, hrNow)) * rsa;
      this.emit({ kind: 'beat', t: tHost - (simT - this.nextBeatSimT) / this.speed, ibiMs });
      this.nextBeatSimT += ibiMs / 1000;
    }
  }

  private emit(e: TpsSampleEvent): void {
    this.dispatchEvent(new CustomEvent<TpsSampleEvent>('sample', { detail: e }));
  }
}
