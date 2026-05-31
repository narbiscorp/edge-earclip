import { useEffect, useState } from 'react';
import ConnectionPanel from './components/ConnectionPanel';
import SignalChart from './components/SignalChart';
import FilteredChart from './components/FilteredChart';
import BeatChart from './components/BeatChart';
import MetricsChart from './components/MetricsChart';
import ConfigPanel from './components/ConfigPanel';
import PresetBar from './components/PresetBar';
import RecordingControls from './components/RecordingControls';
import ReplayControls from './components/ReplayControls';
import RecoveryBanner from './components/RecoveryBanner';
import DebugPanel from './components/DebugPanel';
import BleEventLog from './components/BleEventLog';
import EdgeControls from './components/EdgeControls';
import GlassesLog from './components/GlassesLog';
import BasicMode from './components/BasicMode';
import CoherenceChart from './components/CoherenceChart';
import SessionSummaryModal from './components/SessionSummaryModal';
import SlimHeader from './components/SlimHeader';
import AuthButton from './auth/AuthButton';
import LoginModal from './auth/LoginModal';
import HistoryView from './sessions/HistoryView';
import { useAuthStore } from './auth/authStore';
import { SUPABASE_CONFIGURED } from './lib/supabase';
import { metricsRunner } from './state/metricsRunner';
import { useRecordingStore } from './state/recording';
import { useDashboardStore } from './state/store';
// Side-effect import: subscribes the pending-sync queue to window 'online'
// and auth-state events. Must be imported somewhere in the app.
import './sessions/pendingSyncQueue';

export default function App() {
  const checkForOrphans = useRecordingStore((s) => s.checkForOrphanedSessions);
  const uiMode = useDashboardStore((s) => s.uiMode);
  const setUiMode = useDashboardStore((s) => s.setUiMode);
  const showSessionSummary = useDashboardStore((s) => s.showSessionSummary);
  const endSessionAndSave = useDashboardStore((s) => s.endSessionAndSave);
  const showLogin = useAuthStore((s) => s.showLogin);

  // History view is a sibling overlay, not auth-gated — sign-in CTA lives
  // inside it so the route exists for everyone.
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    metricsRunner.start();
    void checkForOrphans();
    return () => metricsRunner.stop();
  }, [checkForOrphans]);

  return (
    <div className="h-screen flex flex-col bg-slate-950 text-slate-100 relative">
      <RecoveryBanner />
      {/* Header is mode-aware: Basic and Mobile get the cinematic SlimHeader
          (brand + device pills + cog tray + kebab menu); Expert keeps the
          original dense control panel below. */}
      {uiMode === 'expert' ? (
        <header className="flex items-center justify-between px-4 py-2 border-b border-slate-800 shrink-0 gap-3">
          <h1 className="text-lg font-semibold tracking-tight">
            Narbis Earclip Dashboard
            <span className="ml-2 text-[10px] font-mono text-emerald-400 align-middle">
              relay-v5 · {__BUILD_ID__}
            </span>
          </h1>
          {/* Basic ↔ Mobile ↔ Expert toggle. Lay users land on Basic by
              default; Mobile is Basic forced into a single-column layout
              with bigger touch targets for phone screens; Expert is the
              full charts + sidebar layout. */}
          <div className="inline-flex rounded-md border border-slate-700 overflow-hidden text-xs shrink-0">
            <button
              onClick={() => setUiMode('basic')}
              className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300"
              title="Simple view: live metrics + program picker + a few settings"
            >
              Basic
            </button>
            <button
              onClick={() => setUiMode('mobile')}
              className="px-3 py-1 border-l border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-300"
              title="Phone-optimized view: single column, larger touch targets"
            >
              Mobile
            </button>
            <button
              onClick={() => setUiMode('expert')}
              className="px-3 py-1 border-l border-slate-700 bg-indigo-600 text-white"
              title="Full charts, BLE event log, algorithm tuning, recording, presets"
            >
              Expert
            </button>
          </div>
          <button
            onClick={endSessionAndSave}
            className="px-3 py-1 rounded-lg border border-red-700/50 bg-red-900/30 hover:bg-red-800/50 text-xs font-medium text-red-300 shrink-0 transition"
            title="End session and open summary (auto-saves to cloud when signed in)"
          >
            End Session
          </button>
          {SUPABASE_CONFIGURED && (
            <button
              onClick={() => setShowHistory(true)}
              className="px-3 py-1 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 shrink-0 transition"
              title="View saved sessions and progress trends"
            >
              History
            </button>
          )}
          <AuthButton />
          <ConnectionPanel />
        </header>
      ) : (
        <SlimHeader onShowHistory={() => setShowHistory(true)} />
      )}

      {uiMode === 'basic' ? (
        <BasicMode mobile={false} />
      ) : uiMode === 'mobile' ? (
        <BasicMode mobile={true} />
      ) : (
        <>
          <main className="grid grid-cols-[1fr_360px] flex-1 overflow-hidden">
            <section className="flex flex-col gap-2 p-3 overflow-auto">
              <SignalChart />
              <FilteredChart />
              <BeatChart />
              <MetricsChart />
              <CoherenceChart />
            </section>
            <aside className="flex flex-col gap-2 p-3 border-l border-slate-800 overflow-auto">
              <EdgeControls />
              <GlassesLog />
              <ConfigPanel />
              <PresetBar />
              <BleEventLog />
            </aside>
          </main>

          <footer className="flex items-center gap-3 px-4 py-2 border-t border-slate-800 shrink-0">
            <RecordingControls />
            <ReplayControls />
            <div className="ml-auto"><DebugPanel /></div>
          </footer>
        </>
      )}
      {showSessionSummary && <SessionSummaryModal />}
      {showLogin && <LoginModal />}
      {showHistory && <HistoryView onClose={() => setShowHistory(false)} />}
    </div>
  );
}
