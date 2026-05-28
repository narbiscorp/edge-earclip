// Past-sessions list. Click a row to open the detail modal.
//
// Read-only operations are scoped to the signed-in user via RLS — there is
// no need to filter `user_id` client-side.

import { useState } from 'react';
import { useSessionList, type SessionListRow } from './useSessions';
import SessionDetailModal from './SessionDetailModal';
import { deleteSession } from './saveSession';

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function ChipNumber({ label, value, unit, tone = 'default' }: {
  label: string;
  value: string;
  unit?: string;
  tone?: 'default' | 'good' | 'okay' | 'warn';
}) {
  const color = {
    default: 'text-slate-200',
    good:    'text-emerald-300',
    okay:    'text-cyan-300',
    warn:    'text-amber-300',
  }[tone];
  return (
    <div className="flex flex-col items-end leading-tight">
      <span className={`text-sm tabular-nums font-semibold ${color}`}>{value}{unit && <span className="text-[10px] text-slate-500 ml-0.5">{unit}</span>}</span>
      <span className="text-[10px] uppercase tracking-wide text-slate-500">{label}</span>
    </div>
  );
}

export default function SessionList() {
  const list = useSessionList();
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  async function onDelete(id: string) {
    const ok = await deleteSession(id);
    if (ok) {
      setConfirmDelete(null);
      list.refresh();
    }
  }

  if (list.status === 'idle') {
    return (
      <div className="p-8 text-center text-slate-500 text-sm">
        Sign in to see your saved sessions.
      </div>
    );
  }
  if (list.status === 'loading') {
    return <div className="p-8 text-center text-slate-500 text-sm">Loading…</div>;
  }
  if (list.status === 'error') {
    return <div className="p-8 text-center text-rose-400 text-sm">Couldn't load: {list.error}</div>;
  }
  if (list.rows.length === 0) {
    return (
      <div className="p-8 text-center text-slate-500 text-sm">
        No sessions yet. Train for at least 5 minutes and they'll show up here automatically.
      </div>
    );
  }

  return (
    <>
      <ul className="divide-y divide-slate-800 border border-slate-800 rounded-lg overflow-hidden">
        {list.rows.map((row) => (
          <li
            key={row.id}
            className="flex items-center gap-4 px-4 py-3 bg-slate-900/30 hover:bg-slate-800/60 cursor-pointer transition"
            onClick={() => setOpenId(row.id)}
          >
            <div className="flex-1 min-w-0">
              <div className="text-sm text-slate-200 truncate">{fmtDate(row.started_at)}</div>
              <div className="text-xs text-slate-500 truncate">
                {fmtDuration(row.duration_seconds)} · {row.beat_count} beats
                {row.notes ? ` · ${row.notes}` : ''}
              </div>
            </div>
            <RowChips row={row} />
            <button
              onClick={(e) => { e.stopPropagation(); setConfirmDelete(row.id); }}
              className="text-xs text-slate-500 hover:text-rose-400 px-2 py-1 rounded hover:bg-rose-900/20 transition shrink-0"
              title="Delete this session"
            >
              ×
            </button>
          </li>
        ))}
      </ul>

      {openId && (
        <SessionDetailModal
          id={openId}
          onClose={() => setOpenId(null)}
          onDeleted={() => { setOpenId(null); list.refresh(); }}
        />
      )}

      {confirmDelete && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/90" onClick={() => setConfirmDelete(null)}>
          <div className="bg-slate-900 border border-slate-700 rounded-xl p-5 max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="text-sm text-slate-200 mb-3">Delete this session permanently?</div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmDelete(null)} className="px-3 py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-xs text-slate-200">Cancel</button>
              <button onClick={() => void onDelete(confirmDelete)} className="px-3 py-1.5 rounded bg-rose-600 hover:bg-rose-500 text-xs text-white">Delete</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function RowChips({ row }: { row: SessionListRow }) {
  const hr = row.avg_hr_bpm != null ? Math.round(row.avg_hr_bpm).toString() : '—';
  const coh = row.avg_coherence != null ? Math.round(row.avg_coherence).toString() : '—';
  const rmssd = row.rmssd_ms != null ? Math.round(row.rmssd_ms).toString() : '—';
  return (
    <div className="flex gap-4 shrink-0">
      <ChipNumber label="HR" value={hr} unit="bpm" />
      <ChipNumber label="RMSSD" value={rmssd} unit="ms" />
      <ChipNumber
        label="Coh"
        value={coh}
        tone={row.avg_coherence == null
          ? 'default'
          : row.avg_coherence >= 70 ? 'good'
          : row.avg_coherence >= 40 ? 'okay'
          : 'warn'}
      />
    </div>
  );
}
