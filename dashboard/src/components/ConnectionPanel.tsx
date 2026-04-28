import { useDashboardStore } from '../state/store';
import type { NarbisStatus } from '../ble/narbisDevice';
import type { PolarStatus } from '../ble/polarH10';

const dotClass: Record<NarbisStatus | PolarStatus, string> = {
  disconnected: 'bg-slate-500',
  connecting: 'bg-amber-400 animate-pulse',
  reconnecting: 'bg-amber-400 animate-pulse',
  connected: 'bg-emerald-400',
};

export default function ConnectionPanel() {
  const narbis = useDashboardStore((s) => s.connection.narbis);
  const polar = useDashboardStore((s) => s.connection.polar);
  const recording = useDashboardStore((s) => s.recording);
  const lastError = useDashboardStore((s) => s.lastError);

  const onConnectNarbis = () => {
    void useDashboardStore.getState().connectNarbis().catch((err) => {
      console.error('connect narbis failed', err);
    });
  };
  const onDisconnectNarbis = () => {
    void useDashboardStore.getState().disconnectNarbis().catch((err) => {
      console.error('disconnect narbis failed', err);
    });
  };
  const onConnectPolar = () => {
    void useDashboardStore.getState().connectPolar().catch((err) => {
      console.error('connect polar failed', err);
    });
  };
  const onDisconnectPolar = () => {
    void useDashboardStore.getState().disconnectPolar().catch((err) => {
      console.error('disconnect polar failed', err);
    });
  };

  const narbisLabel =
    narbis.state === 'connected'
      ? `${narbis.deviceName ?? 'Narbis'}${narbis.battery !== null ? ` · ${narbis.battery}%` : ''}`
      : narbis.state === 'reconnecting'
        ? 'reconnecting…'
        : narbis.state === 'connecting'
          ? 'connecting…'
          : 'disconnected';

  const polarLabel =
    polar.state === 'connected'
      ? polar.deviceName ?? 'Polar H10'
      : polar.state === 'reconnecting'
        ? 'reconnecting…'
        : polar.state === 'connecting'
          ? 'connecting…'
          : 'disconnected';

  return (
    <div className="flex flex-col items-end gap-1 text-xs text-slate-200">
      <div className="flex items-center gap-2">
        <Pill
          label={`Narbis: ${narbisLabel}`}
          dot={dotClass[narbis.state]}
        />
        {narbis.state === 'disconnected' ? (
          <button
            className="rounded bg-emerald-600 hover:bg-emerald-500 px-2 py-1 text-xs font-medium"
            onClick={onConnectNarbis}
          >
            Connect Earclip
          </button>
        ) : (
          <button
            className="rounded bg-slate-700 hover:bg-slate-600 px-2 py-1 text-xs"
            onClick={onDisconnectNarbis}
            disabled={narbis.state === 'connecting'}
          >
            Disconnect
          </button>
        )}
        <Pill
          label={`Polar: ${polarLabel}`}
          dot={dotClass[polar.state]}
        />
        {polar.state === 'disconnected' ? (
          <button
            className="rounded bg-emerald-600 hover:bg-emerald-500 px-2 py-1 text-xs font-medium"
            onClick={onConnectPolar}
          >
            Connect H10
          </button>
        ) : (
          <button
            className="rounded bg-slate-700 hover:bg-slate-600 px-2 py-1 text-xs"
            onClick={onDisconnectPolar}
            disabled={polar.state === 'connecting'}
          >
            Disconnect
          </button>
        )}
        <span className="px-2 py-1 rounded bg-slate-800 text-slate-400">
          Recording: {recording.active ? 'on' : 'idle'}
        </span>
      </div>
      {lastError ? (
        <div className="text-rose-400 text-[11px] max-w-[640px] truncate" title={lastError}>
          {lastError}
        </div>
      ) : null}
    </div>
  );
}

function Pill({ label, dot }: { label: string; dot: string }) {
  return (
    <span className="flex items-center gap-2 px-2 py-1 rounded bg-slate-800">
      <span className={`inline-block w-2 h-2 rounded-full ${dot}`} />
      <span>{label}</span>
    </span>
  );
}
