import { useRef } from 'react';
import { useReplayStore, type ReplaySpeed } from '../state/replayStore';
import { useDashboardStore } from '../state/store';

export default function ReplayControls() {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const loaded = useReplayStore((s) => s.loaded);
  const isPlaying = useReplayStore((s) => s.isPlaying);
  const position_ms = useReplayStore((s) => s.position_ms);
  const duration_ms = useReplayStore((s) => s.duration_ms);
  const speed = useReplayStore((s) => s.speed);
  const recomputeWindowSec = useReplayStore((s) => s.recomputeWindowSec);
  const recomputing = useReplayStore((s) => s.recomputing);
  const lastError = useReplayStore((s) => s.lastError);
  const loadFile = useReplayStore((s) => s.loadFile);
  const unload = useReplayStore((s) => s.unload);
  const play = useReplayStore((s) => s.play);
  const pause = useReplayStore((s) => s.pause);
  const seek = useReplayStore((s) => s.seek);
  const setSpeed = useReplayStore((s) => s.setSpeed);
  const setRecomputeWindow = useReplayStore((s) => s.setRecomputeWindow);
  const runRecompute = useReplayStore((s) => s.runRecompute);
  const dataSource = useDashboardStore((s) => s.dataSource);
  const setDataSource = useDashboardStore((s) => s.setDataSource);

  const onPickFile = () => fileRef.current?.click();
  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) void loadFile(f);
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <div className="flex items-center gap-2 text-xs">
      <input
        ref={fileRef}
        type="file"
        accept=".zip,.json"
        onChange={onFileChange}
        className="hidden"
      />
      {!loaded ? (
        <button
          type="button"
          onClick={onPickFile}
          className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600"
        >
          Load replay
        </button>
      ) : (
        <>
          <button
            type="button"
            onClick={isPlaying ? pause : play}
            className="px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600"
          >
            {isPlaying ? 'Pause' : 'Play'}
          </button>
          <input
            type="range"
            min={0}
            max={duration_ms}
            step={100}
            value={position_ms}
            onChange={(e) => seek(Number(e.target.value))}
            className="w-40"
            aria-label="scrub"
          />
          <span className="font-mono text-slate-300 tabular-nums">
            {formatTime(position_ms)} / {formatTime(duration_ms)}
          </span>
          <select
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value) as ReplaySpeed)}
            className="bg-slate-900 border border-slate-700 rounded px-1 py-0.5"
            aria-label="speed"
          >
            <option value={1}>1×</option>
            <option value={2}>2×</option>
            <option value={5}>5×</option>
            <option value={10}>10×</option>
          </select>
          <span className="text-slate-500">|</span>
          <span className="text-slate-400">window</span>
          <select
            value={recomputeWindowSec}
            onChange={(e) => setRecomputeWindow(Number(e.target.value))}
            className="bg-slate-900 border border-slate-700 rounded px-1 py-0.5"
          >
            <option value={30}>30s</option>
            <option value={60}>60s</option>
            <option value={120}>120s</option>
            <option value={300}>300s</option>
          </select>
          <button
            type="button"
            disabled={recomputing}
            onClick={() => void runRecompute()}
            className="px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-50"
          >
            {recomputing ? 'Computing…' : 'Recompute metrics'}
          </button>
          <span className="text-slate-500">|</span>
          <button
            type="button"
            onClick={() => setDataSource(dataSource === 'replay' ? 'live' : 'replay')}
            className={`px-2 py-0.5 rounded ${dataSource === 'replay' ? 'bg-amber-700 hover:bg-amber-600' : 'bg-slate-700 hover:bg-slate-600'}`}
            title="Switch chart source"
          >
            {dataSource === 'replay' ? 'Source: replay' : 'Source: live'}
          </button>
          <button
            type="button"
            onClick={unload}
            className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700"
          >
            Unload
          </button>
        </>
      )}
      {lastError ? (
        <span className="text-rose-400" title={lastError}>
          {lastError.length > 60 ? lastError.slice(0, 60) + '…' : lastError}
        </span>
      ) : null}
    </div>
  );
}

function formatTime(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s < 10 ? '0' + s : s}`;
}
