import FieldShell from './FieldShell';
import type { ReadonlyFieldSpec } from '../fieldSchema';

interface Props {
  spec: ReadonlyFieldSpec;
  value: unknown;
}

export default function ReadonlyField({ spec, value }: Props) {
  const text = spec.format
    ? spec.format(value)
    : value instanceof Uint8Array
      ? Array.from(value, (b) => b.toString(16).padStart(2, '0')).join(':')
      : String(value);
  return (
    <FieldShell label={spec.label} help={spec.help}>
      <span className="text-[11px] font-mono text-slate-400">{text}</span>
    </FieldShell>
  );
}
