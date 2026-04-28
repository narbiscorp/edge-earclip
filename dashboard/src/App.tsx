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
import DebugPanel from './components/DebugPanel';
import { metricsRunner } from './state/metricsRunner';

export default function App() {
  useEffect(() => {
    metricsRunner.start();
    return () => metricsRunner.stop();
  }, []);

  return (
    <div className="h-screen flex flex-col bg-slate-950 text-slate-100">
      <header className="flex items-center justify-between px-4 py-2 border-b border-slate-800 shrink-0">
        <h1 className="text-lg font-semibold tracking-tight">
          Narbis Earclip Dashboard
        </h1>
        <ConnectionPanel />
      </header>

      <main className="grid grid-cols-[1fr_360px] flex-1 overflow-hidden">
        <section className="flex flex-col gap-2 p-3 overflow-auto">
          <SignalChart />
          <FilteredChart />
          <BeatChart />
          <MetricsChart />
        </section>
        <aside className="flex flex-col gap-2 p-3 border-l border-slate-800 overflow-auto">
          <ConfigPanel />
          <PresetBar />
        </aside>
      </main>

      <footer className="flex items-center gap-3 px-4 py-2 border-t border-slate-800 shrink-0">
        <RecordingControls />
        <ReplayControls />
        <div className="ml-auto"><DebugPanel /></div>
      </footer>
    </div>
  );
}
