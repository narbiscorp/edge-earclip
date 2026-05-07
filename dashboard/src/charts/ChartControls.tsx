import type { ReactNode } from 'react';

/**
 * Compact button-group controls used in chart headers.
 *
 * Three groups, all optional:
 *   - window: visible time range in seconds
 *   - smooth: moving-average window size in samples (0 = off)
 *   - rescale: Y-axis re-fit interval in seconds (0 = always autorange)
 *
 * Different chart types want different window scales (10–60 s for raw
 * signals, 1–30 min for IBI/HRV), so each chart supplies its own
 * `windowOptions`. Smooth and rescale options are uniform across charts.
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

export type WindowOption = { value: number; label: string };

/**
 * Unified window options used by every streaming chart. Window state is
 * lifted into the global store so all charts move together — selecting
 * 30s on Raw PPG sets IBI tachogram and HRV to the same range, so events
 * line up vertically in the stack.
 *
 * Each chart's data buffer has its own capacity ceiling — Raw PPG holds
 * the last ~4 minutes of 50 Hz samples, IBI holds the last ~20 minutes
 * of beats — so picking 30 m on Raw PPG simply shows whatever is in the
 * buffer (sparse on the left edge), which is the right behavior.
 */
export const WINDOW_OPTIONS: readonly WindowOption[] = [
  { value: 10, label: '10s' },
  { value: 30, label: '30s' },
  { value: 60, label: '1m' },
  { value: 300, label: '5m' },
  { value: 600, label: '10m' },
  { value: 1800, label: '30m' },
];

export const SMOOTH_OPTIONS = [
  { value: 0, label: 'off' },
  { value: 3, label: '3' },
  { value: 7, label: '7' },
  { value: 15, label: '15' },
  { value: 31, label: '31' },
] as const;

export const RESCALE_OPTIONS = [
  { value: 0, label: 'live' },
  { value: 5, label: '5s' },
  { value: 15, label: '15s' },
  { value: 30, label: '30s' },
  { value: 60, label: '60s' },
] as const;

export type LineShape = 'linear' | 'spline' | 'hv';
export const SHAPE_OPTIONS: readonly { value: LineShape; label: string }[] = [
  { value: 'linear', label: 'linear' },
  { value: 'spline', label: 'spline' },
  { value: 'hv', label: 'step' },
];

export interface ChartControlsProps {
  windowSec?: number;
  windowOptions?: readonly WindowOption[];
  onWindowChange?: (sec: number) => void;
  smoothN?: number;
  onSmoothChange?: (n: number) => void;
  rescaleSec?: number;
  onRescaleChange?: (sec: number) => void;
  shape?: LineShape;
  onShapeChange?: (shape: LineShape) => void;
  children?: ReactNode;
}

export default function ChartControls({
  windowSec,
  windowOptions = WINDOW_OPTIONS,
  onWindowChange,
  smoothN,
  onSmoothChange,
  rescaleSec: _rescaleSec,
  onRescaleChange: _onRescaleChange,
  shape,
  onShapeChange,
  children,
}: ChartControlsProps) {
  return (
    <div className="flex items-center gap-3">
      {windowSec !== undefined && onWindowChange ? (
        <ButtonGroup<number>
          label="window"
          value={windowSec}
          options={windowOptions}
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
      {shape !== undefined && onShapeChange ? (
        <ButtonGroup<LineShape>
          label="shape"
          value={shape}
          options={SHAPE_OPTIONS}
          onChange={onShapeChange}
        />
      ) : null}
      {/* Manual rescale picker removed — all charts now use Plotly's
          auto-range. The rescaleSec/onRescaleChange props remain in the
          interface for source compatibility but no UI is rendered, so
          rescaleSec stays at its default 0 ("live") and the per-chart
          pull() never enters the manual-range branch. */}
      {children}
    </div>
  );
}
