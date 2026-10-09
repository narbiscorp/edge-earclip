/*
 * GuidedRecordingModal.tsx — run a guided protocol (protocol/guided/*.json)
 * and leave behind one self-labelled recording.
 *
 * Setup: pick the protocol, subject and audio mode, with a pre-flight
 * checklist of what makes the data worth recording (V2 earclip streaming,
 * AGC locked so the raw trace has no gain steps, a Polar H10 for
 * ground-truth beats). Run: the current instruction large enough to read
 * across the room, a countdown, a flash on each cue. Done: the zip.
 *
 * The session itself is a singleton (guided/session.ts); this component
 * only drives and displays it, so it cannot be closed while one runs.
 */
import { useEffect, useState } from 'react';
import { GUIDED_PROTOCOLS, findProtocol, protocolSeconds, type GuidedBlock } from '../guided/protocol';
import { guidedSession } from '../guided/session';
import type { AudioMode } from '../guided/audio';
import { useDashboardStore } from '../state/store';
import { useRecordingStore } from '../state/recording';
import { saveBlobWithPicker } from '../recording/export';
import { AGC_ST_LOCKED, AGC_STATE_NAME, PROTO_VER_AGC_STATE } from '../ble/v2/protocol';

const SETTINGS_KEY = 'guidedRecordingSettings';

const TITLES: Record<string, string> = {
  settle: 'Settling in', transition: 'Get ready', rest: 'Sit still', foot_tap: 'Foot tapping',
  chew: 'Chewing', talk: 'Talking', head_turn: 'Head turns', jaw_clench: 'Jaw clenches',
  swallow: 'Swallowing', arm_move: 'Arm movement', paced_breath: 'Paced breathing',
  stand_sit: 'Stand up / sit down', walk_in_place: 'Walking in place', clip_touch: 'Touching the clip',
};

function title(b: GuidedBlock | null): string {
  if (!b) return '';
  return TITLES[b.label] ?? b.label.replace(/_/g, ' ');
}

function mmss(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

interface Saved { protocolId: string; subjectId: string; audioMode: AudioMode }

function loadSaved(): Saved {
  try {
    const v = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as Partial<Saved> | null;
    return {
      protocolId: v?.protocolId && findProtocol(v.protocolId) ? v.protocolId : 'ppg_artifact_core',
      subjectId: v?.subjectId ?? '',
      audioMode: v?.audioMode ?? 'speech',
    };
  } catch {
    return { protocolId: 'ppg_artifact_core', subjectId: '', audioMode: 'speech' };
  }
}

function Check({ ok, warn = false, label, detail }: { ok: boolean; warn?: boolean; label: string; detail: string }) {
  const icon = ok ? '✓' : warn ? '!' : '✗';
  const tone = ok ? 'text-emerald-400' : warn ? 'text-amber-400' : 'text-red-400';
  return (
    <li className="flex gap-2 text-[12px]">
      <span className={`w-4 shrink-0 font-bold ${tone}`}>{icon}</span>
      <span className="text-slate-200">{label}</span>
      <span className="text-slate-500">— {detail}</span>
    </li>
  );
}

export function GuidedRecordingButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs px-3 py-1 rounded bg-indigo-700 hover:bg-indigo-600 text-white"
        title="Run a guided protocol (sit still, tap foot, chew, talk…) and record labelled raw data"
      >
        ◎ Guided recording
      </button>
      {open && <GuidedRecordingModal onClose={() => setOpen(false)} />}
    </>
  );
}

export default function GuidedRecordingModal({ onClose }: { onClose: () => void }) {
  const saved = loadSaved();
  const [protocolId, setProtocolId] = useState(saved.protocolId);
  const [subjectId, setSubjectId] = useState(saved.subjectId);
  const [audioMode, setAudioMode] = useState<AudioMode>(saved.audioMode);
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [, setFrame] = useState(0);

  const narbis = useDashboardStore((s) => s.connection.narbis);
  const polar = useDashboardStore((s) => s.connection.polar);
  const generation = useDashboardStore((s) => s.earclipProtocol);
  const protoVer = useDashboardStore((s) => s.earclipProtoVer);
  const st = useDashboardStore((s) => s.v2Status);
  const link = useDashboardStore((s) => s.v2LinkStats);
  const recPhase = useRecordingStore((s) => s.phase);
  const finalBlob = useRecordingStore((s) => s.finalBlob);
  const finalFilename = useRecordingStore((s) => s.finalFilename);

  /* 10 Hz redraw: countdowns and cue flashes come from the session clock. */
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => f + 1), 100);
    return () => clearInterval(id);
  }, []);

  const status = guidedSession.status();
  const phase = status?.phase ?? 'idle';
  const protocol = findProtocol(protocolId) ?? GUIDED_PROTOCOLS[0];

  const connected = narbis.state === 'connected';
  const isV2 = generation === 'v2';
  const fresh = !!st && Date.now() - st.timestamp < 4000;
  const agcKnown = protoVer !== null && protoVer >= PROTO_VER_AGC_STATE;
  const agcLocked = agcKnown && !!st && st.agcState === AGC_ST_LOCKED;
  const h10 = polar.state === 'connected';

  const start = async () => {
    setErr(null);
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ protocolId, subjectId, audioMode }));
    } catch { /* private mode */ }
    try {
      await guidedSession.start(protocol, { subjectId, audioMode, notes });
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  /* ---------------- running ---------------- */
  if (phase === 'running' || phase === 'paused') {
    const b = status!.block;
    const labelled = b?.kind === 'state' || b?.kind === 'cued';
    const cue = guidedSession.lastCue;
    const cueFlash = cue && performance.now() - cue.atMs < 1500 && phase === 'running';
    const counters = guidedSession.counters;
    return (
      <Overlay>
        <div className="flex items-baseline justify-between text-[11px] text-slate-400">
          <span>{guidedSession.protocol?.title}</span>
          <span>block {status!.blockIndex + 1} of {guidedSession.protocol?.blocks.length}
            {status!.attempt > 1 ? ` · attempt ${status!.attempt}` : ''}</span>
        </div>
        <div className="mt-6 text-center">
          <div className={`text-[13px] uppercase tracking-widest ${labelled ? 'text-emerald-400' : 'text-slate-500'}`}>
            {phase === 'paused' ? 'paused' : labelled ? 'recording' : b?.kind === 'settle' ? 'settling' : 'instruction'}
          </div>
          <div className="mt-2 text-4xl font-semibold text-slate-100">
            {b?.kind === 'transition' ? `Next: ${title(status!.nextBlock)}` : title(b)}
          </div>
          <div className="mx-auto mt-3 max-w-xl text-lg text-slate-300">{b?.prompt}</div>
          <div className={`mx-auto mt-6 h-16 max-w-md rounded-lg flex items-center justify-center text-3xl font-bold transition-colors ${
            cueFlash ? 'bg-amber-500 text-slate-950' : 'bg-transparent text-transparent'}`}>
            {cueFlash ? cue!.prompt : '·'}
          </div>
          <div className="mt-4 font-mono text-6xl text-slate-100">{mmss(status!.blockRemainingMs)}</div>
          {status!.nextCueInMs !== null && phase === 'running' ? (
            <div className="mt-1 text-[12px] text-slate-500">next cue in {(status!.nextCueInMs / 1000).toFixed(1)} s</div>
          ) : null}
        </div>
        <div className="mt-6 h-1.5 w-full rounded bg-slate-800">
          <div className="h-1.5 rounded bg-indigo-500" style={{ width: `${(100 * status!.progressMs) / status!.plannedMs}%` }} />
        </div>
        <div className="mt-1 flex justify-between text-[11px] text-slate-500">
          <span>{mmss(status!.progressMs)} done</span>
          <span>{mmss(status!.plannedMs - status!.progressMs)} left</span>
        </div>
        <div className="mt-4 grid grid-cols-4 gap-2 text-[11px] font-mono text-slate-400">
          <span>AGC <span className={agcLocked ? 'text-emerald-400' : 'text-amber-400'}>
            {agcKnown && st ? AGC_STATE_NAME[st.agcState] ?? '?' : 'n/a'}</span></span>
          <span>HR <span className="text-slate-200">{st?.hrBpm || '—'}</span></span>
          <span>lost <span className={link && link.ppgLostBatches ? 'text-amber-400' : 'text-slate-200'}>
            {link?.ppgLostBatches ?? '—'}</span> · clip <span className="text-slate-200">{link?.clippedBatches ?? '—'}</span></span>
          <span>markers <span className="text-slate-200">{counters.markersSent}</span>
            {counters.markersFailed ? <span className="text-red-400"> ✗{counters.markersFailed}</span> : null}
            · H10 <span className={h10 ? 'text-emerald-400' : 'text-slate-500'}>{h10 ? 'on' : 'off'}</span></span>
        </div>
        <div className="mt-5 flex justify-center gap-3">
          {phase === 'running' ? (
            <Btn onClick={() => guidedSession.pause()} title="Ends this block early; resuming restarts it from the beginning">Pause</Btn>
          ) : (
            <Btn onClick={() => guidedSession.resume()} title="Restarts the paused block from its beginning" primary>Resume (restart block)</Btn>
          )}
          <Btn onClick={() => guidedSession.skip()} disabled={phase !== 'running'} title="End this block now and go to the next">Skip block</Btn>
          <Btn
            onClick={() => { if (window.confirm('Stop the protocol? The recording so far is kept.')) guidedSession.abort(); }}
            danger
          >Stop</Btn>
        </div>
      </Overlay>
    );
  }

  /* ---------------- finished ---------------- */
  if (phase === 'done' || phase === 'aborted') {
    const saving = recPhase === 'RECORDING' || recPhase === 'FINALIZING';
    const counters = guidedSession.counters;
    return (
      <Overlay>
        <div className="text-center">
          <div className="text-3xl font-semibold text-slate-100">
            {phase === 'done' ? 'Protocol complete' : 'Protocol stopped'}
          </div>
          <div className="mt-2 text-slate-400">{guidedSession.protocol?.title}</div>
          <div className="mt-4 text-[12px] text-slate-400">
            markers sent to the earclip: {counters.markersSent}
            {counters.markersFailed ? ` (${counters.markersFailed} failed: ${counters.lastMarkerError})` : ''}
          </div>
          <div className="mt-6">
            {saving ? (
              <span className="text-slate-300">Saving the recording…</span>
            ) : finalBlob && finalFilename ? (
              <Btn primary onClick={() => void saveBlobWithPicker(finalBlob, finalFilename)}>
                Download recording (.zip)
              </Btn>
            ) : (
              <span className="text-slate-500">The labels went into the recording that was already running — stop it from the footer to save.</span>
            )}
          </div>
          <div className="mt-6 flex justify-center gap-3">
            <Btn onClick={() => { guidedSession.reset(); setFrame((f) => f + 1); }}>Start another</Btn>
            <Btn onClick={() => { guidedSession.reset(); onClose(); }}>Close</Btn>
          </div>
        </div>
      </Overlay>
    );
  }

  /* ---------------- setup ---------------- */
  return (
    <Overlay>
      <div className="flex items-center justify-between">
        <div className="text-lg font-semibold text-slate-100">Guided recording</div>
        <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-200 text-sm">✕</button>
      </div>
      <p className="mt-1 text-[12px] text-slate-400">
        Walks the wearer through labelled activities and records everything raw — PPG, accelerometer,
        beats, AGC state and an H10 reference — so on-device beat detection can be built and tested
        against what was really happening.
      </p>

      <div className="mt-4 grid grid-cols-1 gap-2">
        {GUIDED_PROTOCOLS.map((p) => (
          <label key={p.id} className={`flex cursor-pointer gap-3 rounded border px-3 py-2 ${
            p.id === protocolId ? 'border-indigo-500 bg-indigo-950/40' : 'border-slate-800 hover:border-slate-700'}`}>
            <input type="radio" name="protocol" checked={p.id === protocolId} onChange={() => setProtocolId(p.id)}
              className="mt-1 accent-indigo-500" />
            <span>
              <span className="text-[13px] text-slate-100">{p.title}</span>
              <span className="ml-2 text-[11px] font-mono text-slate-500">{mmss(protocolSeconds(p) * 1000)}</span>
              {p.check_only ? <span className="ml-2 text-[10px] text-amber-400">plumbing check only</span> : null}
              <span className="block text-[11px] text-slate-400">{p.summary}</span>
            </span>
          </label>
        ))}
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3 text-[12px]">
        <label className="flex flex-col gap-1 text-slate-400">
          Subject ID
          <input value={subjectId} onChange={(e) => setSubjectId(e.target.value)} placeholder="e.g. S01"
            className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-slate-100" />
        </label>
        <label className="flex flex-col gap-1 text-slate-400">
          Audio
          <select value={audioMode} onChange={(e) => setAudioMode(e.target.value as AudioMode)}
            className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-slate-100">
            <option value="speech">Tones + spoken instructions</option>
            <option value="tones">Tones only</option>
            <option value="off">Silent (screen only)</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-slate-400">
          Notes
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="ear, fit, conditions…"
            className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-slate-100" />
        </label>
      </div>

      <ul className="mt-4 flex flex-col gap-1">
        <Check ok={connected} label="Earclip connected" detail={connected ? (narbis.deviceName ?? 'connected') : 'connect it from the header first'} />
        <Check ok={connected && isV2} warn={connected && !isV2} label="V2.1 earclip"
          detail={!connected ? '—' : isV2 ? 'raw PPG, accel and device markers' : 'a v1 earclip has no raw stream or markers; labels are host-time only'} />
        <Check ok={isV2 && fresh} warn={isV2 && !fresh} label="Data flowing"
          detail={isV2 ? (fresh ? `${link?.ppgBatches ?? 0} PPG batches, ${link?.ppgLostBatches ?? 0} lost` : 'no status in the last few seconds') : '—'} />
        <Check ok={agcLocked} warn label="Gain locked"
          detail={!isV2 ? '—' : !agcKnown ? 'firmware predates the AGC lock — gain may step during the recording'
            : agcLocked ? 'no gain steps will land in the raw trace'
              : `AGC is ${st ? AGC_STATE_NAME[st.agcState] : '…'} — wait for LOCKED (clip on, sit still)`} />
        <Check ok={h10} warn label="Polar H10 reference" detail={h10 ? 'ground-truth beats will be recorded' : 'recommended: connect it for ground-truth beats'} />
        {recPhase === 'RECORDING' ? (
          <Check ok warn label="Recording already running" detail="the protocol will label it; stop it from the footer when done" />
        ) : null}
      </ul>

      {err ? <div className="mt-3 rounded border border-red-700/40 bg-red-900/20 px-2 py-1 text-[12px] text-red-300">{err}</div> : null}

      <div className="mt-5 flex items-center justify-between">
        <Btn onClick={() => void guidedSession.testAudio(audioMode)} disabled={audioMode === 'off'}>Test audio</Btn>
        <Btn primary onClick={() => void start()} disabled={!connected}
          title={connected ? '' : 'Connect the earclip first'}>
          Start — {mmss(protocolSeconds(protocol) * 1000)}
        </Btn>
      </div>
    </Overlay>
  );
}

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-[760px] max-w-[96vw] max-h-[94vh] overflow-auto rounded-xl border border-slate-700 bg-slate-950 p-6 shadow-2xl">
        {children}
      </div>
    </div>
  );
}

function Btn({
  children, onClick, primary = false, danger = false, disabled = false, title,
}: {
  children: React.ReactNode; onClick: () => void; primary?: boolean; danger?: boolean;
  disabled?: boolean; title?: string;
}) {
  const tone = primary ? 'bg-indigo-600 hover:bg-indigo-500 text-white'
    : danger ? 'bg-red-900/50 hover:bg-red-800/60 text-red-200 border border-red-800/60'
      : 'bg-slate-800 hover:bg-slate-700 text-slate-200';
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title}
      className={`rounded px-4 py-1.5 text-[13px] disabled:opacity-40 ${tone}`}>
      {children}
    </button>
  );
}
