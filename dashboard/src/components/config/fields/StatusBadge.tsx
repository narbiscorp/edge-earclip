import type { WriteState } from '../useDebouncedConfigWrite';

export default function StatusBadge({ status, title }: { status: WriteState | undefined; title?: string }) {
  if (!status || status === 'idle') {
    return <span className="inline-block w-3 h-3" aria-hidden />;
  }
  if (status === 'pending') {
    return (
      <span
        className="inline-block w-3 h-3 rounded-full border-2 border-slate-500 border-t-amber-300 animate-spin"
        title={title ?? 'writing…'}
        aria-label="writing"
      />
    );
  }
  if (status === 'ok') {
    return (
      <span className="inline-block w-3 h-3 text-emerald-400 leading-none text-[14px]" title={title ?? 'applied'} aria-label="applied">
        ✓
      </span>
    );
  }
  return (
    <span className="inline-block w-3 h-3 text-rose-400 leading-none text-[14px]" title={title ?? 'failed'} aria-label="failed">
      ✗
    </span>
  );
}
