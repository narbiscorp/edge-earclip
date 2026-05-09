import { useDashboardStore } from '../state/store';
import type { BatteryState } from '../state/store';
import { getPairedDeviceName } from '../ble/narbisDevice';
import { forgetEdgePairedDevice, getEdgePairedDeviceName } from '../ble/edgeDevice';
import type { NarbisStatus } from '../ble/narbisDevice';
import type { PolarStatus } from '../ble/polarH10';
import type { EdgeStatus } from '../ble/edgeDevice';

function formatBattery(b: BatteryState | null): string {
  if (b === null) return '';
  const v = b.mv != null ? `${(b.mv / 1000).toFixed(2)}V` : '—';
  const chg = b.charging ? ' ⚡' : '';
  return ` · ${v} · ${b.soc_pct}%${chg}`;
}

const dotClass: Record<NarbisStatus | PolarStatus | EdgeStatus, string> = {
  disconnected: 'bg-slate-500',
  connecting: 'bg-amber-400 animate-pulse',
  reconnecting: 'bg-amber-400 animate-pulse',
  connected: 'bg-emerald-400',
};

export default function ConnectionPanel() {
  const narbis = useDashboardStore((s) => s.connection.narbis);
  const polar = useDashboardStore((s) => s.connection.polar);
  const edge = useDashboardStore((s) => s.connection.edge);
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
  const onConnectEdge = () => {
    void useDashboardStore.getState().connectEdge().catch((err) => {
      console.error('connect edge failed', err);
    });
  };
  const onDisconnectEdge = () => {
    void useDashboardStore.getState().disconnectEdge().catch((err) => {
      console.error('disconnect edge failed', err);
    });
  };
  const onRepairEarclip = () => {
    if (!confirm(
      'This tells the connected glasses to forget their current earclip and ' +
      'rescan for a new one. The closest powered-on Narbis Earclip will be ' +
      'picked. Continue?'
    )) return;
    void useDashboardStore.getState().edgeForgetEarclip().catch((err) => {
      console.error('re-pair earclip failed', err);
    });
  };

  const pairedName = getPairedDeviceName();
  const edgePairedName = getEdgePairedDeviceName();

  const narbisLabel =
    narbis.state === 'connected'
      ? `${narbis.deviceName ?? 'Narbis'}${formatBattery(narbis.battery)}`
      : narbis.state === 'reconnecting'
        ? narbis.reconnectAttempt
          ? `reconnecting (attempt ${narbis.reconnectAttempt})…`
          : 'reconnecting…'
        : narbis.state === 'connecting'
          ? 'connecting…'
          : pairedName
            ? `disconnected (paired: ${pairedName})`
            : 'disconnected';

  /* Sub-status line under the pill: shows the current phase of the
   * connect / reconnect handshake so the user knows whether the dashboard
   * is still scanning, discovering services, subscribing, or stuck. Only
   * meaningful while a connect attempt is in flight. */
  const narbisPhase =
    (narbis.state === 'connecting' || narbis.state === 'reconnecting') && narbis.phase
      ? formatPhase(narbis.phase)
      : null;

  const edgeLabel =
    edge.state === 'connected'
      ? edge.deviceName ?? 'Edge'
      : edge.state === 'reconnecting'
        ? 'reconnecting…'
        : edge.state === 'connecting'
          ? 'connecting…'
          : edgePairedName
            ? `disconnected (paired: ${edgePairedName})`
            : 'disconnected';

  /* Path B: glasses-to-earclip relay status. Only meaningful when the
   * dashboard is connected to the glasses. null = unknown (still
   * waiting for first 0xF6 frame after connect, or older firmware that
   * doesn't emit it). */
  const relayBadge = (() => {
    if (edge.state !== 'connected') return null;
    if (edge.earclipRelay === true)  return { text: '⇄ Earclip linked',    cls: 'bg-emerald-700 text-emerald-100' };
    if (edge.earclipRelay === false) return { text: '⇢ scanning earclip…', cls: 'bg-amber-700 text-amber-100 animate-pulse' };
    return                                  { text: '⇢ relay status: …',  cls: 'bg-slate-700 text-slate-300' };
  })();

  const polarLabel =
    polar.state === 'connected'
      ? polar.deviceName ?? 'Polar H10'
      : polar.state === 'reconnecting'
        ? 'reconnecting…'
        : polar.state === 'connecting'
          ? 'connecting…'
          : 'disconnected';

  const onForgetNarbis = () => {
    void useDashboardStore.getState().forgetNarbis().catch((err) => {
      console.error('forget narbis failed', err);
    });
  };
  const onForgetEdge = () => {
    void useDashboardStore.getState().disconnectEdge().catch(() => { /* ignore */ });
    forgetEdgePairedDevice();
  };

  return (
    <div className="flex flex-col items-end gap-1 text-xs text-slate-200">
      <div className="flex items-center gap-2 flex-wrap justify-end">
        {/* Earclip */}
        <Pill label={`Earclip: ${narbisLabel}`} dot={dotClass[narbis.state]} />
        {narbis.state === 'disconnected' ? (
          <>
            <button
              className="rounded bg-emerald-600 hover:bg-emerald-500 px-2 py-1 text-xs font-medium"
              onClick={onConnectNarbis}
            >
              Connect Earclip
            </button>
            {pairedName ? (
              <button
                className="rounded bg-slate-700 hover:bg-slate-600 px-2 py-1 text-xs"
                onClick={onForgetNarbis}
                title="Clear the saved earclip; next connect will prompt"
              >
                Forget
              </button>
            ) : null}
          </>
        ) : (
          <button
            className="rounded bg-slate-700 hover:bg-slate-600 px-2 py-1 text-xs"
            onClick={onDisconnectNarbis}
            disabled={narbis.state === 'connecting'}
          >
            Disconnect
          </button>
        )}

        {/* Edge glasses */}
        <Pill label={`Edge: ${edgeLabel}`} dot={dotClass[edge.state]} />
        {relayBadge ? (
          <span
            className={`px-2 py-1 rounded text-[11px] font-medium ${relayBadge.cls}`}
            title="Glasses-to-earclip BLE relay (Path B). Linked = central is connected to earclip and IBI/raw/config flowing."
          >
            {relayBadge.text}
          </span>
        ) : null}
        {edge.state === 'disconnected' ? (
          <>
            <button
              className="rounded bg-emerald-600 hover:bg-emerald-500 px-2 py-1 text-xs font-medium"
              onClick={onConnectEdge}
            >
              Connect Glasses
            </button>
            {edgePairedName ? (
              <button
                className="rounded bg-slate-700 hover:bg-slate-600 px-2 py-1 text-xs"
                onClick={onForgetEdge}
                title="Clear the saved glasses; next connect will prompt"
              >
                Forget
              </button>
            ) : null}
          </>
        ) : (
          <>
            <button
              className="rounded bg-slate-700 hover:bg-slate-600 px-2 py-1 text-xs"
              onClick={onDisconnectEdge}
              disabled={edge.state === 'connecting'}
            >
              Disconnect
            </button>
            <button
              className="rounded bg-indigo-600 hover:bg-indigo-500 px-2 py-1 text-xs font-medium disabled:opacity-50"
              onClick={onRepairEarclip}
              disabled={edge.state !== 'connected'}
              title="Tell the glasses to drop their current earclip and rescan"
            >
              Re-pair earclip
            </button>
          </>
        )}

        {/* Polar reference */}
        <Pill label={`Polar: ${polarLabel}`} dot={dotClass[polar.state]} />
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
      {narbisPhase ? (
        <div className="text-slate-400 text-[11px]" title={`narbis phase: ${narbisPhase}`}>
          earclip: {narbisPhase}
        </div>
      ) : null}
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

/* Map raw phase strings emitted by NarbisDevice into short, user-readable
 * labels. Anything unrecognised falls through verbatim so new phases
 * surface in the UI without code changes. */
function formatPhase(phase: string): string {
  switch (phase) {
    case 'requesting-device':           return 'waiting for device picker';
    case 'connecting-gatt':             return 'connecting GATT';
    case 'discovering-services':        return 'discovering services';
    case 'discovering-services-retry':  return 'retrying service discovery';
    case 'discovering-characteristics': return 'discovering characteristics';
    case 'subscribing':                 return 'subscribing to notifications';
    case 'reconnecting':                return 'reconnecting';
    case 'ready':                       return 'ready';
    default:                            return phase;
  }
}
