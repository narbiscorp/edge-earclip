import FieldShell from './FieldShell';
import type { EnumFieldSpec } from '../fieldSchema';
import type { WriteState } from '../useDebouncedConfigWrite';

interface Props {
  spec: EnumFieldSpec;
  value: number;
  error?: string;
  status?: WriteState;
  disabled?: boolean;
  onChange: (value: number) => void;
}

export default function EnumField({ spec, value, error, status, disabled, onChange }: Props) {
  const border = error ? 'border-rose-500' : 'border-slate-700';
  return (
    <FieldShell
      label={spec.label}
      help={spec.help}
      error={error}
      status={status}
      requiresReboot={spec.requiresReboot}
    >
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className={`w-full rounded border ${border} bg-slate-900 px-2 py-1 text-[11px] text-slate-100 disabled:opacity-50`}
      >
        {spec.options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}
