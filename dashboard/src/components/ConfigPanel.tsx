import { useDashboardStore } from '../state/store';
import { edgeDevice } from '../ble/edgeDevice';
import { SECTIONS } from './config/fieldSchema';
import { useDebouncedConfigWrite } from './config/useDebouncedConfigWrite';
import { useExpandState } from './config/useExpandState';
import ConfigSection from './config/ConfigSection';
import { BUILT_IN_DEFAULT } from './config/presetStore';

export default function ConfigPanel() {
  const narbisState         = useDashboardStore((s) => s.connection.narbis.state);
  const edgeState           = useDashboardStore((s) => s.connection.edge.state);
  const earclipRelay        = useDashboardStore((s) => s.connection.edge.earclipRelay);
  const config              = useDashboardStore((s) => s.config);
  const configIsBlindDefault = useDashboardStore((s) => s.configIsBlindDefault);
  /* Path B Phase 1: editable when either the dashboard is directly on the
   * earclip OR the glasses are connected and the relay has populated a
   * config (writes fall through narbisDevice.writeConfig → edgeDevice). */
  const isConnected =
    narbisState === 'connected' ||
    (edgeState === 'connected' && config !== null);
  /* Relay can pass writes through right now even if we haven't yet
   * received the current config blob from the earclip. Used to render a
   * "loading + reload" affordance instead of the blunt "connect a device"
   * fallback when the user is on the relay path and the one-shot config
   * read inside enter_ready() didn't make it through. */
  const relayLinkedNoConfig =
    edgeState === 'connected' && earclipRelay === true && config === null;
  const writer = useDebouncedConfigWrite(isConnected);
  const { expanded, toggle } = useExpandState();

  const disabled = !writer.canWrite;

  const reloadFromEarclip = () => {
    void edgeDevice.requestEarclipConfigRead().catch((err) => {
      console.error('requestEarclipConfigRead failed', err);
    });
  };

  const editWithDefaults = () => {
    useDashboardStore.getState().enterBlindDefaultsMode();
  };

  if (!writer.draft) {
    return (
      <div className="rounded border border-slate-800 bg-slate-900/50 p-4 text-[12px] text-slate-400">
        <div className="flex items-center justify-between mb-1 gap-2">
          <div className="font-medium text-slate-200">Configuration</div>
          {relayLinkedNoConfig ? (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={reloadFromEarclip}
                className="text-[10px] rounded bg-slate-800 hover:bg-slate-700 px-2 py-0.5 text-slate-300"
                title="Re-request the current config from the earclip via the glasses relay (sends 0xC5). Requires earclip firmware with the 0xC5 handler."
              >
                reload from earclip
              </button>
              <button
                type="button"
                onClick={editWithDefaults}
                className="text-[10px] rounded bg-amber-700 hover:bg-amber-600 px-2 py-0.5 text-amber-50"
                title="Open the editor with firmware defaults loaded. Use when reload-from-earclip never returns config (e.g. earclip firmware predates the notify-on-subscribe fix). Apply will OVERWRITE the device's current config with whatever is in the form."
              >
                edit with defaults
              </button>
            </div>
          ) : null}
        </div>
        {relayLinkedNoConfig ? (
          <span>
            Loading config from earclip via glasses relay… If this stays here for more than a
            few seconds, click <span className="text-slate-300">reload from earclip</span>.
            Still nothing? The earclip is probably running firmware older than{' '}
            <span className="text-slate-300">narbiscorp/edge-earclip#28</span> — click{' '}
            <span className="text-amber-300">edit with defaults</span> to bypass the read entirely
            and write a known-good config to the device.
          </span>
        ) : (
          <span>Connect a Narbis device to load and edit config.</span>
        )}
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
      {configIsBlindDefault ? (
        <div className="rounded border border-amber-700/60 bg-amber-900/20 px-2 py-1 text-[10px] text-amber-200">
          <span className="font-semibold">Editing firmware defaults — not the device's current config.</span>{' '}
          The earclip didn't send its current state (likely older firmware). Apply will{' '}
          <span className="font-semibold">overwrite</span> whatever's currently on the device with
          the values you've entered here. Once the earclip notifies back the new state, this banner
          will clear.
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
