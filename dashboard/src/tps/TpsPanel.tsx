/*
 * TpsPanel — full-screen overlay (same scaffolding as ClinicianPortal) for the Thought Technology
 * TPS sensor. Three tabs:
 *   Training     — the live screens: heart rhythm, temperature, GSR, the combined protocol, and the
 *                  glasses output (TPS biofeedback / Breathing + TPS biofeedback).
 *   Diagnostics  — the Web Bluetooth link: connect, device information, GATT tree with notification
 *                  counters, link rates, raw packets, event log.
 *   Tunables     — every knob of the protocol, with the defaults from the spec.
 */
import { useState } from 'react';
import { useDashboardStore } from '../state/store';
import { DEFAULT_TUNABLES, type TpsTunables } from './tpsProtocol';
import { SCENARIO_INFO, SCENARIO_NAMES, type TpsScenarioName } from './tpsSource';
import { useTpsStore, type TpsOutputMode } from './tpsStore';
import { TpsIbiChart, TpsProtocolChart, TpsScChart, TpsTempChart } from './TpsCharts';
import { TPS_DATA_CHAR, TPS_DATA_SERVICE } from '../ble/tpsDevice';

type Tab = 'training' | 'diagnostics' | 'tunables';

const BTN = 'px-3 py-1 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 shrink-0 transition disabled:opacity-40 disabled:cursor-not-allowed';
const SEG_ON = 'px-3 py-1 bg-indigo-600 text-white';
const SEG_OFF = 'px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300';

export default function TpsPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('training');
  const linkStatus = useTpsStore((s) => s.link.status);
  const linkName = useTpsStore((s) => s.link.info.name);

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-slate-950">
      <header className="flex items-center gap-3 px-4 py-2 border-b border-slate-800 shrink-0">
        <h1 className="text-lg font-semibold tracking-tight text-slate-100">TPS sensor</h1>
        <span className="text-[10px] text-slate-500">Thought Technology · fingertip BVP / skin conductance / temperature</span>
        <div className="inline-flex rounded-md border border-slate-700 overflow-hidden text-xs ml-2">
          <button onClick={() => setTab('training')} className={tab === 'training' ? SEG_ON : SEG_OFF}>Training</button>
          <button onClick={() => setTab('diagnostics')} className={'border-l border-slate-700 ' + (tab === 'diagnostics' ? SEG_ON : SEG_OFF)}>Diagnostics</button>
          <button onClick={() => setTab('tunables')} className={'border-l border-slate-700 ' + (tab === 'tunables' ? SEG_ON : SEG_OFF)}>Tunables</button>
        </div>
        <span className="ml-auto text-xs text-slate-400 flex items-center gap-2">
          <span className={'inline-block w-2 h-2 rounded-full ' + dotClass(linkStatus)} />
          {linkStatus === 'connected' ? (linkName ?? 'TPS') : linkStatus}
        </span>
        <button onClick={onClose} className="px-3 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 shrink-0 transition">
          Back to Live
        </button>
      </header>
      <main className="flex-1 overflow-auto p-3">
        {tab === 'training' ? <TrainingTab /> : tab === 'diagnostics' ? <DiagnosticsTab /> : <TunablesTab />}
      </main>
    </div>
  );
}

function dotClass(s: string): string {
  if (s === 'connected') return 'bg-emerald-400';
  if (s === 'connecting' || s === 'reconnecting') return 'bg-amber-400 animate-pulse';
  return 'bg-slate-500';
}

/* ---- Training ------------------------------------------------------------- */

function Chip({ label, tone = 'slate' }: { label: string; tone?: 'slate' | 'green' | 'amber' | 'red' | 'indigo' }) {
  const cls = {
    slate: 'border-slate-700 text-slate-300',
    green: 'border-emerald-700 text-emerald-300',
    amber: 'border-amber-700 text-amber-300',
    red: 'border-red-700 text-red-300',
    indigo: 'border-indigo-700 text-indigo-300',
  }[tone];
  return <span className={'px-2 py-0.5 rounded border text-[11px] ' + cls}>{label}</span>;
}

function TrainingTab() {
  const s = useTpsStore();
  const edge = useDashboardStore((st) => st.connection.edge);
  const connectEdge = useDashboardStore((st) => st.connectEdge);
  const f = s.frame;
  const baselineLeft = f && f.phase === 'baseline' ? Math.max(0, s.tunables.baselineS - elapsedInPhase(f.t)) : null;

  const phaseChip = !f ? <Chip label="idle" /> :
    f.phase === 'baseline' ? <Chip label={`baseline${baselineLeft !== null ? ` · ${Math.ceil(baselineLeft)} s` : ''}`} tone="indigo" /> :
    f.phase === 'training' ? <Chip label="training" tone="green" /> :
    f.phase === 'contact_lost' ? <Chip label="contact lost" tone="red" /> : <Chip label={f.phase} />;

  return (
    <div className="flex flex-col gap-3">
      {/* status strip */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {phaseChip}
        {s.latest.contact === false ? <Chip label="off skin" tone="red" /> : s.latest.contact ? <Chip label="on skin" tone="green" /> : null}
        {s.latest.moving ? <Chip label="moving · output held" tone="amber" /> : null}
        {f ? <Chip label={`HRV ${f.valid.hrv ? 'in' : s.latest.lfPct === null ? 'warming up (64 s)' : f.baseline.lfPct === null ? 'baselining' : 'greyed'}`} tone={f.valid.hrv ? 'green' : 'slate'} /> : null}
        {f && f.r !== null ? <Chip label={`R ${f.r.toFixed(2)}`} tone={f.r > 0.2 ? 'green' : f.r < -0.2 ? 'red' : 'slate'} /> : null}
        {f ? <Chip label={`lens ${f.duty}% dark`} /> : null}
        {s.latest.lfPct !== null ? <Chip label={`LF ${s.latest.lfPct.toFixed(0)} % · HF ${(s.latest.hfPct ?? 0).toFixed(0)} %`} /> : null}
      </div>

      {/* controls */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="rounded border border-slate-800 bg-slate-900/50 p-3 flex flex-col gap-2">
          <div className="text-xs font-medium text-slate-300">Signal source</div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-md border border-slate-700 overflow-hidden text-xs">
              <button onClick={() => s.setSourceMode('simulated')} className={s.sourceMode === 'simulated' ? SEG_ON : SEG_OFF}>Simulated</button>
              <button onClick={() => s.setSourceMode('live')} className={'border-l border-slate-700 ' + (s.sourceMode === 'live' ? SEG_ON : SEG_OFF)}>Live sensor</button>
            </div>
            {s.sourceMode === 'simulated' ? (
              <>
                <select
                  value={s.scenario}
                  onChange={(e) => s.setScenario(e.target.value as TpsScenarioName)}
                  className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200"
                >
                  {SCENARIO_NAMES.map((n) => <option key={n} value={n}>{SCENARIO_INFO[n].title}</option>)}
                </select>
                <select
                  value={s.speed}
                  onChange={(e) => s.setSpeed(Number(e.target.value))}
                  className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200"
                  title="Replay speed"
                >
                  {[1, 2, 4, 10].map((v) => <option key={v} value={v}>×{v}</option>)}
                </select>
              </>
            ) : null}
            {s.sourceRunning
              ? <button className={BTN} onClick={s.stopSource}>Stop</button>
              : <button className={BTN} onClick={s.startSource} disabled={s.sourceMode === 'live'}>Start</button>}
            <button className={BTN} onClick={s.resetProtocol} title="Discard the baseline and start the protocol over">Reset baseline</button>
          </div>
          {s.sourceMode === 'simulated' ? (
            <div className="text-[11px] text-slate-500">{SCENARIO_INFO[s.scenario].desc}</div>
          ) : (
            <div className="text-[11px] text-amber-300/80">
              The TPS stream is encrypted and decoded only by Thought Technology's mobile SDK. The browser can connect and inspect
              the link (Diagnostics tab) but cannot read temperature, GSR or BVP. Use the Narbis Edge iOS/Android app for a live
              session, or the simulator here to exercise the protocol and glasses output.
            </div>
          )}
        </div>

        <div className="rounded border border-slate-800 bg-slate-900/50 p-3 flex flex-col gap-2">
          <div className="text-xs font-medium text-slate-300 flex items-center gap-2">
            Glasses output
            <span className={'inline-block w-2 h-2 rounded-full ' + dotClass(edge.state)} />
            <span className="text-[11px] text-slate-500">{edge.state === 'connected' ? (edge.deviceName ?? 'Narbis Edge') : 'glasses ' + edge.state}</span>
            {edge.state !== 'connected' ? (
              <button className={BTN + ' ml-auto'} onClick={() => void connectEdge().catch(() => undefined)}>Connect glasses</button>
            ) : null}
          </div>
          <div className="inline-flex rounded-md border border-slate-700 overflow-hidden text-xs self-start">
            {(['off', 'biofeedback', 'breathing'] as TpsOutputMode[]).map((m, i) => (
              <button
                key={m}
                onClick={() => void s.setOutput(m)}
                className={(i > 0 ? 'border-l border-slate-700 ' : '') + (s.output === m ? SEG_ON : SEG_OFF)}
                title={m === 'off' ? 'Lens cleared; the coherence engine may own the lens' :
                  m === 'biofeedback' ? 'Continuous tint: stressed → dark, calm → clear (static tint 0xA5)' :
                  'Breath pacer on the glasses; the inhale-peak darkness follows the TPS protocol (0xA2, latched per breath)'}
              >
                {m === 'off' ? 'Off' : m === 'biofeedback' ? 'TPS biofeedback' : 'Breathing + TPS biofeedback'}
              </button>
            ))}
          </div>
          {s.output === 'breathing' ? (
            <div className="flex flex-wrap items-center gap-3 text-xs text-slate-300">
              <label className="flex items-center gap-1">
                pace
                <input
                  type="number" min={3} max={12} step={0.5} value={s.breathBpm}
                  onChange={(e) => s.setBreathBpm(Number(e.target.value))}
                  className="w-16 bg-slate-800 border border-slate-700 rounded px-2 py-0.5 text-xs text-slate-100"
                />
                br/min
              </label>
              <label className="flex items-center gap-1">
                inhale
                <input
                  type="number" min={20} max={70} step={5} value={s.inhalePct}
                  onChange={(e) => s.setInhalePct(Number(e.target.value))}
                  className="w-16 bg-slate-800 border border-slate-700 rounded px-2 py-0.5 text-xs text-slate-100"
                />
                %
              </label>
            </div>
          ) : null}
          <div className="text-[11px] text-slate-500">
            {s.output === 'off' ? 'Pick an output to let the protocol drive the lens. Selecting one stops the coherence engine.' :
              s.output === 'biofeedback' ? `Last sent ${s.lastDutySent ?? '—'} % dark. Think of something stressful: the lens darkens within seconds; settle, and it clears.` :
              `Inhale-peak darkness ${s.lastDutySent ?? '—'} %, latched once per breath at the cycle boundary.`}
          </div>
        </div>
      </div>

      {/* charts */}
      <TpsIbiChart />
      <TpsTempChart />
      <TpsScChart />
      <TpsProtocolChart />
    </div>
  );
}

let _phaseStartT: number | null = null;
let _phaseSeenAt = 0;
/** Seconds since the first frame we saw in the current baseline run (display only). */
function elapsedInPhase(t: number): number {
  if (_phaseStartT === null || t < _phaseSeenAt) _phaseStartT = t;
  _phaseSeenAt = t;
  return t - _phaseStartT;
}

/* ---- Diagnostics ---------------------------------------------------------- */

function DiagnosticsTab() {
  const link = useTpsStore((s) => s.link);
  const log = useTpsStore((s) => s.log);
  const packets = useTpsStore((s) => s.packets);
  const connect = useTpsStore((s) => s.connectLink);
  const disconnect = useTpsStore((s) => s.disconnectLink);
  const busy = link.status === 'connecting' || link.status === 'reconnecting';
  const canBle = typeof navigator !== 'undefined' && !!navigator.bluetooth;

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded border border-slate-800 bg-slate-900/50 p-3 flex flex-wrap items-center gap-3">
        <span className={'inline-block w-2.5 h-2.5 rounded-full ' + dotClass(link.status)} />
        <span className="text-sm text-slate-200">{link.status}{link.info.name ? ` · ${link.info.name}` : ''}</span>
        {link.status === 'disconnected'
          ? <button className={BTN} onClick={() => void connect().catch(() => undefined)} disabled={!canBle}>Connect TPS…</button>
          : <button className={BTN} onClick={() => void disconnect()} disabled={busy && link.status === 'connecting'}>Disconnect</button>}
        {!canBle ? <span className="text-xs text-amber-300">Web Bluetooth needs Chrome or Edge (desktop or Android); iOS Safari cannot do this.</span> : null}
        {link.error ? <span className="text-xs text-red-300">{link.error}</span> : null}
        <span className="ml-auto text-[11px] text-slate-500">
          filters: name prefix "TPS" · service {TPS_DATA_SERVICE.slice(0, 8)}… · data char {TPS_DATA_CHAR.slice(0, 8)}…
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="rounded border border-slate-800 bg-slate-900/50 p-3">
          <div className="text-xs font-medium text-slate-300 mb-2">Device information</div>
          <table className="text-xs text-slate-300 w-full">
            <tbody>
              {([
                ['Name', link.info.name], ['Manufacturer', link.info.manufacturer], ['Model', link.info.model],
                ['Serial', link.info.serial], ['Firmware', link.info.firmware], ['Hardware', link.info.hardware],
                ['Software', link.info.software], ['Browser device id', link.info.id],
              ] as Array<[string, string | null]>).map(([k, v]) => (
                <tr key={k} className="border-t border-slate-800/60">
                  <td className="py-1 pr-3 text-slate-500 whitespace-nowrap">{k}</td>
                  <td className="py-1 font-mono break-all">{v ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="rounded border border-slate-800 bg-slate-900/50 p-3">
          <div className="text-xs font-medium text-slate-300 mb-2">Link statistics</div>
          <table className="text-xs text-slate-300 w-full">
            <tbody>
              {([
                ['Notifications', `${link.stats.notifications}`],
                ['Bytes', `${link.stats.bytes}`],
                ['7-byte frames', `${link.stats.frames}`],
                ['Rate', link.stats.lastAt ? `${link.stats.notifPerSec.toFixed(1)} notif/s · ${link.stats.bytesPerSec.toFixed(0)} B/s · ${link.stats.framesPerSec.toFixed(0)} frames/s` : '—'],
                ['Last gap', link.stats.lastGapMs !== null ? `${link.stats.lastGapMs} ms (max ${link.stats.maxGapMs} ms)` : '—'],
                ['Packet sizes', Object.keys(link.stats.sizes).length ? Object.entries(link.stats.sizes).map(([k, v]) => `${k} B ×${v}`).join(', ') : '—'],
                ['Streaming since', link.stats.firstAt ? new Date(link.stats.firstAt).toLocaleTimeString() : '—'],
              ] as Array<[string, string]>).map(([k, v]) => (
                <tr key={k} className="border-t border-slate-800/60">
                  <td className="py-1 pr-3 text-slate-500 whitespace-nowrap">{k}</td>
                  <td className="py-1 font-mono">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-2 text-[11px] text-slate-500">
            A healthy link shows a steady notification rate and gaps well under 100 ms. If the sensor drops the link, this driver
            reconnects automatically; note the time and the gap here for a support case.
          </div>
        </div>
      </div>

      <div className="rounded border border-slate-800 bg-slate-900/50 p-3">
        <div className="text-xs font-medium text-slate-300 mb-2">GATT · services and characteristics the browser can see</div>
        {link.services.length === 0 ? (
          <div className="text-xs text-slate-500">Nothing enumerated yet — connect a sensor. Only services listed in the driver's optionalServices are visible to a web page.</div>
        ) : (
          <div className="flex flex-col gap-2">
            {link.services.map((svc) => (
              <div key={svc.uuid} className="text-xs">
                <div className="font-mono text-slate-200">{svc.uuid}{svc.uuid === TPS_DATA_SERVICE ? <span className="ml-2 text-emerald-300">TT data service</span> : null}</div>
                <table className="w-full mt-1">
                  <tbody>
                    {svc.characteristics.map((c) => (
                      <tr key={c.uuid} className="border-t border-slate-800/60 text-slate-300">
                        <td className="py-0.5 pr-2 font-mono text-[11px] whitespace-nowrap">{c.uuid}{c.uuid === TPS_DATA_CHAR ? <span className="ml-1 text-emerald-300">data</span> : null}</td>
                        <td className="py-0.5 pr-2 text-slate-500 whitespace-nowrap">{c.properties.join(' ')}</td>
                        <td className="py-0.5 pr-2 whitespace-nowrap">{c.notifying ? `${c.notifications} notif · ${c.bytes} B` : c.readHex ? `read: ${c.readHex}` : ''}</td>
                        <td className="py-0.5 font-mono text-[11px] text-slate-400 break-all">{c.lastHex ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="rounded border border-slate-800 bg-slate-900/50 p-3">
          <div className="text-xs font-medium text-slate-300 mb-2">Raw packets (newest first)</div>
          <div className="font-mono text-[11px] text-slate-400 max-h-64 overflow-auto">
            {packets.length === 0 ? <div className="text-slate-500">—</div> :
              [...packets].reverse().slice(0, 30).map((p, i) => (
                <div key={`${p.timestamp}-${i}`} className="border-t border-slate-800/60 py-0.5 break-all">
                  <span className="text-slate-500">{new Date(p.timestamp).toLocaleTimeString()}.{String(p.timestamp % 1000).padStart(3, '0')}</span>
                  <span className="text-slate-500"> {p.bytes.length} B </span>{p.hex}
                </div>
              ))}
          </div>
          <div className="mt-2 text-[11px] text-slate-500">
            Encrypted on the wire. Packet sizes and timing can be checked here; physiology cannot be read without Thought
            Technology's decoder.
          </div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/50 p-3">
          <div className="text-xs font-medium text-slate-300 mb-2">Event log</div>
          <div className="font-mono text-[11px] max-h-64 overflow-auto">
            {log.length === 0 ? <div className="text-slate-500">—</div> :
              [...log].reverse().map((e) => (
                <div key={e.id} className={'border-t border-slate-800/60 py-0.5 ' + (e.level === 'error' ? 'text-red-300' : e.level === 'warn' ? 'text-amber-300' : 'text-slate-300')}>
                  <span className="text-slate-500">{new Date(e.timestamp).toLocaleTimeString()} </span>{e.message}
                </div>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---- Tunables ------------------------------------------------------------- */

interface Field { key: keyof TpsTunables; label: string; unit: string; min: number; max: number; step: number; help: string }

const FIELDS: Field[] = [
  { key: 'baselineS', label: 'Baseline', unit: 's', min: 20, max: 180, step: 5, help: 'Seconds of contact used to capture the temperature and GSR baseline.' },
  { key: 'hrvBaselineS', label: 'HRV baseline', unit: 's', min: 10, max: 60, step: 5, help: 'Seconds of valid HRV used for the LF % baseline, after the SDK\'s 64 s window.' },
  { key: 'tempSpanC', label: 'Temp span', unit: '°C', min: 0.3, max: 3, step: 0.1, help: 'Rise above baseline that counts as full reward.' },
  { key: 'tauTempS', label: 'Temp τ', unit: 's', min: 1, max: 20, step: 1, help: 'Smoothing of the temperature score.' },
  { key: 'scSpanRel', label: 'GSR span', unit: '×', min: 0.1, max: 0.6, step: 0.05, help: 'Relative drop that counts as full reward (0.3 = 30 %).' },
  { key: 'scFloorUs', label: 'GSR floor', unit: 'µS', min: 0.1, max: 2, step: 0.1, help: 'Baseline floor so dry skin cannot explode the relative change.' },
  { key: 'tauScS', label: 'GSR τ', unit: 's', min: 1, max: 10, step: 0.5, help: 'Smoothing of the tonic GSR score.' },
  { key: 'scrSlopeUsPerS', label: 'SCR slope', unit: 'µS/s', min: 0.1, max: 2, step: 0.1, help: 'Rising slope that counts as a full skin-conductance response.' },
  { key: 'scrPenalty', label: 'SCR penalty', unit: '', min: 0, max: 1, step: 0.05, help: 'How much a full SCR subtracts from the GSR score.' },
  { key: 'lfNeutralPct', label: 'LF neutral', unit: '%', min: 20, max: 60, step: 1, help: 'LF % that scores zero on the absolute HRV term.' },
  { key: 'lfSpanPct', label: 'LF span', unit: 'pts', min: 10, max: 50, step: 1, help: 'LF % points to full reward.' },
  { key: 'tauHrvS', label: 'HRV τ', unit: 's', min: 1, max: 15, step: 0.5, help: 'Smoothing of the HRV score.' },
  { key: 'wTemp', label: 'Weight · temp', unit: '', min: 0, max: 1, step: 0.05, help: 'Channel weight; invalid channels are renormalised away.' },
  { key: 'wSc', label: 'Weight · GSR', unit: '', min: 0, max: 1, step: 0.05, help: '' },
  { key: 'wHrv', label: 'Weight · HRV', unit: '', min: 0, max: 1, step: 0.05, help: '' },
  { key: 'tauOutS', label: 'Output τ', unit: 's', min: 0.5, max: 8, step: 0.5, help: 'Smoothing of the relaxation index before the lens mapping.' },
  { key: 'neutralDuty', label: 'Neutral darkness', unit: '%', min: 0, max: 80, step: 5, help: 'Lens darkness at R = 0, during baseline, and when contact is lost.' },
  { key: 'gain', label: 'Gain', unit: '', min: 0.2, max: 2, step: 0.1, help: 'darkness = neutral − gain·100·R.' },
  { key: 'maxSlewPerS', label: 'Max slew', unit: '%/s', min: 10, max: 200, step: 10, help: 'Fastest the commanded darkness may move.' },
  { key: 'deadband', label: 'Dead-band', unit: '%', min: 0, max: 5, step: 1, help: 'Minimum change before a new value is written to the glasses.' },
  { key: 'baselineResetS', label: 'Baseline reset', unit: 's', min: 30, max: 600, step: 30, help: 'Contact lost longer than this restarts the baseline.' },
];

function TunablesTab() {
  const tunables = useTpsStore((s) => s.tunables);
  const setTunables = useTpsStore((s) => s.setTunables);
  const resetTunables = useTpsStore((s) => s.resetTunables);
  return (
    <div className="flex flex-col gap-3 max-w-4xl">
      <div className="flex items-center gap-3">
        <div className="text-xs text-slate-400">
          Spec: <span className="font-mono">edge-ThoughtTechnology/tps/docs/TPS_BIOFEEDBACK_PROTOCOL.md</span>. Changing a value starts a new baseline.
          The same names and defaults are used by the iOS and Android apps.
        </div>
        <button className={BTN + ' ml-auto'} onClick={resetTunables}>Reset to defaults</button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {FIELDS.map((f) => {
          const v = tunables[f.key];
          const isDefault = v === DEFAULT_TUNABLES[f.key];
          return (
            <label key={f.key} className="rounded border border-slate-800 bg-slate-900/50 p-2 flex items-center gap-3 text-xs">
              <div className="flex-1">
                <div className="text-slate-200">{f.label} <span className="text-slate-500">{f.unit}</span>{!isDefault ? <span className="ml-2 text-amber-300">edited</span> : null}</div>
                {f.help ? <div className="text-[11px] text-slate-500">{f.help}</div> : null}
              </div>
              <input
                type="number" min={f.min} max={f.max} step={f.step} value={v}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n)) setTunables({ [f.key]: Math.min(f.max, Math.max(f.min, n)) } as Partial<TpsTunables>);
                }}
                className="w-24 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-100 font-mono"
              />
            </label>
          );
        })}
      </div>
    </div>
  );
}
