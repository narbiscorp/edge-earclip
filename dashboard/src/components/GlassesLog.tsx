import { useState } from 'react';
import { useDashboardStore, type BleLogEntry } from '../state/store';

/* GlassesLog
 *
 * Shows the last 10 log lines emitted by the Edge glasses firmware (0xF1
 * frames, source === 'edge'). Includes copy buttons for the tail and the
 * full edge log. Extracted from the former PairingAssistant component.
 */
export default function GlassesLog() {
  const log = useDashboardStore((s) => s.bleLog);
  const edgeTail = log.filter((e) => e.source === 'edge').slice(-10);

  return (
    <div className="rounded bg-slate-900/70 border border-slate-700 p-3 text-xs">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-slate-200 font-medium">Glasses log</span>
        <span className="text-slate-500 text-[10px]">last 10 events</span>
        <div className="flex-1" />
        <CopyButton entries={edgeTail} label="copy" />
        <button
          className="rounded bg-slate-700 hover:bg-slate-600 px-1.5 py-0.5 text-[10px] disabled:opacity-50"
          disabled={log.length === 0}
          onClick={() => copyEdgeAll(log)}
          title="Copy ALL edge log lines (not just last 10)"
        >
          copy all edge
        </button>
      </div>
      {edgeTail.length === 0 ? (
        <div className="text-slate-500 italic text-[11px]">
          no glasses log frames yet — connect the glasses in the header
        </div>
      ) : (
        <div className="font-mono text-[10px] leading-snug space-y-0.5 max-h-40 overflow-y-auto">
          {edgeTail.map((e) => (
            <div key={e.id} className="text-slate-300 break-all">
              <span className="text-slate-500">{formatTimeShort(e.timestamp)} </span>
              {e.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatTimeShort(t: number): string {
  const d = new Date(t);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  const ss = d.getSeconds().toString().padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function entriesToText(entries: BleLogEntry[]): string {
  return entries
    .map((e) => `${formatTimeShort(e.timestamp)}  ${e.source.padEnd(7)} ${e.message}`)
    .join('\n');
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
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

function copyEdgeAll(allEntries: BleLogEntry[]): void {
  const edge = allEntries.filter((e) => e.source === 'edge');
  void copyText(entriesToText(edge));
}

function CopyButton({ entries, label }: { entries: BleLogEntry[]; label: string }) {
  const [flash, setFlash] = useState('');
  return (
    <button
      className="rounded bg-emerald-700 hover:bg-emerald-600 px-1.5 py-0.5 text-[10px] disabled:opacity-50"
      disabled={entries.length === 0}
      onClick={async () => {
        const ok = await copyText(entriesToText(entries));
        setFlash(ok ? `✓ ${entries.length}` : 'fail');
        setTimeout(() => setFlash(''), 1500);
      }}
    >
      {flash || label}
    </button>
  );
}
