import FieldShell from './FieldShell';
import type { ToggleFieldSpec } from '../fieldSchema';
import type { WriteState } from '../useDebouncedConfigWrite';

interface Props {
  spec: ToggleFieldSpec;
  value: number;
  error?: string;
  status?: WriteState;
  disabled?: boolean;
  onChange: (value: number) => void;
}

export default function ToggleField({ spec, value, error, status, disabled, onChange }: Props) {
  const checked = value === 1;
  return (
    <FieldShell
      label={spec.label}
      help={spec.help}
      error={error}
      status={status}
      requiresReboot={spec.requiresReboot}
    >
      <label className="flex items-center gap-2 text-[11px] text-slate-200">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked ? 1 : 0)}
          className="accent-emerald-500 disabled:opacity-50"
        />
        <span className="text-slate-400">{checked ? 'on' : 'off'}</span>
      </label>
    </FieldShell>
  );
}
