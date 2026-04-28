import { useRecordingStore } from '../state/recording';
import { useReplayStore } from '../state/replayStore';
import { saveBlobWithPicker } from '../recording/export';

export default function RecordingSummary() {
  const summary = useRecordingStore((s) => s.finalSummary);
  const blob = useRecordingStore((s) => s.finalBlob);
  const filename = useRecordingStore((s) => s.finalFilename);
  const sessionId = useRecordingStore((s) => s.sessionId);
  const resetToIdle = useRecordingStore((s) => s.resetToIdle);
  const discardSession = useRecordingStore((s) => s.discardSession);
  const loadBlob = useReplayStore((s) => s.loadBlob);

  if (!summary) {
    return (
      <span className="text-xs text-slate-400">recording complete (no summary)</span>
    );
  }

  const onDownload = async () => {
    if (!blob || !filename) return;
    await saveBlobWithPicker(blob, filename);
  };

  const onOpenInReplay = async () => {
    if (!blob || !filename) return;
    await loadBlob(blob, filename);
  };

  const onDiscard = async () => {
    if (!sessionId) {
      resetToIdle();
      return;
    }
    await discardSession(sessionId);
    resetToIdle();
  };

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-emerald-400">✓ session ready</span>
      <span className="text-slate-300">
        {formatDuration(summary.durationMs)} · {summary.totalBeats} beats ·{' '}
        {summary.meanHrBpm !== null ? `${summary.meanHrBpm.toFixed(0)} bpm` : '—'} ·{' '}
        {(summary.artifactRatio * 100).toFixed(1)}% artifact
      </span>
      <span className="text-slate-500">{formatBytes(summary.filesBytes)}</span>
      <button
        type="button"
        onClick={() => void onDownload()}
        className="px-2 py-0.5 rounded bg-emerald-700 hover:bg-emerald-600 text-white"
      >
        Download
      </button>
      <button
        type="button"
        onClick={() => void onOpenInReplay()}
        className="px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600"
      >
        Replay
      </button>
      <button
        type="button"
        onClick={() => void onDiscard()}
        className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
        title="Delete session from IndexedDB"
      >
        Discard
      </button>
      <button
        type="button"
        onClick={resetToIdle}
        className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
      >
        Close
      </button>
    </div>
  );
}

function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}
