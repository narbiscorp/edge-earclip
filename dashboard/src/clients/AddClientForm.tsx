// Create / edit a client profile. Used by ClientsPane (create) and
// ClientDetail (edit). Controlled inputs; on submit it calls the supplied
// `onSubmit` (createClient or updateClient) and surfaces any error.

import { useState } from 'react';
import type { ClientResult } from './clientApi';
import type { ClientRow, NewClientInput } from './types';

export default function AddClientForm({
  initial,
  submitLabel = 'Add client',
  onSubmit,
  onDone,
  onCancel,
}: {
  initial?: ClientRow;
  submitLabel?: string;
  onSubmit: (input: NewClientInput) => Promise<ClientResult>;
  onDone: (created: ClientRow) => void;
  onCancel?: () => void;
}) {
  const [displayName, setDisplayName] = useState(initial?.display_name ?? '');
  const [externalCode, setExternalCode] = useState(initial?.external_code ?? '');
  const [birthYear, setBirthYear] = useState(
    initial?.birth_year != null ? String(initial.birth_year) : '',
  );
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!displayName.trim()) { setError('Name is required'); return; }

    let yearNum: number | null = null;
    if (birthYear.trim()) {
      yearNum = Number(birthYear.trim());
      if (!Number.isInteger(yearNum) || yearNum < 1900 || yearNum > 2100) {
        setError('Birth year must be a 4-digit year between 1900 and 2100');
        return;
      }
    }

    setBusy(true);
    setError(null);
    const res = await onSubmit({
      display_name: displayName,
      external_code: externalCode,
      birth_year: yearNum,
      notes,
    });
    setBusy(false);
    if (res.error || !res.data) {
      setError(res.error ?? 'Save failed');
      return;
    }
    onDone(res.data);
  }

  return (
    <form onSubmit={submit} className="rounded-lg border border-slate-700 bg-slate-800/50 p-4 space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Display name *">
          <input
            type="text"
            required
            autoFocus
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="e.g. J. Doe or Client 014"
            className="w-full rounded bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500"
          />
        </Field>
        <Field label="External code">
          <input
            type="text"
            value={externalCode}
            onChange={(e) => setExternalCode(e.target.value)}
            placeholder="optional — MRN / chart #"
            className="w-full rounded bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500"
          />
        </Field>
        <Field label="Birth year">
          <input
            type="number"
            inputMode="numeric"
            value={birthYear}
            onChange={(e) => setBirthYear(e.target.value)}
            placeholder="optional — e.g. 1987"
            className="w-full rounded bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500"
          />
        </Field>
        <Field label="Notes">
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="optional"
            className="w-full rounded bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500"
          />
        </Field>
      </div>

      {error && (
        <div className="rounded border border-rose-700/40 bg-rose-900/20 p-2 text-xs text-rose-200">
          {error}
        </div>
      )}

      <div className="flex gap-2 justify-end">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-sm font-medium text-slate-200 transition"
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={busy || !displayName.trim()}
          className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium text-white transition"
        >
          {busy ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wide text-slate-500">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
