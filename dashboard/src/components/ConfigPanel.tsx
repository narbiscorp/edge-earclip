import { useDashboardStore } from '../state/store';
import { SECTIONS } from './config/fieldSchema';
import { useDebouncedConfigWrite } from './config/useDebouncedConfigWrite';
import { useExpandState } from './config/useExpandState';
import ConfigSection from './config/ConfigSection';
import { BUILT_IN_DEFAULT } from './config/presetStore';

export default function ConfigPanel() {
  const narbisState = useDashboardStore((s) => s.connection.narbis.state);
  const isConnected = narbisState === 'connected';
  const writer = useDebouncedConfigWrite(isConnected);
  const { expanded, toggle } = useExpandState();

  const disabled = !writer.canWrite;

  if (!writer.draft) {
    return (
      <div className="rounded border border-slate-800 bg-slate-900/50 p-4 text-[12px] text-slate-400">
        <div className="font-medium text-slate-200 mb-1">Configuration</div>
        Connect a Narbis device to load and edit config.
      </div>
    );
  }

  return (
    <div className="rounded border border-slate-800 bg-slate-900/50 p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="text-[12px] font-medium text-slate-200">Configuration</div>
        <button
          type="button"
          onClick={() => writer.resetAll(BUILT_IN_DEFAULT.config)}
          disabled={disabled}
          className="text-[10px] rounded bg-slate-800 hover:bg-slate-700 px-2 py-0.5 text-slate-300 disabled:opacity-40"
          title="Reset every field to firmware defaults"
        >
          reset all
        </button>
      </div>
      {!isConnected ? (
        <div className="rounded border border-amber-700/40 bg-amber-900/10 px-2 py-1 text-[10px] text-amber-300">
          Disconnected — edits are disabled until reconnect.
        </div>
      ) : null}
      {writer.lastError ? (
        <div className="rounded border border-rose-800/40 bg-rose-900/10 px-2 py-1 text-[10px] text-rose-300">
          {writer.lastError}
        </div>
      ) : null}
      <div className={`flex flex-col gap-2 ${disabled ? 'opacity-60' : ''}`}>
        {SECTIONS.map((sec) => (
          <ConfigSection
            key={sec.id}
            section={sec}
            expanded={expanded[sec.id]}
            onToggle={() => toggle(sec.id)}
            config={writer.draft!}
            errors={writer.errors}
            fieldStatus={writer.fieldStatus}
            sectionStatus={writer.sectionStatus[sec.id]}
            disabled={disabled}
            onFieldChange={writer.setField}
            onResetSection={() => writer.resetSection(sec.id, BUILT_IN_DEFAULT.config)}
          />
        ))}
      </div>
    </div>
  );
}
