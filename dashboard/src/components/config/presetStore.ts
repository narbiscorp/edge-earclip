import type { NarbisRuntimeConfig } from '../../ble/parsers';
import builtInsRaw from '../../presets/defaults.json';
import { getDb, STORE_PRESETS } from '../../state/idb';
import { macToString, parseMac } from './fields/MacField';
import { ALL_FIELD_KEYS, FIELD_SCHEMA } from './fieldSchema';
import { isValid, validateConfig } from './validateConfig';

const STORE = STORE_PRESETS;

export interface SavedPreset {
  id: string;
  name: string;
  builtIn: boolean;
  description?: string;
  config: NarbisRuntimeConfig;
  updatedAt: number;
}

interface JsonPreset {
  id: string;
  name: string;
  builtIn?: boolean;
  description?: string;
  config: JsonConfig;
  updatedAt?: number;
}

type JsonConfig = Omit<NarbisRuntimeConfig, 'partner_mac'> & { partner_mac: string };

function jsonToConfig(j: JsonConfig): NarbisRuntimeConfig {
  const mac = parseMac(j.partner_mac);
  if (!mac) throw new Error(`invalid partner_mac: ${j.partner_mac}`);
  const cfg = { ...j, partner_mac: mac } as unknown as NarbisRuntimeConfig;
  for (const key of ALL_FIELD_KEYS) {
    if (!(key in cfg)) {
      throw new Error(`preset missing field: ${String(key)}`);
    }
    const spec = FIELD_SCHEMA[key];
    if (spec.kind !== 'mac' && typeof cfg[key] !== 'number') {
      throw new Error(`preset field ${String(key)} must be a number`);
    }
  }
  return cfg;
}

function configToJson(cfg: NarbisRuntimeConfig): JsonConfig {
  return { ...cfg, partner_mac: macToString(cfg.partner_mac) };
}

export const BUILT_IN_PRESETS: SavedPreset[] = (builtInsRaw as JsonPreset[]).map((p) => ({
  id: p.id,
  name: p.name,
  builtIn: true,
  description: p.description,
  config: jsonToConfig(p.config),
  updatedAt: 0,
}));

export const BUILT_IN_DEFAULT: SavedPreset =
  BUILT_IN_PRESETS.find((p) => p.id === 'builtin-default') ?? BUILT_IN_PRESETS[0];

export async function listUserPresets(): Promise<SavedPreset[]> {
  const db = await getDb();
  const rows = (await db.getAll(STORE)) as Array<JsonPreset & { config: JsonConfig | NarbisRuntimeConfig }>;
  return rows
    .map((r) => ({
      id: r.id,
      name: r.name,
      builtIn: false,
      description: r.description,
      config: typeof (r.config as JsonConfig).partner_mac === 'string'
        ? jsonToConfig(r.config as JsonConfig)
        : (r.config as NarbisRuntimeConfig),
      updatedAt: r.updatedAt ?? 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveUserPreset(input: {
  id?: string;
  name: string;
  config: NarbisRuntimeConfig;
}): Promise<SavedPreset> {
  const errors = validateConfig(input.config);
  if (!isValid(errors)) {
    const first = Object.entries(errors).find(([, v]) => v);
    throw new Error(`invalid config: ${first?.[0]} — ${first?.[1]}`);
  }
  const id = input.id ?? `user-${crypto.randomUUID()}`;
  const record: SavedPreset = {
    id,
    name: input.name.trim() || 'Untitled',
    builtIn: false,
    config: input.config,
    updatedAt: Date.now(),
  };
  const db = await getDb();
  await db.put(STORE, {
    id: record.id,
    name: record.name,
    description: record.description,
    config: configToJson(record.config),
    updatedAt: record.updatedAt,
  });
  return record;
}

export async function deleteUserPreset(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORE, id);
}

export async function findUserPresetByName(name: string): Promise<SavedPreset | null> {
  const all = await listUserPresets();
  return all.find((p) => p.name.toLowerCase() === name.trim().toLowerCase()) ?? null;
}

export function exportPresetJson(p: SavedPreset): string {
  const out = {
    id: p.id,
    name: p.name,
    builtIn: false,
    description: p.description,
    config: configToJson(p.config),
    updatedAt: p.updatedAt,
  };
  return JSON.stringify(out, null, 2);
}

export async function importPresetJson(text: string): Promise<SavedPreset> {
  let parsed: JsonPreset;
  try {
    parsed = JSON.parse(text) as JsonPreset;
  } catch (err) {
    throw new Error(`invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed.config) throw new Error('preset missing config');
  const cfg = jsonToConfig(parsed.config);
  const errors = validateConfig(cfg);
  if (!isValid(errors)) {
    const first = Object.entries(errors).find(([, v]) => v);
    throw new Error(`imported config invalid: ${first?.[0]} — ${first?.[1]}`);
  }
  return saveUserPreset({ name: parsed.name ?? 'Imported preset', config: cfg });
}
