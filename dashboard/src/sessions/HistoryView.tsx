// History panel — sessions list + trends tab. Rendered as a full-screen
// overlay when the user toggles "History" in the header.

import { useState } from 'react';
import { useAuthStore } from '../auth/authStore';
import { SUPABASE_CONFIGURED } from '../lib/supabase';
import SessionList from './SessionList';
import TrendsView from './TrendsView';

type Tab = 'sessions' | 'trends';

export default function HistoryView({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('sessions');
  const authStatus = useAuthStore((s) => s.status);
  const setShowLogin = useAuthStore((s) => s.setShowLogin);

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-slate-950">
      <header className="flex items-center gap-3 px-4 py-2 border-b border-slate-800 shrink-0">
        <h1 className="text-lg font-semibold tracking-tight text-slate-100">History</h1>
        <div className="inline-flex rounded-md border border-slate-700 overflow-hidden text-xs ml-2">
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
        <button
          onClick={onClose}
          className="ml-auto px-3 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 shrink-0 transition"
        >
          Back to Live
        </button>
      </header>

      <main className="flex-1 overflow-auto p-4">
        {!SUPABASE_CONFIGURED ? (
          <div className="p-8 text-center text-slate-500 text-sm">
            Cloud save is not configured for this deployment.
          </div>
        ) : authStatus !== 'signed_in' ? (
          <div className="p-8 text-center text-slate-400 text-sm space-y-3">
            <div>Sign in to view your session history and progress trends.</div>
            <button
              onClick={() => setShowLogin(true)}
              className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-sm font-medium text-white transition"
            >
              Sign in
            </button>
          </div>
        ) : tab === 'sessions' ? (
          <SessionList />
        ) : (
          <TrendsView />
        )}
      </main>
    </div>
  );
}
