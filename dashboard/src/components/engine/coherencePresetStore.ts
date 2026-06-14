/*
 * coherencePresetStore.ts — named presets for the full Coherence Engine tunable set.
 *
 * Mirrors config/presetStore.ts (IndexedDB-backed, export/import JSON) but stores a
 * CoherenceTunables snapshot instead of the firmware NarbisRuntimeConfig. A preset
 * captures EVERY tunable (Mode A + Mode B) plus, optionally, the engine mode it targets.
 */
import { getDb, STORE_COHERENCE_PRESETS } from '../../state/idb';
import { DEFAULT_TUNABLES, type CoherenceTunables } from '../../engine/tunables';
import type { EngineMode } from '../../engine/coherenceEngine';
import { isCohValid, validateCoherenceTunables } from './validateCoherenceTunables';

const STORE = STORE_COHERENCE_PRESETS;

export interface SavedCoherencePreset {
  id: string;
  name: string;
  builtIn: boolean;
  /** Optional engine mode this preset is meant for (applied on load if present). */
  mode?: EngineMode;
  tunables: CoherenceTunables;
  updatedAt: number;
}

interface JsonPreset {
  id: string;
  name: string;
  builtIn?: boolean;
  mode?: EngineMode;
  tunables: Partial<CoherenceTunables>;
  updatedAt?: number;
}

/** Merge a (possibly partial / older) tunable blob over the current defaults. */
function jsonToTunables(j: Partial<CoherenceTunables>): CoherenceTunables {
  return { ...DEFAULT_TUNABLES, ...j };
}

export const BUILT_IN_PRESETS: SavedCoherencePreset[] = [
  {
    id: 'builtin-coherence-default',
    name: 'Default (factory)',
    builtIn: true,
    tunables: { ...DEFAULT_TUNABLES },
    updatedAt: 0,
  },
];

export const BUILT_IN_DEFAULT: SavedCoherencePreset = BUILT_IN_PRESETS[0];

export async function listUserPresets(): Promise<SavedCoherencePreset[]> {
  const db = await getDb();
  const rows = (await db.getAll(STORE)) as JsonPreset[];
  return rows
    .map((r) => ({
      id: r.id,
      name: r.name,
      builtIn: false,
      mode: r.mode,
      tunables: jsonToTunables(r.tunables),
      updatedAt: r.updatedAt ?? 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveUserPreset(input: {
  id?: string;
  name: string;
  tunables: CoherenceTunables;
  mode?: EngineMode;
}): Promise<SavedCoherencePreset> {
  const errors = validateCoherenceTunables(input.tunables);
  if (!isCohValid(errors)) {
    const first = Object.entries(errors).find(([, v]) => v);
    throw new Error(`invalid tunables: ${first?.[0]} — ${first?.[1]}`);
  }
  const id = input.id ?? `user-${crypto.randomUUID()}`;
  const record: SavedCoherencePreset = {
    id,
    name: input.name.trim() || 'Untitled',
    builtIn: false,
    mode: input.mode,
    tunables: input.tunables,
    updatedAt: Date.now(),
  };
  const db = await getDb();
  await db.put(STORE, {
    id: record.id,
    name: record.name,
    mode: record.mode,
    tunables: record.tunables,
    updatedAt: record.updatedAt,
  });
  return record;
}

export async function deleteUserPreset(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORE, id);
}

export async function findUserPresetByName(name: string): Promise<SavedCoherencePreset | null> {
  const all = await listUserPresets();
  return all.find((p) => p.name.toLowerCase() === name.trim().toLowerCase()) ?? null;
}

export function exportPresetJson(p: SavedCoherencePreset): string {
  const out: JsonPreset = {
    id: p.id,
    name: p.name,
    builtIn: false,
    mode: p.mode,
    tunables: p.tunables,
    updatedAt: p.updatedAt,
  };
  return JSON.stringify(out, null, 2);
}

export async function importPresetJson(text: string): Promise<SavedCoherencePreset> {
  let parsed: JsonPreset;
  try {
    parsed = JSON.parse(text) as JsonPreset;
  } catch (err) {
    throw new Error(`invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed.tunables) throw new Error('preset missing tunables');
  const tunables = jsonToTunables(parsed.tunables);
  const errors = validateCoherenceTunables(tunables);
  if (!isCohValid(errors)) {
    const first = Object.entries(errors).find(([, v]) => v);
    throw new Error(`imported tunables invalid: ${first?.[0]} — ${first?.[1]}`);
  }
  return saveUserPreset({ name: parsed.name ?? 'Imported preset', tunables, mode: parsed.mode });
}
