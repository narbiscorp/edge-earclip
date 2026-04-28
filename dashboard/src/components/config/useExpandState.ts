import { useCallback, useEffect, useState } from 'react';
import { SECTIONS, type SectionId } from './fieldSchema';

const STORAGE_KEY = 'narbis.config.expand';

type ExpandMap = Record<SectionId, boolean>;

function defaults(): ExpandMap {
  const m = {} as ExpandMap;
  for (const s of SECTIONS) m[s.id] = s.defaultExpanded;
  return m;
}

function load(): ExpandMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults();
    const parsed = JSON.parse(raw) as Partial<ExpandMap>;
    const result = defaults();
    for (const s of SECTIONS) {
      if (typeof parsed[s.id] === 'boolean') result[s.id] = parsed[s.id]!;
    }
    return result;
  } catch {
    return defaults();
  }
}

export function useExpandState(): {
  expanded: ExpandMap;
  toggle: (id: SectionId) => void;
  setAll: (value: boolean) => void;
} {
  const [expanded, setExpanded] = useState<ExpandMap>(() => load());

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(expanded));
    } catch {
      // storage may be unavailable; ignore
    }
  }, [expanded]);

  const toggle = useCallback((id: SectionId) => {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const setAll = useCallback((value: boolean) => {
    setExpanded(() => {
      const m = {} as ExpandMap;
      for (const s of SECTIONS) m[s.id] = value;
      return m;
    });
  }, []);

  return { expanded, toggle, setAll };
}
