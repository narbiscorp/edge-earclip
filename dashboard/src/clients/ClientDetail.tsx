// One client's profile + history. The sessions/trends sub-tabs reuse the
// existing SessionList / TrendsView, scoped to this client via the clientId
// prop — same charts the personal History shows, filtered to one client.

import { useState } from 'react';
import SessionList from '../sessions/SessionList';
import TrendsView from '../sessions/TrendsView';
import AddClientForm from './AddClientForm';
import { updateClient, archiveClient, deleteClient } from './clientApi';
import type { ClientRow } from './types';

type Tab = 'sessions' | 'trends';

export default function ClientDetail({
  client,
  onBack,
  onChanged,
}: {
  client: ClientRow;
  onBack: () => void;
  onChanged: () => void;   // parent refetches the client list
}) {
  const [tab, setTab] = useState<Tab>('sessions');
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  async function doSetArchived(archived: boolean) {
    setBusy(true);
    await archiveClient(client.id, archived);
    setBusy(false);
    onChanged();
    // Archiving drops the client out of the default (active-only) roster, so
    // bounce back to the list. Unarchiving keeps them visible — stay on the
    // page so the button flips to "Archive" and the restored state is obvious.
    if (archived) onBack();
  }

  async function doDelete() {
    setBusy(true);
    const ok = await deleteClient(client.id);
    setBusy(false);
    if (ok) { onChanged(); onBack(); }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 flex-wrap">
        <button
          onClick={onBack}
          className="px-3 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 transition"
        >
          ← All clients
        </button>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="text-lg font-semibold text-slate-100 truncate">{client.display_name}</div>
            {client.archived && (
              <span className="shrink-0 text-[10px] uppercase tracking-wide text-amber-300/80 border border-amber-500/30 rounded px-1.5 py-0.5">
                archived
              </span>
            )}
          </div>
          <div className="text-xs text-slate-500">
            {[
              client.external_code ? `Code ${client.external_code}` : null,
              client.birth_year ? `Born ${client.birth_year}` : null,
            ].filter(Boolean).join(' · ') || 'No profile details'}
            {client.notes ? ` — ${client.notes}` : ''}
          </div>
        </div>
        <div className="flex gap-2 ml-auto">
          <button
            onClick={() => setEditing((v) => !v)}
            className="px-3 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 transition"
          >
            {editing ? 'Cancel edit' : 'Edit'}
          </button>
          {client.archived ? (
            <button
              onClick={() => void doSetArchived(false)}
              disabled={busy}
              className="px-3 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-emerald-300 transition disabled:opacity-50"
              title="Restore — show this client in the active-client picker again"
            >
              Unarchive
            </button>
          ) : (
            <button
              onClick={() => void doSetArchived(true)}
              disabled={busy}
              className="px-3 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-amber-300 transition disabled:opacity-50"
              title="Hide from the active-client picker but keep all history"
            >
              Archive
            </button>
          )}
          <button
            onClick={() => setConfirmDelete(true)}
            disabled={busy}
            className="px-3 py-1 rounded-lg bg-slate-800 hover:bg-rose-900/40 text-xs font-medium text-rose-300 transition disabled:opacity-50"
            title="Delete profile — sessions are kept and become Unassigned"
          >
            Delete
          </button>
        </div>
      </div>

      {editing && (
        <AddClientForm
          initial={client}
          submitLabel="Save changes"
          onSubmit={(input) => updateClient(client.id, input)}
          onDone={() => { setEditing(false); onChanged(); }}
          onCancel={() => setEditing(false)}
        />
      )}

      <div className="inline-flex rounded-md border border-slate-700 overflow-hidden text-xs">
        <button
          onClick={() => setTab('sessions')}
          className={'px-3 py-1 ' + (tab === 'sessions' ? 'bg-indigo-600 text-white' : 'bg-slate-800 hover:bg-slate-700 text-slate-300')}
        >
          Sessions
        </button>
        <button
          onClick={() => setTab('trends')}
          className={'px-3 py-1 border-l border-slate-700 ' + (tab === 'trends' ? 'bg-indigo-600 text-white' : 'bg-slate-800 hover:bg-slate-700 text-slate-300')}
        >
          Trends
        </button>
      </div>

      {tab === 'sessions' ? <SessionList clientId={client.id} /> : <TrendsView clientId={client.id} />}

      {confirmDelete && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/90" onClick={() => setConfirmDelete(false)}>
          <div className="bg-slate-900 border border-slate-700 rounded-xl p-5 max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="text-sm text-slate-200 mb-1">Delete {client.display_name}'s profile?</div>
            <div className="text-xs text-slate-500 mb-3">
              Their saved sessions are kept and become “Unassigned”. Prefer Archive if you
              just want to hide them from the picker.
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmDelete(false)} className="px-3 py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-xs text-slate-200">Cancel</button>
              <button onClick={() => void doDelete()} className="px-3 py-1.5 rounded bg-rose-600 hover:bg-rose-500 text-xs text-white">Delete profile</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
