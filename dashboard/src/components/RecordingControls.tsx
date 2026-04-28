import { useEffect, useRef, useState } from 'react';
import { useRecordingStore } from '../state/recording';
import type { RecordingMeta } from '../recording/types';
import RecordingSummary from './RecordingSummary';

const DEFAULT_META: RecordingMeta = {
  name: '',
  subjectId: '',
  notes: '',
  streams: { raw: true, beats: true, sqi: true, filtered: true, polar: true, metrics: true },
};

export default function RecordingControls() {
  const phase = useRecordingStore((s) => s.phase);
  const startedAt = useRecordingStore((s) => s.startedAt);
  const counts = useRecordingStore((s) => s.counts);
  const byteEstimate = useRecordingStore((s) => s.byteEstimate);
  const lastError = useRecordingStore((s) => s.lastError);
  const openPreRecording = useRecordingStore((s) => s.openPreRecording);
  const cancelPreRecording = useRecordingStore((s) => s.cancelPreRecording);
  const startRecording = useRecordingStore((s) => s.startRecording);
  const stopRecording = useRecordingStore((s) => s.stopRecording);
  const abortRecording = useRecordingStore((s) => s.abortRecording);
  const addAnnotation = useRecordingStore((s) => s.addAnnotation);

  return (
    <div className="flex items-center gap-2">
      {phase === 'IDLE' && (
        <button
          type="button"
          onClick={openPreRecording}
          className="text-xs px-3 py-1 rounded bg-rose-700 hover:bg-rose-600 text-white"
        >
          ● Record
        </button>
      )}
      {phase === 'PRE_RECORDING' && (
        <PreRecordingModal
          onCancel={cancelPreRecording}
          onStart={(meta) => void startRecording(meta)}
        />
      )}
      {phase === 'RECORDING' && (
        <RecordingHud
          startedAt={startedAt}
          counts={counts}
          byteEstimate={byteEstimate}
          onStop={() => void stopRecording()}
          onAbort={() => void abortRecording()}
          onAnnotate={addAnnotation}
        />
      )}
      {phase === 'FINALIZING' && (
        <span className="text-xs text-slate-300">Building session zip…</span>
      )}
      {phase === 'COMPLETE' && <RecordingSummary />}
      {lastError && phase !== 'COMPLETE' ? (
        <span className="text-xs text-rose-400" title={lastError}>
          {lastError.length > 60 ? lastError.slice(0, 60) + '…' : lastError}
        </span>
      ) : null}
    </div>
  );
}

interface PreRecordingProps {
  onCancel: () => void;
  onStart: (meta: RecordingMeta) => void;
}

function PreRecordingModal({ onCancel, onStart }: PreRecordingProps) {
  const [meta, setMeta] = useState<RecordingMeta>(DEFAULT_META);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[420px] rounded border border-slate-700 bg-slate-900 p-4 text-slate-100">
        <h2 className="text-sm font-semibold mb-3">New recording</h2>
        <div className="flex flex-col gap-2">
          <label className="text-xs text-slate-400">
            Session name
            <input
              type="text"
              value={meta.name}
              onChange={(e) => setMeta((m) => ({ ...m, name: e.target.value }))}
              className="mt-0.5 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
              placeholder="Untitled session"
              autoFocus
            />
          </label>
          <label className="text-xs text-slate-400">
            Subject ID
            <input
              type="text"
              value={meta.subjectId}
              onChange={(e) => setMeta((m) => ({ ...m, subjectId: e.target.value }))}
              className="mt-0.5 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
              placeholder="(optional)"
            />
          </label>
          <label className="text-xs text-slate-400">
            Notes
            <textarea
              value={meta.notes}
              onChange={(e) => setMeta((m) => ({ ...m, notes: e.target.value }))}
              className="mt-0.5 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
              rows={2}
            />
          </label>
          <div className="text-xs text-slate-400 mt-1">Streams</div>
          <div className="grid grid-cols-2 gap-1 text-xs">
            {(['raw', 'beats', 'sqi', 'filtered', 'polar', 'metrics'] as const).map((k) => (
              <label key={k} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={meta.streams[k]}
                  onChange={(e) =>
                    setMeta((m) => ({
                      ...m,
                      streams: { ...m.streams, [k]: e.target.checked },
                    }))
                  }
                />
                {k}
              </label>
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button
            type="button"
            onClick={onCancel}
            className="text-xs px-3 py-1 rounded bg-slate-700 hover:bg-slate-600"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onStart(meta)}
            className="text-xs px-3 py-1 rounded bg-rose-700 hover:bg-rose-600"
          >
            Start
          </button>
        </div>
      </div>
    </div>
  );
}

interface HudProps {
  startedAt: number | null;
  counts: ReturnType<typeof useRecordingStore.getState>['counts'];
  byteEstimate: number;
  onStop: () => void;
  onAbort: () => void;
  onAnnotate: (text: string, eventType?: 'mark' | 'text') => void;
}

function RecordingHud({ startedAt, counts, byteEstimate, onStop, onAbort, onAnnotate }: HudProps) {
  const [now, setNow] = useState(Date.now());
  const annotationRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const elapsedMs = startedAt ? Math.max(0, now - startedAt) : 0;

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="inline-flex items-center gap-1.5 text-rose-400">
        <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse" />
        REC
      </span>
      <span className="font-mono text-slate-200">{formatElapsed(elapsedMs)}</span>
      <span className="text-slate-500">|</span>
      <span className="text-slate-400" title="raw / beats / annotations">
        {counts.raw}r {counts.beats}b {counts.annotations}a
      </span>
      <span className="text-slate-500" title="estimated bytes">
        ~{formatBytes(byteEstimate)}
      </span>
      <input
        ref={annotationRef}
        type="text"
        placeholder="annotation… (Enter)"
        className="w-44 rounded border border-slate-700 bg-slate-950 px-2 py-0.5 text-xs"
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const v = (e.target as HTMLInputElement).value.trim();
            if (v) {
              onAnnotate(v, 'text');
              (e.target as HTMLInputElement).value = '';
            }
          }
        }}
      />
      <button
        type="button"
        onClick={() => onAnnotate('mark', 'mark')}
        className="px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600"
      >
        Mark
      </button>
      <button
        type="button"
        onClick={onStop}
        className="px-2 py-0.5 rounded bg-rose-700 hover:bg-rose-600 text-white"
      >
        Stop
      </button>
      <button
        type="button"
        onClick={onAbort}
        className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
        title="Abort and discard chunks"
      >
        Abort
      </button>
    </div>
  );
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

function pad(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}
