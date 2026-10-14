import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DEFAULT_TUNABLES, TpsProtocolEngine, type TpsTunables } from '../tpsProtocol';
import { SCENARIOS, sample, type ScenarioEvent } from '../tpsScenarios';

const here = dirname(fileURLToPath(import.meta.url));
const vectorsDir = join(here, '..', 'vectors');

interface VectorRow { t: number; phase: string; r: number | null; duty: number }
interface Vector {
  name: string; tickHz: number; durationS: number; tunables: TpsTunables;
  tolerance: { r: number; duty: number }; events: ScenarioEvent[]; expected: VectorRow[];
}

/** The exact replay procedure the vectors encode (events at or before t, then tick(t)). */
function replay(events: ScenarioEvent[], durationS: number, tickHz: number, tunables?: Partial<TpsTunables>): VectorRow[] {
  const engine = new TpsProtocolEngine(tunables);
  const rows: VectorRow[] = [];
  let ei = 0;
  const ticks = Math.round(durationS * tickHz);
  for (let k = 0; k <= ticks; k++) {
    const t = k / tickHz;
    while (ei < events.length && events[ei].t <= t + 1e-9) {
      const e = events[ei++];
      switch (e.kind) {
        case 'temp': engine.onTemperature(e.v, e.t); break;
        case 'sc': engine.onSkinConductance(e.v, e.t); break;
        case 'hr': engine.onHeartRate(e.v); break;
        case 'hrv': engine.onHrv(e.v, e.v2 ?? 0, e.v3 ?? 0, e.t); break;
        case 'contact': engine.onContact(e.v === 1, e.t); break;
        case 'moving': engine.onMovement(e.v === 1, e.t); break;
      }
    }
    const f = engine.tick(t);
    rows.push({ t: Math.round(t * 1000) / 1000, phase: f.phase, r: f.r === null ? null : Math.round(f.r * 1e9) / 1e9, duty: f.duty });
  }
  return rows;
}

describe('TPS "Relax" protocol — vendored reference', () => {
  it('replays every golden vector exactly (duty) and to tolerance (R)', () => {
    const files = readdirSync(vectorsDir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const f of files) {
      const v = JSON.parse(readFileSync(join(vectorsDir, f), 'utf8')) as Vector;
      const rows = replay(v.events, v.durationS, v.tickHz, v.tunables);
      expect(rows.length).toBe(v.expected.length);
      for (let i = 0; i < rows.length; i++) {
        const a = rows[i]; const b = v.expected[i];
        expect(a.duty, `${f} t=${a.t} duty`).toBe(b.duty);
        expect(a.phase, `${f} t=${a.t} phase`).toBe(b.phase);
        if (a.r === null || b.r === null) expect(a.r, `${f} t=${a.t} r`).toBe(b.r);
        else expect(Math.abs(a.r - b.r), `${f} t=${a.t} r`).toBeLessThanOrEqual(v.tolerance.r);
      }
    }
  });

  it('relaxing clears the lens and a stressful thought darkens it within seconds', () => {
    const relax = replay(sample(SCENARIOS.relax, 330), 330, 10);
    const at = (rows: VectorRow[], t: number) => rows.find((r) => Math.abs(r.t - t) < 1e-6)!;
    expect(at(relax, 30).duty).toBe(DEFAULT_TUNABLES.neutralDuty);
    expect(at(relax, 60).phase).toBe('training');
    expect(at(relax, 320).duty).toBeLessThanOrEqual(5);

    const stress = replay(sample(SCENARIOS.stress, 330), 330, 10);
    const calm = at(stress, 195).duty;
    const peak = Math.max(...stress.filter((r) => r.t >= 200 && r.t <= 215).map((r) => r.duty));
    expect(peak - calm).toBeGreaterThanOrEqual(25);
    expect(stress.filter((r) => r.t >= 200 && r.t <= 204).some((r) => r.duty >= calm + 10)).toBe(true);
  });

  it('holds during movement and goes to neutral when contact is lost', () => {
    const rows = replay(sample(SCENARIOS.artifacts, 330), 330, 10);
    const at = (t: number) => rows.find((r) => Math.abs(r.t - t) < 1e-6)!;
    const before = at(149.9).duty;
    for (const r of rows.filter((r) => r.t >= 150 && r.t <= 160.9)) expect(r.duty).toBe(before);
    expect(at(253).phase).toBe('contact_lost');
    expect(at(253).duty).toBe(DEFAULT_TUNABLES.neutralDuty);
    expect(at(258.5).phase).toBe('training');
  });
});
