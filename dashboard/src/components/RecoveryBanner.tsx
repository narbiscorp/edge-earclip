import { useRecordingStore } from '../state/recording';

export default function RecoveryBanner() {
  const pending = useRecordingStore((s) => s.pendingRecovery);
  const recover = useRecordingStore((s) => s.recoverSession);
  const discard = useRecordingStore((s) => s.discardSession);

  if (!pending) return null;

  const onFinalize = () => void recover(pending.sessionId);
  const onDiscard = () => void discard(pending.sessionId);

  return (
    <div className="px-4 py-2 bg-amber-900/40 border-b border-amber-800 text-amber-100 text-xs flex items-center gap-3">
      <span className="font-semibold">Unfinished session detected</span>
      <span className="text-amber-200">
        {pending.name || 'Untitled'} — started {new Date(pending.startedAt).toLocaleString()} (
        {pending.chunkCount} chunks)
      </span>
      <span className="ml-auto" />
      <button
        type="button"
        onClick={onFinalize}
        className="px-2 py-0.5 rounded bg-emerald-700 hover:bg-emerald-600 text-white"
      >
        Finalize
      </button>
      <button
        type="button"
        onClick={onDiscard}
        className="px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600"
      >
        Discard
      </button>
    </div>
  );
}
