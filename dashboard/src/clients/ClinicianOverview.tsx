// Overview tab: statistical trends across ALL of a clinician's clients.
//
// One prop-less useSessionList() fetch returns every session the clinician owns
// (RLS-scoped); we group it by client and compute per-client improvement deltas
// plus a clinic-wide average. The headline chart is "who's improving" — each
// client's RMSSD change first→last, with a dashed line at the averaged delta.

import { useEffect, useMemo, useRef } from 'react';
import Plotly from 'plotly.js-dist-min';
import type { Shape } from 'plotly.js';
import { darkLayout } from '../charts/chartTheme';
import { useSessionList } from '../sessions/useSessions';
import { useClientList } from './useClients';
import { buildClientDeltas, averageDeltas, type ClientDelta } from './aggregate';

function fmtDelta(v: number | null, decimals = 1): string {
  if (v == null) return '—';
  return `${v > 0 ? '+' : ''}${v.toFixed(decimals)}`;
}

export default function ClinicianOverview() {
  const sessions = useSessionList();
  // Include archived so sessions attributed to an archived client still get a name.
  const clients = useClientList({ includeArchived: true });
  const barRef = useRef<HTMLDivElement | null>(null);

  const nameOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of clients.rows) m.set(c.id, c.display_name);
    return (id: string) => m.get(id) ?? 'Unknown';
  }, [clients.rows]);

  const perClient = useMemo<ClientDelta[]>(
    () => buildClientDeltas(sessions.rows),
    [sessions.rows],
  );
  const avg = useMemo(() => averageDeltas(perClient), [perClient]);

  // Clients that have a computable RMSSD delta, sorted best→worst for the bars.
  const withDelta = useMemo(
    () => perClient.filter((d) => d.rmssdDelta != null)
      .sort((a, b) => (b.rmssdDelta ?? 0) - (a.rmssdDelta ?? 0)),
    [perClient],
  );

  useEffect(() => {
    const div = barRef.current;
    if (!div) return;
    if (withDelta.length === 0) { void Plotly.purge(div); return; }

    const xs = withDelta.map((d) => nameOf(d.clientId));
    const ys = withDelta.map((d) => d.rmssdDelta as number);
    const colors = ys.map((v) => (v >= 0 ? 'rgba(52,211,153,0.85)' : 'rgba(239,68,68,0.8)'));

    const shapes: Partial<Shape>[] = avg.avgRmssdDelta != null
      ? [{
          type: 'line', xref: 'paper', yref: 'y',
          x0: 0, x1: 1, y0: avg.avgRmssdDelta, y1: avg.avgRmssdDelta,
          line: { color: '#22d3ee', width: 1.5, dash: 'dash' },
        }]
      : [];

    void Plotly.newPlot(div, [
      {
        x: xs, y: ys, type: 'bar',
        marker: { color: colors },
        hovertemplate: '%{x}<br>RMSSD Δ %{y:.1f} ms<extra></extra>',
      },
    ], darkLayout({
      xaxis: { title: { text: 'Client' }, gridcolor: '#334155', linecolor: '#475569', automargin: true },
      yaxis: { title: { text: 'RMSSD change first→last (ms)' }, gridcolor: '#334155', zerolinecolor: '#64748b', linecolor: '#475569' },
      shapes: shapes as Shape[],
      showlegend: false,
      margin: { l: 60, r: 16, t: 8, b: 60 },
    }), { responsive: true, displayModeBar: false });

    return () => { void Plotly.purge(div); };
  }, [withDelta, avg.avgRmssdDelta, nameOf]);

  if (!sessions || sessions.status === 'loading') {
    return <div className="p-8 text-center text-slate-500 text-sm">Loading…</div>;
  }
  if (sessions.status === 'error') {
    return <div className="p-8 text-center text-rose-400 text-sm">Couldn't load: {sessions.error}</div>;
  }
  if (perClient.length === 0) {
    return (
      <div className="p-8 text-center text-slate-500 text-sm">
        No client sessions yet. Once you train clients with a profile selected, their
        combined trends show up here.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Kpi label="Clients with sessions" value={avg.clientCount.toString()} />
        <Kpi label="Total sessions" value={avg.totalSessions.toString()} />
        <Kpi
          label="Avg RMSSD Δ"
          value={fmtDelta(avg.avgRmssdDelta)}
          unit="ms"
          tone={avg.avgRmssdDelta == null ? 'default' : avg.avgRmssdDelta > 0 ? 'good' : 'warn'}
        />
        <Kpi
          label="Clients improving"
          value={avg.clientsWithDelta > 0 ? `${avg.clientsImproved}/${avg.clientsWithDelta}` : '—'}
        />
      </div>

      <div className="space-y-1">
        <div className="text-xs font-medium text-slate-400 uppercase tracking-wide">
          RMSSD change per client (first → last) · dashed line = clinic average
        </div>
        {withDelta.length > 0 ? (
          <div ref={barRef} className="h-72 rounded border border-slate-800" />
        ) : (
          <div className="p-8 text-center text-slate-500 text-sm rounded border border-slate-800">
            Need at least one client with 2+ sessions to chart a trend delta.
          </div>
        )}
      </div>

      {/* Per-client breakdown table — the "statistical trends for all clients" view. */}
      <div className="space-y-1">
        <div className="text-xs font-medium text-slate-400 uppercase tracking-wide">All clients</div>
        <div className="overflow-x-auto rounded-lg border border-slate-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-slate-500 bg-slate-900/50">
                <Th>Client</Th><Th right>Sessions</Th><Th right>Minutes</Th>
                <Th right>RMSSD first→last</Th><Th right>RMSSD Δ</Th><Th right>Coh Δ</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {perClient
                .slice()
                .sort((a, b) => (b.rmssdDelta ?? -Infinity) - (a.rmssdDelta ?? -Infinity))
                .map((d) => (
                  <tr key={d.clientId} className="text-slate-200">
                    <Td>{nameOf(d.clientId)}</Td>
                    <Td right>{d.sessionCount}</Td>
                    <Td right>{d.totalMinutes}</Td>
                    <Td right>
                      {d.rmssdFirst != null && d.rmssdLast != null
                        ? `${d.rmssdFirst.toFixed(0)} → ${d.rmssdLast.toFixed(0)}`
                        : '—'}
                    </Td>
                    <Td right tone={d.rmssdDelta == null ? 'default' : d.rmssdDelta > 0 ? 'good' : 'warn'}>
                      {fmtDelta(d.rmssdDelta)}
                    </Td>
                    <Td right tone={d.cohDelta == null ? 'default' : d.cohDelta > 0 ? 'good' : 'warn'}>
                      {fmtDelta(d.cohDelta)}
                    </Td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Kpi({ label, value, unit, tone = 'default' }: {
  label: string; value: string; unit?: string; tone?: 'default' | 'good' | 'warn';
}) {
  const color = { default: 'text-slate-100', good: 'text-emerald-300', warn: 'text-rose-300' }[tone];
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/40 p-4">
      <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">{label}</div>
      <div className="flex items-baseline gap-1">
        <span className={`text-2xl font-semibold tabular-nums ${color}`}>{value}</span>
        {unit && <span className="text-xs text-slate-500">{unit}</span>}
      </div>
    </div>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <th className={`px-3 py-2 font-medium ${right ? 'text-right' : 'text-left'}`}>{children}</th>;
}

function Td({ children, right, tone = 'default' }: {
  children: React.ReactNode; right?: boolean; tone?: 'default' | 'good' | 'warn';
}) {
  const color = { default: 'text-slate-200', good: 'text-emerald-300', warn: 'text-rose-300' }[tone];
  return <td className={`px-3 py-2 tabular-nums ${right ? 'text-right' : 'text-left'} ${color}`}>{children}</td>;
}
