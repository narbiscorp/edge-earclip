import type { NarbisRuntimeConfig } from '../../ble/parsers';
import {
  FIELD_SCHEMA,
  VISIBLE_KEYS_BY_SECTION,
  type ConfigKey,
  type SectionDef,
} from './fieldSchema';
import type { WriteState } from './useDebouncedConfigWrite';
import type { ValidationErrors } from './validateConfig';
import StatusBadge from './fields/StatusBadge';
import NumericField from './fields/NumericField';
import EnumField from './fields/EnumField';
import ToggleField from './fields/ToggleField';
import BitmaskField from './fields/BitmaskField';
import ReadonlyField from './fields/ReadonlyField';

interface Props {
  section: SectionDef;
  expanded: boolean;
  onToggle: () => void;
  config: NarbisRuntimeConfig;
  errors: ValidationErrors;
  fieldStatus: Partial<Record<ConfigKey, WriteState>>;
  sectionStatus: WriteState;
  disabled: boolean;
  onFieldChange: <K extends ConfigKey>(key: K, value: NarbisRuntimeConfig[K]) => void;
  onResetSection: () => void;
}

export default function ConfigSection({
  section,
  expanded,
  onToggle,
  config,
  errors,
  fieldStatus,
  sectionStatus,
  disabled,
  onFieldChange,
  onResetSection,
}: Props) {
  const keys = VISIBLE_KEYS_BY_SECTION[section.id];

  return (
    <div className="rounded border border-slate-800 bg-slate-900/40">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <button
          type="button"
          onClick={onToggle}
          className="flex flex-1 items-center gap-2 text-left text-[12px] font-medium text-slate-200 hover:text-white"
          aria-expanded={expanded}
        >
          <span className="text-[10px] text-slate-500 w-3 inline-block">
            {expanded ? '▾' : '▸'}
          </span>
          <span>{section.label}</span>
          <StatusBadge status={sectionStatus} />
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onResetSection(); }}
          disabled={disabled}
          className="text-[10px] text-slate-500 hover:text-slate-300 disabled:opacity-40"
          title="Reset section to defaults"
        >
          reset
        </button>
      </div>
      {expanded ? (
        <div className="border-t border-slate-800 px-3 py-2 flex flex-col">
          {keys.map((key) => {
            const spec = FIELD_SCHEMA[key];
            const value = config[key];
            const err = errors[key];
            const status = fieldStatus[key];
            switch (spec.kind) {
              case 'numeric':
                return (
                  <NumericField
                    key={key}
                    spec={spec}
                    value={value as number}
                    error={err}
                    status={status}
                    disabled={disabled}
                    onChange={(v) => onFieldChange(key, v as NarbisRuntimeConfig[typeof key])}
                  />
                );
              case 'enum':
                return (
                  <EnumField
                    key={key}
                    spec={spec}
                    value={value as number}
                    error={err}
                    status={status}
                    disabled={disabled}
                    onChange={(v) => onFieldChange(key, v as NarbisRuntimeConfig[typeof key])}
                  />
                );
              case 'toggle':
                return (
                  <ToggleField
                    key={key}
                    spec={spec}
                    value={value as number}
                    error={err}
                    status={status}
                    disabled={disabled}
                    onChange={(v) => onFieldChange(key, v as NarbisRuntimeConfig[typeof key])}
                  />
                );
              case 'bitmask':
                return (
                  <BitmaskField
                    key={key}
                    spec={spec}
                    value={value as number}
                    error={err}
                    status={status}
                    disabled={disabled}
                    onChange={(v) => onFieldChange(key, v as NarbisRuntimeConfig[typeof key])}
                  />
                );
              case 'readonly':
                return <ReadonlyField key={key} spec={spec} value={value} />;
            }
            return null;
          })}
        </div>
      ) : null}
    </div>
  );
}
