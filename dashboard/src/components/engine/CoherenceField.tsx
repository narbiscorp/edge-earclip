/*
 * CoherenceField.tsx — float-aware numeric field for the Coherence Engine tunables.
 *
 * Reuses the firmware config's generic FieldShell for the labeled wrapper, but the input
 * parses/commits floats (the firmware NumericField rounds to integer wire values, which
 * would destroy values like 0.0033). Slider + free-text entry, clamped to [min,max].
 */
import { useEffect, useState } from 'react';
import FieldShell from '../config/fields/FieldShell';
import type { CohNumericField } from './coherenceFieldSchema';

interface Props {
  spec: CohNumericField;
  value: number;
  error?: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}

/** Show enough decimals to represent the step without trailing noise. */
function format(value: number, step: number): string {
  if (!Number.isFinite(value)) return '';
  const decimals = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step)));
  // toFixed then strip trailing zeros so 0.0033 shows cleanly, 64 shows as "64".
  return Number(value.toFixed(decimals)).toString();
}

export default function CoherenceField({ spec, value, error, disabled, onChange }: Props) {
  const [text, setText] = useState(() => format(value, spec.step));

  useEffect(() => {
    setText(format(value, spec.step));
  }, [value, spec.step]);

  const inputBorder = error ? 'border-rose-500' : 'border-slate-700';

  const commit = () => {
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) {
      setText(format(value, spec.step));
      return;
    }
    const clamped = Math.max(spec.min, Math.min(spec.max, parsed));
    onChange(clamped);
  };

  return (
    <FieldShell label={spec.label} help={spec.help} error={error}>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={spec.min}
          max={spec.max}
          step={spec.step}
          value={value}
          disabled={disabled}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) onChange(v);
          }}
          className="flex-1 accent-emerald-500 disabled:opacity-50"
          aria-label={spec.label}
        />
        <input
          type="text"
          inputMode="decimal"
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
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
