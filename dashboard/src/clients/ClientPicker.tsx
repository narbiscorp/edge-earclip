// The "training client" selector that lives in the gear (⚙) menu and the
// expert header. Picks which client the next saved session is attributed to.
//
// Renders NOTHING when the signed-in user has zero clients, so personal users
// (and not-signed-in / unconfigured deployments) see no extra chrome — callers
// can mount it unconditionally.

import { useEffect } from 'react';
import { useClientList } from './useClients';
import { useClientStore } from './clientStore';

export default function ClientPicker({ compact = false }: { compact?: boolean }) {
  const { rows, status } = useClientList();
  const activeClientId = useClientStore((s) => s.activeClientId);
  const setActiveClient = useClientStore((s) => s.setActiveClient);

  // Reconcile a stale selection: if the persisted active client was archived
  // or deleted since it was chosen, it won't be in the active list — fall back
  // to Unassigned so we never attribute a session to a vanished client.
  useEffect(() => {
    if (status !== 'ready') return;
    if (activeClientId && !rows.some((c) => c.id === activeClientId)) {
      setActiveClient(null);
    }
  }, [status, rows, activeClientId, setActiveClient]);

  // No clients → no clinician context → render nothing.
  if (status !== 'ready' || rows.length === 0) return null;

  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const id = e.target.value;
    if (!id) { setActiveClient(null); return; }
    const c = rows.find((r) => r.id === id);
    if (c) setActiveClient({ id: c.id, name: c.display_name });
  };

  return (
    <div className={compact ? 'shrink-0' : 'px-2 py-1'}>
      {!compact && (
        <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500 mb-1">
          Training client
        </div>
      )}
      <select
        value={activeClientId ?? ''}
        onChange={onChange}
        title="Which client is training — the next saved session is attributed to them"
        className={
          'rounded bg-slate-800 border border-slate-700 px-2 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-indigo-500 ' +
          (compact ? 'w-44 max-w-[40vw]' : 'w-full')
        }
      >
        <option value="">Unassigned (personal)</option>
        {rows.map((c) => (
          <option key={c.id} value={c.id}>
            {c.display_name}{c.external_code ? ` · ${c.external_code}` : ''}
          </option>
        ))}
      </select>
    </div>
  );
}
