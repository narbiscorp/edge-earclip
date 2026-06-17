// Clinician portal — full-screen overlay (same scaffolding as
// sessions/HistoryView). Two tabs: Clients (roster + per-client history) and
// Overview (all-clients aggregate trends). Auth-gated like History.

import { useState } from 'react';
import { useAuthStore } from '../auth/authStore';
import { SUPABASE_CONFIGURED } from '../lib/supabase';
import ClientsPane from './ClientsPane';
import ClinicianOverview from './ClinicianOverview';

type Tab = 'clients' | 'overview';

export default function ClinicianPortal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('clients');
  const authStatus = useAuthStore((s) => s.status);
  const setShowLogin = useAuthStore((s) => s.setShowLogin);

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-slate-950">
      <header className="flex items-center gap-3 px-4 py-2 border-b border-slate-800 shrink-0">
        <h1 className="text-lg font-semibold tracking-tight text-slate-100">Clinician portal</h1>
        <div className="inline-flex rounded-md border border-slate-700 overflow-hidden text-xs ml-2">
          <button
            onClick={() => setTab('clients')}
            className={'px-3 py-1 ' + (tab === 'clients' ? 'bg-indigo-600 text-white' : 'bg-slate-800 hover:bg-slate-700 text-slate-300')}
          >
            Clients
          </button>
          <button
            onClick={() => setTab('overview')}
            className={'px-3 py-1 border-l border-slate-700 ' + (tab === 'overview' ? 'bg-indigo-600 text-white' : 'bg-slate-800 hover:bg-slate-700 text-slate-300')}
          >
            Overview
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
            Cloud save is not configured for this deployment — the clinician portal needs Supabase.
          </div>
        ) : authStatus !== 'signed_in' ? (
          <div className="p-8 text-center text-slate-400 text-sm space-y-3">
            <div>Sign in to manage client profiles and review their progress.</div>
            <button
              onClick={() => setShowLogin(true)}
              className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-sm font-medium text-white transition"
            >
              Sign in
            </button>
          </div>
        ) : tab === 'clients' ? (
          <ClientsPane />
        ) : (
          <ClinicianOverview />
        )}
      </main>
    </div>
  );
}
