/*
 * ui.tsx — small shared controls.
 *
 * Every control that changes what the numbers MEAN (filter kind, window length,
 * resample rate) carries an `Info` explaining it, because a smoothed trace and a
 * raw one look equally authoritative on screen.
 */
import type { ReactNode } from 'react';
import {
  FILTER_LABELS,
  RESAMPLE_OPTIONS,
  SHAPE_OPTIONS,
  type SettingsState,
} from './settings';
import type { TraceShaping } from './dsp';

export function Info({ text }: { text: string }): ReactNode {
  return (
    <button type="button" className="info" title={text} aria-label={text}>
      i
    </button>
  );
}

export interface SegmentedProps<T extends string | number> {
  label?: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
  info?: string;
}

export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
  info,
}: SegmentedProps<T>): ReactNode {
  return (
    <div className="field">
      {label && (
        <span className="label">
          {label}
          {info && <Info text={info} />}
        </span>
      )}
      <div className="seg" role="group" aria-label={label}>
        {options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={o.value === value}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export interface SelectProps<T extends string | number> {
  label?: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
  info?: string;
}

export function Select<T extends string | number>({
  label,
  value,
  options,
  onChange,
  info,
}: SelectProps<T>): ReactNode {
  const numeric = typeof value === 'number';
  return (
    <label className="field">
      {label && (
        <span className="label">
          {label}
          {info && <Info text={info} />}
        </span>
      )}
      <select
        className="input"
        value={String(value)}
        onChange={(e) => onChange((numeric ? Number(e.target.value) : e.target.value) as T)}
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Check({
  label,
  checked,
  onChange,
  color,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  color?: string;
}): ReactNode {
  return (
    <label className="field" style={{ cursor: 'pointer' }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ accentColor: color ?? 'var(--accent)' }}
      />
      <span className="label" style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>
        {label}
      </span>
    </label>
  );
}

/** The averaging / smoothing / spline row that sits under each chart. */
export function ShapingControls({
  shaping,
  patch,
}: {
  shaping: TraceShaping;
  patch: (p: Partial<TraceShaping>) => void;
}): ReactNode {
  const active = FILTER_LABELS.find((f) => f.value === shaping.filter);
  const usesN = shaping.filter === 'movavg' || shaping.filter === 'median' || shaping.filter === 'savgol';
  return (
    <div className="shaping">
      <Select
        label="Filter"
        value={shaping.filter}
        options={FILTER_LABELS.map((f) => ({ value: f.value, label: f.label }))}
        onChange={(filter) => patch({ filter })}
        info="How the drawn trace is conditioned. Never applied to the recorded data or the CSV export."
      />

      {usesN && (
        <label className="field">
          <span className="label">Window</span>
          <input
            className="input"
            type="range"
            min={3}
            max={61}
            step={2}
            value={shaping.filterN}
            onChange={(e) => patch({ filterN: Number(e.target.value) })}
          />
          <span className="label" style={{ minWidth: '3.2ch' }}>
            {shaping.filterN}
          </span>
        </label>
      )}

      {shaping.filter === 'savgol' && (
        <Segmented
          label="Order"
          value={shaping.savgolOrder}
          options={[
            { value: 2, label: '2' },
            { value: 3, label: '3' },
            { value: 4, label: '4' },
          ]}
          onChange={(savgolOrder) => patch({ savgolOrder })}
          info="Polynomial degree of the local fit. Higher follows sharper features but rejects less noise."
        />
      )}

      {shaping.filter === 'ewma' && (
        <label className="field">
          <span className="label">
            Alpha
            <Info text="Per-sample weight. Lower is smoother. Run forward then backward, so peaks do not shift in time." />
          </span>
          <input
            className="input"
            type="range"
            min={0.02}
            max={1}
            step={0.02}
            value={shaping.ewmaAlpha}
            onChange={(e) => patch({ ewmaAlpha: Number(e.target.value) })}
          />
          <span className="label" style={{ minWidth: '4ch' }}>
            {shaping.ewmaAlpha.toFixed(2)}
          </span>
        </label>
      )}

      <div className="sep" />

      <Select
        label="Spline resample"
        value={shaping.resampleHz}
        options={RESAMPLE_OPTIONS}
        onChange={(resampleHz) => patch({ resampleHz })}
        info="Monotone cubic (PCHIP) interpolation onto a uniform time grid. Shape-preserving, so unlike a plain cubic spline it cannot overshoot below the shortest measured interval. Needed to compare an irregular tachogram against a uniformly-sampled signal."
      />

      <Segmented
        label="Line"
        value={shaping.shape}
        options={SHAPE_OPTIONS}
        onChange={(shape) => patch({ shape })}
        info="How Plotly draws between points. 'spline' curves the rendering only — it does not change or add data."
      />

      <div className="sep" />

      <Select
        label="Max points"
        value={shaping.maxPoints}
        options={[
          { value: 1000, label: '1k' },
          { value: 2500, label: '2.5k' },
          { value: 4000, label: '4k' },
          { value: 10000, label: '10k' },
        ]}
        onChange={(maxPoints) => patch({ maxPoints })}
        info="Drawing budget per trace. Reduction uses largest-triangle-three-buckets, which keeps peaks rather than dropping them like plain striding would."
      />

      {active && active.value !== 'none' && <div className="hint">{active.hint}</div>}
    </div>
  );
}

/** Numeric formatter that renders a dash rather than a misleading zero. */
export function fmt(v: number | null | undefined, decimals = 1): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toFixed(decimals);
}

export function Readout({
  color,
  name,
  value,
  unit,
}: {
  color: string;
  name: string;
  value: string;
  unit?: string;
}): ReactNode {
  return (
    <span className="readout">
      <span className="swatch" style={{ background: color }} aria-hidden="true" />
      {name}
      <span className="val">{value}</span>
      {unit && <span>{unit}</span>}
    </span>
  );
}

export type { SettingsState };
