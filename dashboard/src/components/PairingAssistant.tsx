import { useEffect, useState } from 'react';
import { useDashboardStore, type BleLogEntry } from '../state/store';

/* PairingAssistant
 *
 * Walks the user through pairing the earclip with the Edge glasses via
 * the dashboard. The actual pairing happens between earclip and glasses
 * directly over BLE (auto-discover strongest RSSI on the glasses side);
 * this UI just kicks it off (writes 0xC1 to the glasses CTRL char) and
 * shows a 30-second countdown plus the relevant log tail.
 */
export default function PairingAssistant() {
  const narbis = useDashboardStore((s) => s.connection.narbis);
  const edge   = useDashboardStore((s) => s.connection.edge);
  const log    = useDashboardStore((s) => s.bleLog);
  const repair = useDashboardStore((s) => s.edgeForgetEarclip);

  // Scan-progress state. We can't observe the glasses' scan state directly,
  // so we run a 30s countdown after the user clicks Re-pair as a hint.
  // The countdown ends early when we see a "central: ready" or "earclip up:"
  // log line from the glasses (success), or extends slightly on retry
  // attempts (failure).
  const [scanStartAt, setScanStartAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  // Pairing outcome banner: 'idle' | 'scanning' | 'paired' | 'timeout' | 'lost'
  // 'paired'  = saw central: ready / earclip up: after scanStartAt
  // 'timeout' = 30s elapsed with no success line
  // 'lost'    = was paired, then saw central: disconnected
  type PairOutcome = 'idle' | 'scanning' | 'paired' | 'timeout' | 'lost';
  const [outcome, setOutcome] = useState<PairOutcome>('idle');
  const [pairedDetail, setPairedDetail] = useState<string>('');

  useEffect(() => {
    if (scanStartAt === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    const stop = window.setTimeout(() => {
      // Only flip to timeout if we haven't already flipped to 'paired'.
      setOutcome((prev) => prev === 'scanning' ? 'timeout' : prev);
      setScanStartAt(null);
    }, 30_000);
    return () => { window.clearInterval(id); window.clearTimeout(stop); };
  }, [scanStartAt]);

  // Watch the edge log for central lifecycle messages and update outcome.
  useEffect(() => {
    if (log.length === 0) return;
    // Look at recent edge entries. We process newest-first so the latest
    // event wins (e.g., a disconnect after a brief connect → 'lost').
    for (let i = log.length - 1; i >= 0; i--) {
      const e = log[i];
      if (e.source !== 'edge' || e.level !== 'rx') continue;
      const m = e.message;
      // Success markers fired after the rescan started count as a fresh pair.
      const isReady = /central: ready/.test(m) || /earclip up:/.test(m);
      const isLost  = /central: disconnected/.test(m) || /earclip down:/.test(m);
      const isConn  = /central: connected,/.test(m);

      // Only consider events that arrived after we triggered the scan
      // (so we don't auto-mark "paired" from old log lines on mount).
      if (scanStartAt !== null && e.timestamp >= scanStartAt) {
        if (isReady) {
          setOutcome('paired');
          setPairedDetail(extractEarclipFromLog(log) ?? 'earclip connected');
          setScanStartAt(null);  // success — stop the countdown
          return;
        }
        if (isLost) {
          setOutcome('lost');
          setScanStartAt(null);
          return;
        }
        if (isConn) {
          // GAP-level connect happened; keep scanning state until ready
          // arrives (which writes peer-role + subscribes IBI).
        }
      } else if (scanStartAt === null && outcome === 'paired' && isLost) {
        // Drop after a previous successful pair.
        setOutcome('lost');
        return;
      }
      break;  // only need to inspect the newest matching entry
    }
  }, [log, scanStartAt, outcome]);

  const elapsedMs   = scanStartAt !== null ? now - scanStartAt : 0;
  const scanFracPct = Math.min(100, (elapsedMs / 30_000) * 100);
  const scanRemainS = scanStartAt !== null ? Math.max(0, 30 - Math.floor(elapsedMs / 1000)) : 0;

  // Filter the log to only "edge" source lines, last 10. That's where
  // the glasses' firmware logs land (0xF1 frames).
  const edgeTail = log.filter((e) => e.source === 'edge').slice(-10);

  const earclipReady = narbis.state === 'connected';
  const edgeReady    = edge.state === 'connected';
  const canRepair    = earclipReady && edgeReady && scanStartAt === null;

  const onRepair = async () => {
    if (!confirm(
      'This tells the glasses to drop their currently paired earclip and ' +
      'rescan for a new one. They will pick the closest powered-on Narbis ' +
      'Earclip (highest RSSI). Make sure the earclip you want is powered ' +
      'on and near the glasses. Continue?',
    )) return;
    setScanStartAt(Date.now());
    setOutcome('scanning');
    setPairedDetail('');
    try {
      await repair();
    } catch (err) {
      console.error('repair failed', err);
    }
  };

  return (
    <div className="rounded bg-slate-900/70 border border-slate-700 p-3 text-xs">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-slate-200 font-medium">Pairing Assistant</span>
        <span className="text-slate-500 text-[10px]">earclip ↔ glasses</span>
      </div>

      <ol className="space-y-1.5">
        <Step
          n={1}
          title="Connect dashboard to earclip"
          done={earclipReady}
          hint={earclipReady ? `connected: ${narbis.deviceName}` : 'use Connect Earclip in the header'}
        />
        <Step
          n={2}
          title="Connect dashboard to glasses"
          done={edgeReady}
          hint={edgeReady ? `connected: ${edge.deviceName}` : 'use Connect Glasses in the header'}
        />
        <Step
          n={3}
          title="Send re-pair command (0xC1) to glasses"
          done={false}
          hint={
            !canRepair
              ? scanStartAt !== null
                ? 'rescan in flight…'
                : 'connect both above, then click below'
              : 'glasses will scan up to 30 s and pick highest-RSSI earclip'
          }
          action={
            <button
              className="rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 px-2 py-1 text-xs font-medium"
              disabled={!canRepair}
              onClick={onRepair}
            >
              Pair earclip with glasses
            </button>
          }
        />
      </ol>

      {scanStartAt !== null && (
        <div className="mt-3">
          <div className="flex items-baseline justify-between mb-1">
            <span className="text-slate-300">Glasses scanning…</span>
            <span className="text-slate-400 text-[10px] tabular-nums">{scanRemainS} s remaining</span>
          </div>
          <div className="h-1 rounded bg-slate-800 overflow-hidden">
            <div
              className="h-full bg-indigo-500 transition-[width] duration-200"
              style={{ width: `${scanFracPct}%` }}
            />
          </div>
          <p className="mt-1 text-[10px] text-slate-500">
            Watch the log below for <code>central:</code> lines from the glasses
            firmware. A successful pair shows <code>central: connected</code>
            followed by <code>central: ready</code>. If the earclip isn't
            advertising or is out of range, you'll see the scan retry
            indefinitely until you hit the magnet 5 times.
          </p>
        </div>
      )}

      {/* Outcome banner — explicit visual confirmation. Stays visible
          until the next rescan attempt clears it. Click to dismiss. */}
      {scanStartAt === null && outcome !== 'idle' && outcome !== 'scanning' && (
        <button
          onClick={() => { setOutcome('idle'); setPairedDetail(''); }}
          className={
            'mt-3 w-full text-left rounded p-2 border text-[11px] ' +
            (outcome === 'paired'
              ? 'bg-emerald-900/40 border-emerald-700 text-emerald-200'
              : outcome === 'timeout'
                ? 'bg-amber-900/40 border-amber-700 text-amber-200'
                : 'bg-rose-900/40 border-rose-700 text-rose-200')
          }
          title="click to dismiss"
        >
          {outcome === 'paired' && (
            <>
              <div className="font-medium">✓ Paired successfully</div>
              <div className="text-[10px] opacity-80 mt-0.5">{pairedDetail}</div>
              <div className="text-[10px] opacity-70 mt-1">
                Glasses are now subscribed to the earclip's IBI stream.
                Internal ADC has been disabled and Program 1 (heartbeat)
                is active.
              </div>
            </>
          )}
          {outcome === 'timeout' && (
            <>
              <div className="font-medium">⚠ Pairing timed out (30 s)</div>
              <div className="text-[10px] opacity-80 mt-1">
                The glasses were rescanning but didn't lock onto an earclip
                within 30 seconds. The scan may still be retrying in the
                background — check the log below for <code>central: scanning attempt N</code>
                lines. Move the earclip closer (≤ 1 m) and try again.
              </div>
            </>
          )}
          {outcome === 'lost' && (
            <>
              <div className="font-medium">✕ Earclip dropped</div>
              <div className="text-[10px] opacity-80 mt-1">
                The glasses lost their connection to the earclip. They will
                automatically retry — check the log below for the retry
                cadence.
              </div>
            </>
          )}
        </button>
      )}

      <div className="mt-3">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-slate-300">Glasses log (last 10 events)</span>
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

      <div className="mt-3 text-[10px] text-slate-500 leading-snug border-t border-slate-800 pt-2">
        <strong className="text-slate-400">Troubleshooting:</strong> if pairing
        never lands — (a) confirm the earclip is advertising in its serial
        monitor (<code>transport_ble: advertising</code>), (b) confirm the
        glasses central role is built into firmware (look for
        <code>central:</code> lines in the log here), (c) place both
        devices ≤ 1 m apart during the rescan. The hall-magnet 5-tap
        gesture on the glasses is the fallback that doesn't need this UI.
      </div>
    </div>
  );
}

function Step({
  n, title, done, hint, action,
}: {
  n: number;
  title: string;
  done: boolean;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <li className="flex items-start gap-2">
      <span
        className={
          'inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-medium shrink-0 ' +
          (done ? 'bg-emerald-500 text-emerald-950' : 'bg-slate-700 text-slate-300')
        }
      >
        {done ? '✓' : n}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-slate-200">{title}</div>
        {hint && <div className="text-slate-500 text-[10px]">{hint}</div>}
      </div>
      {action}
    </li>
  );
}

function extractEarclipFromLog(log: BleLogEntry[]): string | null {
  // Walk newest-first looking for the most recent earclip identifier
  // mentioned in central: lines. Prefer the MAC printed by NVS-load.
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e.source !== 'edge') continue;
    const mac = e.message.match(/([0-9a-f]{2}:){5}[0-9a-f]{2}/i);
    if (mac) return `earclip ${mac[0]}`;
  }
  return null;
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
