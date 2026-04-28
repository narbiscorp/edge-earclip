import type { ReactNode } from 'react';
import type { WriteState } from '../useDebouncedConfigWrite';
import StatusBadge from './StatusBadge';

export default function FieldShell({
  label,
  help,
  error,
  status,
  requiresReboot,
  children,
}: {
  label: string;
  help?: string;
  error?: string;
  status?: WriteState;
  requiresReboot?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 py-1.5">
      <div className="flex items-center justify-between gap-2 text-[11px] text-slate-300">
        <span className="flex items-center gap-1.5">
          <StatusBadge status={status} />
          <span className="font-medium">{label}</span>
          {requiresReboot ? (
            <span
              className="text-[9px] uppercase tracking-wide text-amber-300/80"
              title="requires firmware reboot"
            >
              reboot
            </span>
          ) : null}
        </span>
      </div>
      {children}
      {error ? (
        <span className="text-[10px] text-rose-400">{error}</span>
      ) : help ? (
        <span className="text-[10px] text-slate-500">{help}</span>
      ) : null}
    </div>
  );
}
