import { useEffect, useState } from 'react';
import FieldShell from './FieldShell';
import type { NumericFieldSpec } from '../fieldSchema';
import type { WriteState } from '../useDebouncedConfigWrite';

interface Props {
  spec: NumericFieldSpec;
  value: number;
  error?: string;
  status?: WriteState;
  disabled?: boolean;
  onChange: (value: number) => void;
}

function format(raw: number, scale?: number): string {
  if (!scale) return String(raw);
  const decimals = scale === 0.001 ? 3 : scale === 0.01 ? 2 : 1;
  return (raw * scale).toFixed(decimals);
}

export default function NumericField({ spec, value, error, status, disabled, onChange }: Props) {
  const [text, setText] = useState(() => format(value, spec.scale));

  useEffect(() => {
    setText(format(value, spec.scale));
  }, [value, spec.scale]);

  const inputBorder = error
    ? 'border-rose-500'
    : status === 'pending'
      ? 'border-amber-400'
      : 'border-slate-700';

  const handleSlider = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value);
    if (Number.isFinite(v)) onChange(v);
  };

  const handleTextCommit = () => {
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) {
      setText(format(value, spec.scale));
      return;
    }
    const raw = spec.scale ? Math.round(parsed / spec.scale) : Math.round(parsed);
    onChange(raw);
  };

  return (
    <FieldShell
      label={spec.label}
      help={spec.help}
      error={error}
      status={status}
      requiresReboot={spec.requiresReboot}
    >
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={spec.min}
          max={spec.max}
          step={spec.step}
          value={value}
          disabled={disabled}
          onChange={handleSlider}
          className="flex-1 accent-emerald-500 disabled:opacity-50"
          aria-label={spec.label}
        />
        <input
          type="text"
          inputMode="decimal"
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onBlur={handleTextCommit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              (e.target as HTMLInputElement).blur();
            }
          }}
          className={`w-16 rounded border ${inputBorder} bg-slate-900 px-1.5 py-0.5 text-right text-[11px] text-slate-100 disabled:opacity-50`}
        />
        {spec.unit ? (
          <span className="w-10 text-[10px] text-slate-500">{spec.unit}</span>
        ) : (
          <span className="w-10" />
        )}
      </div>
    </FieldShell>
  );
}
