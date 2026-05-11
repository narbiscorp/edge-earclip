import { useEffect, useRef, useState } from 'react';
import { useDashboardStore, type BleLogEntry, type BleLogSource, type BleLogLevel } from '../state/store';

const sourceColor: Record<BleLogSource, string> = {
  earclip: 'text-cyan-300',
  edge:    'text-fuchsia-300',
  polar:   'text-pink-300',
  system:  'text-slate-400',
};

const levelColor: Record<BleLogLevel, string> = {
  info:  'text-slate-200',
  warn:  'text-amber-300',
  error: 'text-rose-400',
  rx:    'text-emerald-300',
  tx:    'text-indigo-300',
};

const levelTag: Record<BleLogLevel, string> = {
  info:  'INFO',
  warn:  'WARN',
  error: 'ERR ',
  rx:    'RX  ',
  tx:    'TX  ',
};

function formatTime(t: number): string {
  const d = new Date(t);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  const ss = d.getSeconds().toString().padStart(2, '0');
  const ms = d.getMilliseconds().toString().padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function entriesToText(entries: BleLogEntry[]): string {
  return entries
    .map((e) => `${formatTime(e.timestamp)}  ${e.source.padEnd(7)} ${levelTag[e.level]}  ${e.message}`)
    .join('\n');
}

async function copyEntries(entries: BleLogEntry[]): Promise<boolean> {
  const text = entriesToText(entries);
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  // Fallback: temporary textarea + execCommand for legacy / non-secure contexts.
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function downloadEntries(entries: BleLogEntry[]): void {
  const text = entriesToText(entries);
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = url;
  a.download = `narbis-ble-log-${ts}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function BleEventLog() {
  const log = useDashboardStore((s) => s.bleLog);
  const clearBleLog = useDashboardStore((s) => s.clearBleLog);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState<BleLogSource | 'all'>('all');
  const [copyFlash, setCopyFlash] = useState<string>('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasAtBottom = useRef(true);

  // Auto-scroll to bottom only when the user was already there (prevents
  // yanking them away if they scrolled up to read history).
  useEffect(() => {
    if (paused) return;
    const el = scrollRef.current;
    if (!el) return;
    if (wasAtBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [log, paused]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    wasAtBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  const visible = filter === 'all' ? log : log.filter((e) => e.source === filter);

  return (
    <div className="rounded bg-slate-900/70 border border-slate-700 flex flex-col text-[11px]">
      <div className="flex items-center gap-2 px-2 py-1 border-b border-slate-700">
        <span className="text-slate-300 font-medium">BLE event log</span>
        <span className="text-slate-500">{visible.length} / {log.length}</span>
        <div className="flex-1" />
        <FilterChip current={filter} value="all"     label="all"     onSelect={setFilter} />
        <FilterChip current={filter} value="earclip" label="earclip" onSelect={setFilter} />
        <FilterChip current={filter} value="edge"    label="edge"    onSelect={setFilter} />
        <FilterChip current={filter} value="polar"   label="polar"   onSelect={setFilter} />
        <FilterChip current={filter} value="system"  label="system"  onSelect={setFilter} />
        <button
          className="rounded bg-slate-700 hover:bg-slate-600 px-2 py-0.5"
          onClick={() => setPaused((p) => !p)}
          title={paused ? 'resume autoscroll' : 'pause autoscroll'}
        >
          {paused ? 'resume' : 'pause'}
        </button>
        <button
          className="rounded bg-emerald-700 hover:bg-emerald-600 px-2 py-0.5 disabled:opacity-50"
          disabled={visible.length === 0}
          onClick={async () => {
            const ok = await copyEntries(visible);
            setCopyFlash(ok ? `copied ${visible.length}` : 'copy failed');
            setTimeout(() => setCopyFlash(''), 1500);
          }}
          title="Copy visible entries (matching current filter) to clipboard"
        >
          {copyFlash || 'copy'}
        </button>
        <button
          className="rounded bg-slate-700 hover:bg-slate-600 px-2 py-0.5 disabled:opacity-50"
          disabled={visible.length === 0}
          onClick={() => downloadEntries(visible)}
          title="Download visible entries as a .txt file"
        >
          download
        </button>
        <button
          className="rounded bg-slate-700 hover:bg-slate-600 px-2 py-0.5"
          onClick={() => clearBleLog()}
        >
          clear
        </button>
      </div>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="font-mono px-2 py-1 overflow-y-auto h-48 leading-tight"
      >
        {visible.length === 0 ? (
          <div className="text-slate-500 italic">no events yet — connect a device to see traffic</div>
        ) : (
          visible.map((e) => <Row key={e.id} entry={e} />)
        )}
      </div>
    </div>
  );
}

function Row({ entry }: { entry: BleLogEntry }) {
  return (
    <div className="flex gap-2 whitespace-pre">
      <span className="text-slate-500 shrink-0">{formatTime(entry.timestamp)}</span>
      <span className={`shrink-0 ${sourceColor[entry.source]}`}>
        {entry.source.padEnd(7)}
      </span>
      <span className={`shrink-0 ${levelColor[entry.level]}`}>{levelTag[entry.level]}</span>
      <span className={`${levelColor[entry.level]} break-all`}>{entry.message}</span>
    </div>
  );
}

function FilterChip({
  current, value, label, onSelect,
}: {
  current: BleLogSource | 'all';
  value: BleLogSource | 'all';
  label: string;
  onSelect: (v: BleLogSource | 'all') => void;
}) {
  const on = current === value;
  return (
    <button
      onClick={() => onSelect(value)}
      className={
        'rounded px-2 py-0.5 ' +
        (on ? 'bg-slate-200 text-slate-900' : 'bg-slate-700 hover:bg-slate-600')
      }
    >
      {label}
    </button>
  );
}
