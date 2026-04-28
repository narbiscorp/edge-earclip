import { useEffect, useState } from 'react';
import FieldShell from './FieldShell';
import type { MacFieldSpec } from '../fieldSchema';
import type { WriteState } from '../useDebouncedConfigWrite';

interface Props {
  spec: MacFieldSpec;
  value: Uint8Array;
  error?: string;
  status?: WriteState;
  disabled?: boolean;
  onChange: (value: Uint8Array) => void;
}

export function macToString(mac: Uint8Array): string {
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
}

export function parseMac(text: string): Uint8Array | null {
  const parts = text.trim().split(/[:\-\s]/).filter(Boolean);
  if (parts.length !== 6) return null;
  const out = new Uint8Array(6);
  for (let i = 0; i < 6; i++) {
    if (!/^[0-9a-fA-F]{1,2}$/.test(parts[i])) return null;
    out[i] = parseInt(parts[i], 16);
  }
  return out;
}

export default function MacField({ spec, value, error, status, disabled, onChange }: Props) {
  const [text, setText] = useState(() => macToString(value));
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    setText(macToString(value));
    setLocalError(null);
  }, [value]);

  const commit = () => {
    const parsed = parseMac(text);
    if (!parsed) {
      setLocalError('expected AA:BB:CC:DD:EE:FF');
      return;
    }
    setLocalError(null);
    onChange(parsed);
  };

  const border = (error || localError) ? 'border-rose-500' : 'border-slate-700';

  return (
    <FieldShell label={spec.label} help={spec.help} error={localError ?? error} status={status}>
      <input
        type="text"
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        className={`w-full rounded border ${border} bg-slate-900 px-2 py-1 text-[11px] font-mono text-slate-100 disabled:opacity-50`}
        placeholder="00:00:00:00:00:00"
      />
    </FieldShell>
  );
}
