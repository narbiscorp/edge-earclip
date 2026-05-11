import { useEffect } from 'react';
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
import PairingAssistant from './components/PairingAssistant';
import EdgeControls from './components/EdgeControls';
import BasicMode from './components/BasicMode';
import { metricsRunner } from './state/metricsRunner';
import { useRecordingStore } from './state/recording';
import { useDashboardStore } from './state/store';

export default function App() {
  const checkForOrphans = useRecordingStore((s) => s.checkForOrphanedSessions);
  const uiMode = useDashboardStore((s) => s.uiMode);
  const setUiMode = useDashboardStore((s) => s.setUiMode);

  useEffect(() => {
    metricsRunner.start();
    void checkForOrphans();
    return () => metricsRunner.stop();
  }, [checkForOrphans]);

  return (
    <div className="h-screen flex flex-col bg-slate-950 text-slate-100">
      <RecoveryBanner />
      <header className="flex items-center justify-between px-4 py-2 border-b border-slate-800 shrink-0 gap-3">
        <h1 className="text-lg font-semibold tracking-tight">
          Narbis Earclip Dashboard
          {uiMode === 'expert' && (
            <span className="ml-2 text-[10px] font-mono text-emerald-400 align-middle">
              relay-v5 · {__BUILD_ID__}
            </span>
          )}
        </h1>
        {/* Basic ↔ Expert toggle. Lay users land on Basic by default;
            developers / tuners flip to Expert for the full charts + sidebar. */}
        <div className="inline-flex rounded-md border border-slate-700 overflow-hidden text-xs shrink-0">
          <button
            onClick={() => setUiMode('basic')}
            className={
              'px-3 py-1 ' +
              (uiMode === 'basic'
                ? 'bg-indigo-600 text-white'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-300')
            }
            title="Simple view: live metrics + program picker + a few settings"
          >
            Basic
          </button>
          <button
            onClick={() => setUiMode('expert')}
            className={
              'px-3 py-1 border-l border-slate-700 ' +
              (uiMode === 'expert'
                ? 'bg-indigo-600 text-white'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-300')
            }
            title="Full charts, BLE event log, algorithm tuning, recording, presets"
          >
            Expert
          </button>
        </div>
        <ConnectionPanel />
      </header>

      {uiMode === 'basic' ? (
        <BasicMode />
      ) : (
        <>
          <main className="grid grid-cols-[1fr_360px] flex-1 overflow-hidden">
            <section className="flex flex-col gap-2 p-3 overflow-auto">
              <SignalChart />
              <FilteredChart />
              <BeatChart />
              <MetricsChart />
            </section>
            <aside className="flex flex-col gap-2 p-3 border-l border-slate-800 overflow-auto">
              <PairingAssistant />
              <EdgeControls />
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
    </div>
  );
}
