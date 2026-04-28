import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDashboardStore } from '../../state/store';
import { narbisDevice } from '../../ble/narbisDevice';
import type { NarbisRuntimeConfig } from '../../ble/parsers';
import {
  FIELD_SCHEMA,
  SECTIONS,
  VISIBLE_KEYS_BY_SECTION,
  type ConfigKey,
  type SectionId,
} from './fieldSchema';
import { isValid, validateConfig, type ValidationErrors } from './validateConfig';

export type WriteState = 'idle' | 'pending' | 'ok' | 'err';

const DEBOUNCE_MS = 300;
const OK_DURATION_MS = 1500;
const ERR_DURATION_MS = 4000;

type FieldStatusMap = Partial<Record<ConfigKey, WriteState>>;
type SectionStatusMap = Record<SectionId, WriteState>;

function emptySectionStatus(): SectionStatusMap {
  const m = {} as SectionStatusMap;
  for (const s of SECTIONS) m[s.id] = 'idle';
  return m;
}

function deriveSectionStatus(field: FieldStatusMap): SectionStatusMap {
  const out = emptySectionStatus();
  const order: WriteState[] = ['err', 'pending', 'ok', 'idle'];
  for (const sec of SECTIONS) {
    let best: WriteState = 'idle';
    let bestRank = order.indexOf('idle');
    for (const key of VISIBLE_KEYS_BY_SECTION[sec.id]) {
      const s = field[key];
      if (!s) continue;
      const r = order.indexOf(s);
      if (r < bestRank) {
        best = s;
        bestRank = r;
      }
    }
    out[sec.id] = best;
  }
  return out;
}

export interface UseDebouncedConfigWriteResult {
  draft: NarbisRuntimeConfig | null;
  errors: ValidationErrors;
  fieldStatus: FieldStatusMap;
  sectionStatus: SectionStatusMap;
  setField: <K extends ConfigKey>(key: K, value: NarbisRuntimeConfig[K]) => void;
  flushNow: (cfg: NarbisRuntimeConfig) => Promise<void>;
  resetSection: (sec: SectionId, defaults: NarbisRuntimeConfig) => void;
  resetAll: (defaults: NarbisRuntimeConfig) => void;
  lastError: string | null;
  canWrite: boolean;
}

export function useDebouncedConfigWrite(
  isConnected: boolean,
): UseDebouncedConfigWriteResult {
  const storeConfig = useDashboardStore((s) => s.config);
  const [draft, setDraft] = useState<NarbisRuntimeConfig | null>(storeConfig);
  const [fieldStatus, setFieldStatus] = useState<FieldStatusMap>({});
  const [lastError, setLastError] = useState<string | null>(null);

  const dirtyKeysRef = useRef<Set<ConfigKey>>(new Set());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingKeysRef = useRef<Set<ConfigKey>>(new Set());
  const draftRef = useRef<NarbisRuntimeConfig | null>(storeConfig);
  const statusTimersRef = useRef<Map<ConfigKey, ReturnType<typeof setTimeout>>>(new Map());

  // Sync draft from store when fields are not dirty.
  useEffect(() => {
    if (!storeConfig) {
      draftRef.current = null;
      setDraft(null);
      dirtyKeysRef.current.clear();
      return;
    }
    setDraft((prev) => {
      if (!prev) {
        draftRef.current = storeConfig;
        return storeConfig;
      }
      const merged: NarbisRuntimeConfig = { ...prev };
      const dirty = dirtyKeysRef.current;
      for (const key of Object.keys(storeConfig) as ConfigKey[]) {
        if (!dirty.has(key)) {
          (merged as Record<ConfigKey, unknown>)[key] = storeConfig[key];
        }
      }
      draftRef.current = merged;
      return merged;
    });
  }, [storeConfig]);

  const errors = useMemo<ValidationErrors>(
    () => (draft ? validateConfig(draft) : {}),
    [draft],
  );

  const sectionStatus = useMemo(() => deriveSectionStatus(fieldStatus), [fieldStatus]);

  const clearStatusAfter = useCallback((keys: Iterable<ConfigKey>, ms: number, target: WriteState) => {
    for (const key of keys) {
      const prev = statusTimersRef.current.get(key);
      if (prev) clearTimeout(prev);
      const t = setTimeout(() => {
        setFieldStatus((cur) => {
          if (cur[key] !== target) return cur;
          const next = { ...cur };
          delete next[key];
          return next;
        });
        statusTimersRef.current.delete(key);
      }, ms);
      statusTimersRef.current.set(key, t);
    }
  }, []);

  const performWrite = useCallback(async (cfg: NarbisRuntimeConfig, keys: ConfigKey[]) => {
    const errs = validateConfig(cfg);
    if (!isValid(errs)) {
      setFieldStatus((cur) => {
        const next = { ...cur };
        for (const k of keys) next[k] = 'err';
        return next;
      });
      setLastError('config has validation errors');
      return;
    }
    try {
      await narbisDevice.writeConfig(cfg);
      setFieldStatus((cur) => {
        const next = { ...cur };
        for (const k of keys) next[k] = 'ok';
        return next;
      });
      for (const k of keys) dirtyKeysRef.current.delete(k);
      clearStatusAfter(keys, OK_DURATION_MS, 'ok');
      setLastError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFieldStatus((cur) => {
        const next = { ...cur };
        for (const k of keys) next[k] = 'err';
        return next;
      });
      clearStatusAfter(keys, ERR_DURATION_MS, 'err');
      setLastError(msg);
    }
  }, [clearStatusAfter]);

  const scheduleFlush = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const cfg = draftRef.current;
      if (!cfg) return;
      const keys = Array.from(pendingKeysRef.current);
      pendingKeysRef.current.clear();
      void performWrite(cfg, keys);
    }, DEBOUNCE_MS);
  }, [performWrite]);

  const setField = useCallback(<K extends ConfigKey>(key: K, value: NarbisRuntimeConfig[K]) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const next: NarbisRuntimeConfig = { ...prev, [key]: value };
      draftRef.current = next;
      return next;
    });
    dirtyKeysRef.current.add(key);
    pendingKeysRef.current.add(key);
    setFieldStatus((cur) => ({ ...cur, [key]: 'pending' }));
    scheduleFlush();
  }, [scheduleFlush]);

  const flushNow = useCallback(async (cfg: NarbisRuntimeConfig) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const allKeys = Object.keys(FIELD_SCHEMA) as ConfigKey[];
    pendingKeysRef.current.clear();
    for (const k of allKeys) dirtyKeysRef.current.add(k);
    draftRef.current = cfg;
    setDraft(cfg);
    setFieldStatus((cur) => {
      const next = { ...cur };
      for (const k of allKeys) next[k] = 'pending';
      return next;
    });
    await performWrite(cfg, allKeys);
  }, [performWrite]);

  const resetSection = useCallback((sec: SectionId, defaults: NarbisRuntimeConfig) => {
    if (!draftRef.current) return;
    const keys = VISIBLE_KEYS_BY_SECTION[sec];
    const next: NarbisRuntimeConfig = { ...draftRef.current };
    for (const k of keys) {
      (next as Record<ConfigKey, unknown>)[k] = defaults[k];
    }
    draftRef.current = next;
    setDraft(next);
    for (const k of keys) {
      dirtyKeysRef.current.add(k);
      pendingKeysRef.current.add(k);
    }
    setFieldStatus((cur) => {
      const out = { ...cur };
      for (const k of keys) out[k] = 'pending';
      return out;
    });
    scheduleFlush();
  }, [scheduleFlush]);

  const resetAll = useCallback((defaults: NarbisRuntimeConfig) => {
    void flushNow(defaults);
  }, [flushNow]);

  // Cleanup timers on unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      for (const t of statusTimersRef.current.values()) clearTimeout(t);
      statusTimersRef.current.clear();
    };
  }, []);

  return {
    draft,
    errors,
    fieldStatus,
    sectionStatus,
    setField,
    flushNow,
    resetSection,
    resetAll,
    lastError,
    canWrite: isConnected && draft !== null,
  };
}
