import type { ReactNode } from 'react';

/**
 * Compact button-group controls used in chart headers.
 *
 * Three groups, all optional:
 *   - window: visible time range in seconds
 *   - smooth: moving-average window size in samples (0 = off)
 *   - rescale: Y-axis re-fit interval in seconds (0 = always autorange)
 *
 * Kept as a single component so the chart headers stay tidy. If a chart
 * doesn't use one of the controls, omit the corresponding prop and the
 * group hides.
 */

type ButtonGroupProps<T extends number | string> = {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
};

function ButtonGroup<T extends number | string>({ label, value, options, onChange }: ButtonGroupProps<T>) {
  return (
    <div className="flex items-center gap-1 text-[11px]">
      <span className="text-slate-500">{label}</span>
      <div className="flex rounded bg-slate-800/80 overflow-hidden">
        {options.map((opt) => {
          const active = opt.value === value;
          return (
            <button
              key={String(opt.value)}
              type="button"
              onClick={() => onChange(opt.value)}
              className={
                'px-1.5 py-0.5 transition-colors ' +
                (active
                  ? 'bg-slate-600 text-slate-100'
                  : 'text-slate-400 hover:bg-slate-700 hover:text-slate-200')
              }
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export const WINDOW_OPTIONS = [
  { value: 10, label: '10s' },
  { value: 30, label: '30s' },
  { value: 60, label: '60s' },
] as const;

export const SMOOTH_OPTIONS = [
  { value: 0, label: 'off' },
  { value: 3, label: '3' },
  { value: 7, label: '7' },
  { value: 15, label: '15' },
] as const;

export const RESCALE_OPTIONS = [
  { value: 0, label: 'live' },
  { value: 5, label: '5s' },
  { value: 15, label: '15s' },
  { value: 30, label: '30s' },
] as const;

export interface ChartControlsProps {
  windowSec?: number;
  onWindowChange?: (sec: number) => void;
  smoothN?: number;
  onSmoothChange?: (n: number) => void;
  rescaleSec?: number;
  onRescaleChange?: (sec: number) => void;
  children?: ReactNode;
}

export default function ChartControls({
  windowSec,
  onWindowChange,
  smoothN,
  onSmoothChange,
  rescaleSec,
  onRescaleChange,
  children,
}: ChartControlsProps) {
  return (
    <div className="flex items-center gap-3">
      {windowSec !== undefined && onWindowChange ? (
        <ButtonGroup<number>
          label="window"
          value={windowSec}
          options={WINDOW_OPTIONS}
          onChange={onWindowChange}
        />
      ) : null}
      {smoothN !== undefined && onSmoothChange ? (
        <ButtonGroup<number>
          label="smooth"
          value={smoothN}
          options={SMOOTH_OPTIONS}
          onChange={onSmoothChange}
        />
      ) : null}
      {rescaleSec !== undefined && onRescaleChange ? (
        <ButtonGroup<number>
          label="rescale"
          value={rescaleSec}
          options={RESCALE_OPTIONS}
          onChange={onRescaleChange}
        />
      ) : null}
      {children}
    </div>
  );
}
