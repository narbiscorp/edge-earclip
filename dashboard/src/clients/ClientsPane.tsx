// Clients tab of the portal: the roster (add + list) and drill-down into one
// client's detail. Selecting a card swaps the whole pane to ClientDetail.

import { useState } from 'react';
import { useClientList } from './useClients';
import { createClient } from './clientApi';
import AddClientForm from './AddClientForm';
import ClientDetail from './ClientDetail';
import type { ClientRow } from './types';

export default function ClientsPane() {
  const [showArchived, setShowArchived] = useState(false);
  const list = useClientList({ includeArchived: showArchived });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const selected = selectedId ? list.rows.find((c) => c.id === selectedId) ?? null : null;

  if (selected) {
    return (
      <ClientDetail
        client={selected}
        onBack={() => setSelectedId(null)}
        onChanged={list.refresh}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="text-base font-semibold text-slate-100">Clients</h2>
        <label className="flex items-center gap-1.5 text-xs text-slate-400 ml-1">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
            className="accent-indigo-500"
          />
          Show archived
        </label>
        <button
          onClick={() => setAdding((v) => !v)}
          className="ml-auto px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium text-white transition"
        >
          {adding ? 'Close' : '+ Add client'}
        </button>
      </div>

      {adding && (
        <AddClientForm
          onSubmit={createClient}
          onDone={() => { setAdding(false); list.refresh(); }}
          onCancel={() => setAdding(false)}
        />
      )}

      {list.status === 'loading' && (
        <div className="p-8 text-center text-slate-500 text-sm">Loading…</div>
      )}
      {list.status === 'error' && (
        <div className="p-8 text-center text-rose-400 text-sm">Couldn't load: {list.error}</div>
      )}
      {list.status === 'ready' && list.rows.length === 0 && !adding && (
        <div className="p-8 text-center text-slate-500 text-sm">
          No clients yet. Add your first client to start attributing sessions to them.
        </div>
      )}

      {list.rows.length > 0 && (
        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {list.rows.map((c) => (
            <ClientCard key={c.id} client={c} onOpen={() => setSelectedId(c.id)} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ClientCard({ client, onOpen }: { client: ClientRow; onOpen: () => void }) {
  const sub = [
    client.external_code ? `Code ${client.external_code}` : null,
    client.birth_year ? `Born ${client.birth_year}` : null,
  ].filter(Boolean).join(' · ');
  return (
    <li>
      <button
        onClick={onOpen}
        className="w-full text-left rounded-lg border border-slate-700 bg-slate-900/40 hover:bg-slate-800/60 hover:border-slate-500 p-4 transition"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-slate-100 truncate">{client.display_name}</span>
          {client.archived && (
            <span className="text-[10px] uppercase tracking-wide text-amber-300/80 border border-amber-500/30 rounded px-1.5 py-0.5">
              archived
            </span>
          )}
        </div>
        <div className="text-xs text-slate-500 truncate mt-0.5">{sub || 'No profile details'}</div>
        <div className="text-[11px] text-cyan-400/80 mt-2">View history &amp; trends →</div>
      </button>
    </li>
  );
}
