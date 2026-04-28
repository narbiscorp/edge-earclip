import FieldShell from './FieldShell';
import type { BitmaskFieldSpec } from '../fieldSchema';
import type { WriteState } from '../useDebouncedConfigWrite';

interface Props {
  spec: BitmaskFieldSpec;
  value: number;
  error?: string;
  status?: WriteState;
  disabled?: boolean;
  onChange: (value: number) => void;
}

export default function BitmaskField({ spec, value, error, status, disabled, onChange }: Props) {
  const toggleBit = (bit: number) => {
    const mask = 1 << bit;
    onChange((value & mask) ? value & ~mask : value | mask);
  };
  return (
    <FieldShell
      label={spec.label}
      help={spec.help}
      error={error}
      status={status}
      requiresReboot={spec.requiresReboot}
    >
      <div className="flex flex-col gap-1">
        {spec.bits.map((b) => (
          <label key={b.bit} className="flex items-center gap-2 text-[11px] text-slate-200" title={b.help}>
            <input
              type="checkbox"
              checked={(value & (1 << b.bit)) !== 0}
              disabled={disabled}
              onChange={() => toggleBit(b.bit)}
              className="accent-emerald-500 disabled:opacity-50"
            />
            <span>{b.label}</span>
          </label>
        ))}
      </div>
    </FieldShell>
  );
}
