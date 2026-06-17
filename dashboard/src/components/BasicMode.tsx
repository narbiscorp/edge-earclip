import { useEffect, useState } from 'react';
import {
  useDashboardStore,
  getSessionStartTs,
  getSessionPausedAt,
  getSessionEndedAt,
  getSessionPauseTotalMs,
} from '../state/store';
import {
  edgeDevice,
  type CoherenceDifficulty,
  type PpgProgram,
} from '../ble/edgeDevice';
import BeatChart from './BeatChart';
import FilteredBeatChart from './FilteredBeatChart';
import CoherenceChart from './CoherenceChart';
import AccChart from './AccChart';
import ChimeControls from './ChimeControls';
import BreathCue from './BreathCue';
import { useLastMetrics } from '../state/useLastMetrics';
import { useBreathPhase } from '../state/useBreathPhase';
import { coherenceEngine } from '../engine/coherenceEngine';
import type { EngineMode, EngineStatus } from '../engine/coherenceEngine';
import { ENGINE_MODE_INFO, modeBStatusText, modeCStatusText } from './engine/modeInfo';

/* Friendly labels for the four PPG programs the firmware ships. The
 * expert UI shows them as "Prog 1 / 2 / 3 / 4"; a lay user wants to
 * know what each one does. `desc` lives in the button's title tooltip
 * in the slim picker — the cards used to show it inline. */
const PROGRAM_INFO: Record<PpgProgram, { title: string; desc: string }> = {
  1: {
    title: 'Heartbeat Pulse',
    desc: 'Lens pulses softly with each heartbeat. Good for tuning into your pulse.',
  },
  2: {
    title: 'Breathing Guide',
    desc: 'Lens follows a calm breathing rhythm — adapts to your detected breathing rate.',
  },
  3: {
    title: 'Coherence Lens',
    desc: 'Lens clears as your heart-rate variability gets smoother. Quiet biofeedback.',
  },
  4: {
    title: 'Breath + Strobe',
    desc: 'Breathing rhythm with a gentle 10 Hz strobe. The most stimulating program.',
  },
};

/* Coherence zone helpers. Tracks the same low / moderate / good zones
 * the firmware uses internally — drives the ring stroke, the zone pill,
 * and the breath-hint copy under the lens-tint bar. */
type CohZone = 'low' | 'mid' | 'high';
function cohZone(coh: number | null): CohZone | null {
  if (coh == null) return null;
  if (coh >= 70) return 'high';
  if (coh >= 30) return 'mid';
  return 'low';
}
function cohLabel(coh: number): string {
  if (coh >= 70) return 'High coherence';
  if (coh >= 30) return 'Building';
  return 'Settling';
}
function cohHint(coh: number | null): string {
  if (coh == null) return 'Connect glasses to begin';
  if (coh >= 70) return 'Clear — hold this rhythm';
  if (coh >= 40) return 'Soften your breath, let it settle';
  return 'Slow in, slower out — find the line';
}
/* Cyan → teal → emerald as the score climbs. Hex matches Tailwind
 * cyan-400 / teal-300 / emerald-400 so the whole Live view shares a
 * single color story (ring, pill dot, tint-bar gradient, active program
 * glow all sample from this map). */
function zoneColor(z: CohZone | null): string {
  if (z === 'high') return '#34d399';
  if (z === 'mid')  return '#5eead4';
  if (z === 'low')  return '#22d3ee';
  return '#475569';
}

/* Brainwave-entrainment frequency presets for the strobe (Program 4 +
 * standalone strobe). Values from Hutchison / Siever frequency-following-
 * response literature; band labels are conventional EEG ranges. The
 * dashboard sends the value at 0.1 Hz precision via the extended 0xAB
 * opcode (firmware v4.14.41+). */
const STROBE_PRESETS: Array<{ label: string; band: string; hz: number }> = [
  { label: 'Deep Relaxation', band: 'Delta',      hz: 2.0 },
  { label: 'Theta',           band: 'Theta',      hz: 6.0 },
  { label: 'Meditation',      band: 'Alpha',      hz: 10.0 },
  { label: 'Calm Focus',      band: 'low-Beta',   hz: 13.5 },
  { label: 'Focus',           band: 'Beta',       hz: 17.5 },
  { label: 'Gamma',           band: 'Gamma',      hz: 30.0 },
  { label: 'Gamma+',          band: 'high-Gamma', hz: 40.0 },
];

/** UI difficulty → engine gamma index (0=easy … 3=expert); mirrors edgeDevice DIFFICULTY_VALUE. */
const DIFFICULTY_NUM: Record<CoherenceDifficulty, number> = { easy: 0, medium: 1, hard: 2, expert: 3 };

interface BasicModeProps {
  /** Forces a phone-shaped single-column layout with bigger touch targets,
   *  regardless of viewport width. Toggled by the "Mobile" header button. */
  mobile?: boolean;
}

export default function BasicMode({ mobile = false }: BasicModeProps = {}) {
  const polarConn = useDashboardStore((s) => s.connection.polar.state);
  const edgeConn = useDashboardStore((s) => s.connection.edge.state);
  const narbisConn = useDashboardStore((s) => s.connection.narbis.state);
  const edgeRelay = useDashboardStore((s) => s.connection.edge.earclipRelay);
  const lastBeat = useDashboardStore((s) => s.lastBeat);
  const lastPolarBeat = useDashboardStore((s) => s.lastPolarBeat);
  const lastEdgeCoh = useDashboardStore((s) => s.lastEdgeCoherence);
  const hrSource = useDashboardStore((s) => s.hrSourceForGlasses);
  const program = useDashboardStore((s) => s.activeProgram);
  const setActiveProgram = useDashboardStore((s) => s.setActiveProgram);
  const engineMode = useDashboardStore((s) => s.engineMode);
  const setEngineMode = useDashboardStore((s) => s.setEngineMode);
  const engineStatus = useDashboardStore((s) => s.engineStatus);
  const lastMetrics = useLastMetrics();

  /* Derived metrics. Each can be null when its data source isn't reporting.
   * effectiveHrSource falls back to H10 for the display when earclip is
   * absent — hrSourceForGlasses only auto-switches when glasses are connected,
   * so without glasses it stays 'earclip' even if H10 is the only sensor. */
  const effectiveHrSource =
    narbisConn !== 'connected' && polarConn === 'connected' ? 'h10' : hrSource;
  const hrBpm = effectiveHrSource === 'h10'
    ? (lastPolarBeat?.bpm ?? null)
    : (lastBeat?.bpm ?? null);
  /* When the app-side Coherence Engine (Mode A/B) is driving, the firmware 0xF2 frame
   * goes stale (we feed beats to the engine, not the firmware pipeline), so read coherence
   * / pacer / respiration from the engine's live status instead. Both are 0–100 / BPM. */
  const engineActive = engineMode !== 'firmware' && !!engineStatus?.running;
  const coh = engineActive ? engineStatus!.coherence : (lastEdgeCoh?.coh ?? null);
  const respBpm = engineActive
    ? (engineStatus!.respHz > 0 ? engineStatus!.respHz * 60 : null)
    : lastEdgeCoh != null && lastEdgeCoh.respMhz > 0
      ? (lastEdgeCoh.respMhz * 60) / 1000
      : null;
  const pacerBpm = engineActive ? engineStatus!.pacerBpm : (lastEdgeCoh?.pacerBpm ?? 0);
  /* RMSSD + SDNN come from the worker pipeline (1 Hz updates). Null until the
   * worker has produced a result on the current beat source. */
  const rmssd = lastMetrics?.rmssd ?? null;
  const sdnn = lastMetrics?.sdnn ?? null;
  /* Live inter-beat interval for the IBI card readout, from whichever source is actually
   * reporting: the earclip exposes ibi_ms per beat; the H10 reports an RR array per notification,
   * so take its last RR. (Previously this read the earclip beat only, so it showed "— ms" for
   * H10-only users.) */
  const lastIbiMs =
    effectiveHrSource === 'h10'
      ? lastPolarBeat && lastPolarBeat.rr.length > 0
        ? lastPolarBeat.rr[lastPolarBeat.rr.length - 1]
        : null
      : lastBeat?.ibi_ms ?? null;

  const edgeConnected = edgeConn === 'connected';
  const hrConnected = polarConn === 'connected' || narbisConn === 'connected';
  /* Earclip is "connected" either directly (narbisConn) or via the
   * glasses-side BLE central relay (edge.earclipRelay === true). Both paths
   * deliver the filtered diagnostic stream the FilteredBeatChart renders,
   * so either one warrants showing that chart. H10 alone does not — Polar
   * exposes only beat events, no PPG. */
  const earclipConnected = narbisConn === 'connected' || edgeRelay === true;

  /* Local settings state — mirrored to the firmware via edgeDevice setters.
   * No read-back path from the glasses, so these default to reasonable
   * values; the user adjusts and we push. */
  const [difficulty, setDifficulty] = useState<CoherenceDifficulty>('easy');
  const [lensLimit, setLensLimit] = useState(100);
  const [adaptive, setAdaptive] = useState(true);
  const [strobeHz, setStrobeHz] = useState(10.0);

  /* Re-push lens limit + adaptive on every edge-connect since the
   * glasses' NVS may have a stale value the user reset elsewhere. */
  useEffect(() => {
    if (!edgeConnected) return;
    void edgeDevice.setLensLimitPct(lensLimit).catch(console.error);
    void edgeDevice.setAdaptivePacer(adaptive).catch(console.error);
    void edgeDevice.setDifficulty(difficulty).catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edgeConnected]);

  /* When the app-side engine is driving (Mode A/B/C), mirror the difficulty (gamma curve on
   * coherence → lens depth) into the engine — the edgeDevice.setDifficulty calls only affect
   * Standard (firmware) mode. Runs on engine start and whenever the difficulty changes. */
  useEffect(() => {
    if (engineActive) coherenceEngine.setDifficulty(DIFFICULTY_NUM[difficulty]);
  }, [engineActive, difficulty]);

  const commitStrobeHz = (hz: number): void => {
    setStrobeHz(hz);
    if (edgeConnected) {
      void edgeDevice.setStrobeFreqHz(hz).catch(console.error);
    }
  };

  /* Mobile mode clamps below the Tailwind `sm:` breakpoint so any
   * `sm:grid-cols-N` collapses to one column. Padding/gap also shrink
   * so the page feels native on a phone. The cinematic redesign uses a
   * slightly tighter `max-w-3xl` desktop so the ring + tint bar can sit
   * side-by-side without feeling cramped. */
  const containerClass = mobile
    ? 'max-w-md mx-auto p-3 space-y-4'
    : 'max-w-3xl mx-auto p-6 space-y-5';

  const progInfo = program != null ? PROGRAM_INFO[program] : null;
  const zone = cohZone(coh);
  /* The breathing cue + chime only make sense when the app-side engine owns the breath clock
   * (Mode A/B). In Standard mode the firmware drives the lens on a phase the dashboard can't
   * observe, so we hide them rather than show a cue that drifts out of sync with the glasses. */
  const showBreathUi = engineMode !== 'firmware';
  const headerTitle = engineActive
    ? engineMode === 'modeA'
      ? 'Mode A · Follow'
      : engineMode === 'modeB'
        ? 'Mode B · Resonance'
        : 'Mode C · Settle & Find'
    : (progInfo?.title ?? null);

  return (
    <div className="flex-1 overflow-auto bg-gradient-to-b from-slate-950 to-slate-900 text-slate-100">
      <div className={containerClass}>
        {/* Connection hint */}
        {(!edgeConnected || !hrConnected) && (
          <div className="rounded-xl border border-amber-700/40 bg-amber-900/15 p-4">
            <div className="text-amber-200 font-medium mb-1">Get started</div>
            <ol className="text-sm text-amber-100/80 space-y-0.5 list-decimal list-inside">
              {!hrConnected && <li>Connect a heart-rate source (Polar H10 or earclip) from the device pills above.</li>}
              {!edgeConnected && <li>Connect your Narbis Edge glasses from the device pills above.</li>}
              <li>Once both are green, pick a mode below.</li>
            </ol>
          </div>
        )}

        {/* ── Cinematic Live header ──────────────────────────────
            Small-caps "COHERENCE TRAINING" label, program title
            with a dynamic Inhale / Exhale cue (cyan italic-serif,
            paced by useBreathPhase so it stays in lockstep with the
            lens cycle), color-coded session clock, green LIVE chip. */}
        <LiveHeader programTitle={headerTitle} edgeConnected={edgeConnected} cohLive={coh != null} showBreathCue={showBreathUi} />

        {/* ── SessionControls ────────────────────────────────────
            Pause / End & Save / End (no save) — wired straight to
            the upstream store actions. Disabled until the first
            beat lands; End buttons disable once the session is
            ended. Lives outside LiveHeader so it can wrap onto its
            own row on mobile without crowding the clock. */}
        <SessionControls />

        {/* ── Engine mode ────────────────────────────────────────
            The 3 selectable modes: Standard (the glasses' built-in
            firmware programs) / Mode A (Follow) / Mode B (Resonance).
            Mode A/B run the app-side Coherence Engine, which takes
            over the lens. Sits up top so it's the first choice. */}
        <EngineModeStrip
          mode={engineMode}
          status={engineStatus}
          edgeConnected={edgeConnected}
          polarConnected={polarConn === 'connected'}
          onPick={(m) => void setEngineMode(m)}
        />

        {/* ── Breathing chime — on/off + inhale/exhale sound pickers. Shown only in Mode A/B;
            in Standard the firmware drives the lens and the chime can't be phase-locked to it. */}
        {showBreathUi && <ChimeControls />}

        {/* ── Hero: coherence ring + zone pill + lens tint bar ─── */}
        <section className="grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-5 items-center">
          <div className="flex justify-center sm:justify-start">
            <CoherenceRing score={coh} zone={zone} />
          </div>
          <div className="space-y-3">
            <ZonePill coh={coh} zone={zone} />
            {showBreathUi && <BreathCue hint={cohHint(coh)} />}
            {/* Tiny live readout under the bar: pacerBpm + respBpm. The
                full breath/HR cards are at the bottom of the view; this
                line keeps the hero from feeling sparse for users who
                haven't scrolled down yet. */}
            {(respBpm != null || pacerBpm > 0) && (
              <div className="text-[11px] text-slate-500">
                {pacerBpm > 0 && (
                  <>Pacer <span className="tabular-nums text-slate-300">{pacerBpm.toFixed(1)}</span> br/min</>
                )}
                {respBpm != null && pacerBpm > 0 && <span className="mx-2 text-slate-700">·</span>}
                {respBpm != null && (
                  <>Resp <span className="tabular-nums text-slate-300">{respBpm.toFixed(2)}</span> br/min</>
                )}
              </div>
            )}
          </div>
        </section>

        {/* ── Charts ─────────────────────────────────────────────
            Filtered PPG with peak markers (earclip only — H10 has
            no PPG stream), IBI tachogram, coherence-over-time. Each
            chart wrapped in cinematic card chrome. */}
        {earclipConnected && (
          <ChartCard title="Filtered Signal" valueLabel="PPG · peaks">
            <FilteredBeatChart compact windowSec={30} />
          </ChartCard>
        )}
        <ChartCard
          title="IBI · Beat-to-Beat"
          valueLabel={lastIbiMs != null ? `${Math.round(lastIbiMs)} ms` : '— ms'}
        >
          <BeatChart compact defaultSmoothN={7} defaultShape="spline" windowSec={30} />
        </ChartCard>
        <ChartCard
          title="Coherence · Over Time"
          valueLabel={coh != null ? `${Math.round(coh)}/100` : '—'}
        >
          <CoherenceChart compact windowSec={30} />
        </ChartCard>

        {/* Breathing wave from the H10 accelerometer — the independent respiration signal the
            search verifies each dwell against (Mode B), and the warm-up gate watches (Mode C).
            Both stream ACC. */}
        {(engineMode === 'modeB' || engineMode === 'modeC') && <AccChart windowSec={30} />}

        {/* ── Bottom metric strip ────────────────────────────────
            HEART (bpm) · BREATH (per min) · RMSSD (ms) · SDNN (ms).
            Compact cards with an uppercase label and tabular number.
            RMSSD + SDNN come from the metrics worker (1 Hz). */}
        <section className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
          <StatChip label="Heart"  value={hrBpm != null ? `${hrBpm}` : '—'}              unit="bpm" />
          <StatChip label="Breath" value={respBpm != null ? respBpm.toFixed(1) : '—'}    unit="/min" />
          <StatChip label="RMSSD"  value={rmssd != null ? `${Math.round(rmssd)}` : '—'} unit="ms" />
          <StatChip label="SDNN"   value={sdnn != null ? `${Math.round(sdnn)}` : '—'}   unit="ms" />
        </section>

        {/* ── Pick a mode strip ─────────────────────────────────
            Slim button row for the four programs. Replaces the
            wall-of-cards picker that used to sit above the live view.
            Active program glows in cyan to match the ring. */}
        <ProgramStrip
          program={program}
          onPick={(p) => void setActiveProgram(p)}
          disabled={!edgeConnected}
          engineActive={engineActive}
        />

        {/* ── Advanced (collapsed by default) ────────────────────
            Strobe frequency, lens settings, standalone modes. Lives
            under <details> so the lay user lands on a clean page and
            opens what they need. */}
        <details className="group rounded-xl border border-slate-800/80 bg-slate-900/40">
          <summary className="cursor-pointer select-none px-4 py-3 flex items-center justify-between text-sm text-slate-300 hover:text-slate-100 list-none [&::-webkit-details-marker]:hidden">
            <span className="tracking-[0.18em] uppercase text-xs">Advanced</span>
            <span className="text-xs text-slate-500 group-open:hidden">strobe · settings · standalone</span>
            <span className="text-cyan-300 text-xs hidden group-open:inline">close</span>
          </summary>
          <div className="px-4 pb-4 space-y-4 border-t border-slate-800/60">
            <StrobeSection
              strobeHz={strobeHz}
              setStrobeHz={setStrobeHz}
              commitStrobeHz={commitStrobeHz}
              edgeConnected={edgeConnected}
            />
            <SettingsSection
              difficulty={difficulty}
              setDifficulty={setDifficulty}
              lensLimit={lensLimit}
              setLensLimit={setLensLimit}
              adaptive={adaptive}
              setAdaptive={setAdaptive}
              edgeConnected={edgeConnected}
            />
            <StandaloneSection edgeConnected={edgeConnected} />
          </div>
        </details>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   LiveHeader — small-caps eyebrow, program title with a dynamic
   Inhale / Exhale cue, color-coded session clock + status, green
   LIVE chip. The clock color map mirrors upstream SessionTimer
   (emerald recording / amber paused / slate ended / slate idle).
   The Inhale/Exhale cue uses useBreathPhase so it stays in lockstep
   with whatever rate the firmware is pacing at.
   ────────────────────────────────────────────────────────────── */
function LiveHeader({
  programTitle,
  edgeConnected,
  cohLive,
  showBreathCue,
}: {
  programTitle: string | null;
  edgeConnected: boolean;
  cohLive: boolean;
  showBreathCue: boolean;
}) {
  /* Tick the clock once per second when active. Paused / ended states
   * are frozen so the interval is just wasted setState calls. */
  const sessionPaused = useDashboardStore((s) => s.sessionPaused);
  const sessionEnded = useDashboardStore((s) => s.sessionEnded);
  const [, setNow] = useState(Date.now());
  useEffect(() => {
    if (sessionPaused || sessionEnded) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [sessionPaused, sessionEnded]);

  const startTs = getSessionStartTs();
  const pausedAt = getSessionPausedAt();
  const endedAt = getSessionEndedAt();
  const pauseTotal = getSessionPauseTotalMs();
  let elapsedMs = 0;
  if (startTs != null) {
    const endRef = endedAt ?? pausedAt ?? Date.now();
    elapsedMs = Math.max(0, endRef - startTs - pauseTotal);
  }
  const totalSec = Math.floor(elapsedMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  const text = `${pad(h)}:${pad(m)}:${pad(s)}`;
  const active = startTs != null;

  const clockColor = sessionEnded
    ? 'text-slate-400'
    : sessionPaused
      ? 'text-amber-300'
      : active
        ? 'text-emerald-300'
        : 'text-slate-600';
  const statusLabel = sessionEnded
    ? 'session ended'
    : sessionPaused
      ? 'paused'
      : active
        ? 'recording beats'
        : 'waiting for first beat…';

  const breath = useBreathPhase();

  return (
    <header className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-[0.22em] text-slate-400">
          Coherence training
        </div>
        <h2 className="mt-0.5 text-2xl font-semibold text-slate-100 truncate">
          {programTitle ?? 'Pick a mode'}
          {edgeConnected && showBreathCue && (
            <span
              className="ml-2 font-serif italic font-normal text-cyan-300 transition-opacity duration-700"
              key={breath.phase}
            >
              {breath.phase === 'inhale' ? 'Inhale' : 'Exhale'}
            </span>
          )}
        </h2>
        <div className="mt-1 flex items-baseline gap-2">
          <span className={`font-mono text-base tabular-nums tracking-wider ${clockColor}`}>{text}</span>
          <span className="text-[11px] text-slate-500">{statusLabel}</span>
        </div>
      </div>
      <LiveChip live={edgeConnected && cohLive} />
    </header>
  );
}

/* Small LIVE pill — dim slate when the coherence pipeline isn't
 * producing frames yet, glowing emerald with a soft pulse once it is. */
function LiveChip({ live }: { live: boolean }) {
  return (
    <div
      className={
        'shrink-0 inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-medium tracking-wider uppercase ' +
        (live
          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
          : 'border-slate-700 bg-slate-800/60 text-slate-500')
      }
    >
      <span
        className={
          'h-1.5 w-1.5 rounded-full ' +
          (live ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500')
        }
      />
      Live
    </div>
  );
}

/* SessionControls — Pause / Resume, End & Save, End (no save).
 * Identical behavior to the upstream SessionTimer's button row;
 * just relocated and restyled to live as its own slim strip
 * outside the LiveHeader. */
function SessionControls() {
  const sessionPaused = useDashboardStore((s) => s.sessionPaused);
  const sessionEnded = useDashboardStore((s) => s.sessionEnded);
  const pauseSession = useDashboardStore((s) => s.pauseSession);
  const resumeSession = useDashboardStore((s) => s.resumeSession);
  const endSessionAndSave = useDashboardStore((s) => s.endSessionAndSave);
  const endSessionWithoutSaving = useDashboardStore((s) => s.endSessionWithoutSaving);

  const active = getSessionStartTs() != null;
  const controlsEnabled = active && !sessionEnded;

  const handleEndNoSave = () => {
    if (!controlsEnabled) return;
    if (window.confirm('Discard this session? Beats and coherence will be cleared and not saved.')) {
      endSessionWithoutSaving();
    }
  };

  return (
    <div className="flex flex-wrap gap-2">
      <button
        onClick={() => (sessionPaused ? resumeSession() : pauseSession())}
        disabled={!controlsEnabled}
        className={
          'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition disabled:opacity-40 disabled:cursor-not-allowed ' +
          (sessionPaused
            ? 'border-emerald-700/50 bg-emerald-900/20 text-emerald-200 hover:bg-emerald-800/40'
            : 'border-amber-700/50 bg-amber-900/20 text-amber-200 hover:bg-amber-800/40')
        }
        title={sessionPaused
          ? 'Resume — clock and beat recording continue'
          : 'Pause — clock stops and incoming beats are dropped until resumed'}
      >
        {sessionPaused ? (
          <>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            Resume
          </>
        ) : (
          <>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>
            Pause
          </>
        )}
      </button>
      <button
        onClick={endSessionAndSave}
        disabled={!controlsEnabled}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-indigo-700/50 bg-indigo-900/20 text-indigo-200 hover:bg-indigo-800/40 text-xs font-medium transition disabled:opacity-40 disabled:cursor-not-allowed"
        title="End session and open summary (auto-saves to cloud when signed in)"
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>
        End &amp; Save
      </button>
      <button
        onClick={handleEndNoSave}
        disabled={!controlsEnabled}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-rose-700/50 bg-rose-900/20 text-rose-200 hover:bg-rose-800/40 text-xs font-medium transition disabled:opacity-40 disabled:cursor-not-allowed"
        title="End and discard this session — no summary, no save"
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M6 6l12 12M18 6l-12 12"/></svg>
        End (no save)
      </button>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   CoherenceRing — animated SVG progress ring. Score is X/100
   (coh is 0–100). Stroke color shifts cyan → teal → emerald with
   the zone. Progress drives stroke-dashoffset directly, so the
   redraw is one attribute change per render — cheap enough to
   update on every coherence frame without throttling.
   ────────────────────────────────────────────────────────────── */
function CoherenceRing({
  score,
  zone,
}: {
  score: number | null;
  zone: CohZone | null;
}) {
  const R = 64;
  const STROKE = 10;
  const SIZE = 160;
  const CIRC = 2 * Math.PI * R;
  const pct = score != null ? Math.max(0, Math.min(1, score / 100)) : 0;
  const offset = CIRC * (1 - pct);
  const color = zoneColor(zone);
  return (
    <div className="relative" style={{ width: SIZE, height: SIZE }}>
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
        <defs>
          <filter id="ring-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={R}
          fill="none"
          stroke="#1e293b"
          strokeWidth={STROKE}
        />
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={R}
          fill="none"
          stroke={color}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={CIRC}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
          style={{ transition: 'stroke-dashoffset 600ms ease, stroke 400ms ease' }}
          filter="url(#ring-glow)"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="flex items-baseline">
          <span className="text-4xl font-semibold tabular-nums text-slate-50">
            {score != null ? Math.round(score) : '—'}
          </span>
          <span className="text-base text-slate-400 ml-0.5">/100</span>
        </div>
        <div className="text-[10px] tracking-[0.22em] uppercase text-slate-500 mt-0.5">
          Coherence
        </div>
      </div>
    </div>
  );
}

/* Coherence zone pill — "High coherence" / "Building" / "Settling"
 * with a colored dot. Same color story as the ring. */
function ZonePill({ coh, zone }: { coh: number | null; zone: CohZone | null }) {
  const label = coh != null ? cohLabel(coh) : 'Waiting for glasses';
  const color = zoneColor(zone);
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-slate-700/60 bg-slate-900/60 pl-2 pr-3 py-1.5">
      <span
        className="h-2 w-2 rounded-full"
        style={{ backgroundColor: color, boxShadow: `0 0 8px ${color}` }}
      />
      <span className="text-sm text-slate-200">{label}</span>
    </div>
  );
}

/* ChartCard — cinematic chrome around the Plotly chart components.
 * Header has a small-caps title on the left and a current-value
 * readout on the right (e.g. "891 ms" for IBI). Inside the body sits
 * the unmodified BeatChart / CoherenceChart / FilteredBeatChart — the
 * existing chart components already render their own border + plot
 * area, so the wrapper just adds an outer panel + cinematic header. */
function ChartCard({
  title, valueLabel, children,
}: {
  title: string;
  valueLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-slate-800/80 bg-slate-900/40 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-800/60">
        <div className="text-[11px] tracking-[0.2em] uppercase text-slate-400">{title}</div>
        {valueLabel && (
          <div className="text-sm tabular-nums text-slate-200">{valueLabel}</div>
        )}
      </div>
      <div className="p-2">{children}</div>
    </div>
  );
}

/* Bottom-strip stat chip — uppercase label, big tabular value, tiny
 * unit. Used for HEART / BREATH / RMSSD. */
function StatChip({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="rounded-xl border border-slate-800/80 bg-slate-900/60 px-3 py-3 flex flex-col items-start">
      <div className="text-[10px] tracking-[0.18em] uppercase text-slate-400">{label}</div>
      <div className="flex items-baseline gap-1 mt-1">
        <span className="text-2xl font-semibold tabular-nums text-slate-50">{value}</span>
        <span className="text-xs text-slate-500">{unit}</span>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   EngineModeStrip — the top-level 3-mode chooser: Standard (the
   glasses' firmware programs), Mode A (Follow), Mode B (Resonance).
   Mode A/B run the app-side Coherence Engine, which takes over the
   lens via 0xA5 duty. Shows a compact live readout when active.
   ────────────────────────────────────────────────────────────── */
function EngineModeStrip({
  mode, status, edgeConnected, polarConnected, onPick,
}: {
  mode: EngineMode;
  status: EngineStatus | null;
  edgeConnected: boolean;
  polarConnected: boolean;
  onPick: (m: EngineMode) => void;
}) {
  const active = mode !== 'firmware';
  const [infoMode, setInfoMode] = useState<EngineMode | null>(null);
  const info = infoMode != null ? ENGINE_MODE_INFO.find((x) => x.id === infoMode) ?? null : null;
  return (
    <section className="rounded-xl border border-slate-800/80 bg-slate-900/40 p-3">
      <div className="text-[10px] tracking-[0.18em] uppercase text-slate-400 mb-2">Engine</div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {ENGINE_MODE_INFO.map((o) => {
          const isActive = mode === o.id;
          return (
            <div key={o.id} className="relative">
              <button
                onClick={() => onPick(o.id)}
                title={o.desc}
                className={
                  'w-full rounded-lg px-3 py-2.5 pr-7 text-left border transition ' +
                  (isActive
                    ? 'border-indigo-400/60 bg-indigo-500/15 text-indigo-100 shadow-[0_0_20px_-8px_rgba(129,140,248,0.6)]'
                    : 'border-slate-700 bg-slate-800/40 text-slate-300 hover:border-slate-500 hover:text-slate-100')
                }
              >
                <div className="font-medium text-sm">{o.title}</div>
                <div className={'text-[10px] mt-0.5 ' + (isActive ? 'text-indigo-200' : 'text-slate-400')}>{o.sub}</div>
              </button>
              <button
                type="button"
                onClick={(ev) => { ev.stopPropagation(); setInfoMode(o.id); }}
                title={`What is ${o.title}?`}
                aria-label={`What is ${o.title}?`}
                className="absolute top-1 right-1 h-4 w-4 rounded-full border border-slate-500/70 text-slate-400 text-[10px] font-serif italic leading-none flex items-center justify-center hover:bg-slate-700 hover:text-slate-100"
              >
                i
              </button>
            </div>
          );
        })}
      </div>
      {active && !edgeConnected ? (
        <div className="mt-2 text-[11px] text-amber-300/90">Connect the glasses — the engine drives the lens over BLE.</div>
      ) : null}
      {mode === 'modeB' && !polarConnected ? (
        <div className="mt-2 text-[11px] text-amber-300/90">Mode B needs a Polar H10 (validated heartbeats + accelerometer for breath verification).</div>
      ) : null}
      {active && status?.running ? (
        <div className="mt-2 rounded-md border border-slate-800 bg-slate-950/40 px-2 py-1.5 text-[11px] text-slate-300 flex flex-col gap-1">
          <div className="flex flex-wrap gap-x-4 gap-y-0.5">
            <span>coherence <span className="text-emerald-400 font-medium">{Math.round(status.coherence)}/100</span></span>
            <span>pacing <span className="text-cyan-300">{status.pacerBpm.toFixed(1)}</span> br/min</span>
          </div>
          {mode === 'modeB' && status.modeBState ? (
            <div
              className={
                status.searchAborted
                  ? 'text-rose-400'
                  : status.modeBState === 'maintaining'
                    ? 'text-emerald-300'
                    : 'text-amber-300'
              }
            >
              {modeBStatusText(status)}
            </div>
          ) : mode === 'modeC' ? (
            <div
              className={
                status.modeCPhase === 'maintaining'
                  ? 'text-emerald-300'
                  : status.modeCPhase === 'searching'
                    ? 'text-amber-300'
                    : status.modeCAccConfident
                      ? 'text-cyan-300'
                      : 'text-slate-400'
              }
            >
              {modeCStatusText(status)}
            </div>
          ) : null}
        </div>
      ) : null}

      {info ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4"
          onClick={() => setInfoMode(null)}
        >
          <div
            className="max-w-md rounded-xl border border-slate-700 bg-slate-900 p-4 flex flex-col gap-2"
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="text-sm font-semibold text-slate-100">
              {info.title} <span className="text-slate-400 font-normal">· {info.sub}</span>
            </div>
            <p className="text-[13px] leading-relaxed text-slate-300">{info.details}</p>
            {info.references && info.references.length > 0 ? (
              <div className="mt-1 border-t border-slate-800 pt-2">
                <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">Based on</div>
                <ul className="list-disc list-inside text-[11px] leading-snug text-slate-400 space-y-1">
                  {info.references.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="flex justify-end pt-1">
              <button
                type="button"
                onClick={() => setInfoMode(null)}
                className="rounded bg-slate-700 hover:bg-slate-600 px-3 py-1 text-xs"
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/* Slim program-picker strip — replaces the four big mode cards. Active
 * program glows cyan to match the ring; the description hides behind a
 * tooltip on the button. */
function ProgramStrip({
  program, onPick, disabled, engineActive,
}: {
  program: PpgProgram | null;
  onPick: (p: PpgProgram) => void;
  disabled: boolean;
  engineActive: boolean;
}) {
  return (
    <section className="rounded-xl border border-slate-800/80 bg-slate-900/40 p-3">
      <div className="text-[10px] tracking-[0.18em] uppercase text-slate-400 mb-2">
        Standard programs
      </div>
      {engineActive ? (
        <div className="text-[11px] text-slate-500 mb-2">
          The Coherence Engine renders these app-side from your live coherence.
        </div>
      ) : null}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {([1, 2, 3, 4] as PpgProgram[]).map((p) => {
          const info = PROGRAM_INFO[p];
          const active = program === p;
          return (
            <button
              key={p}
              disabled={disabled}
              onClick={() => onPick(p)}
              title={info.desc}
              className={
                'rounded-lg px-3 py-2.5 text-left text-xs border transition disabled:opacity-50 ' +
                (active
                  ? 'border-cyan-400/60 bg-cyan-500/10 text-cyan-100 shadow-[0_0_20px_-8px_rgba(34,211,238,0.5)]'
                  : 'border-slate-700 bg-slate-800/40 text-slate-300 hover:border-slate-500 hover:text-slate-100')
              }
            >
              <div className="font-medium">{info.title}</div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/* ──────────────────────────────────────────────────────────────
   Advanced subsections — Strobe / Settings / Standalone. Same
   logic as before, restyled to share the cinematic chrome.
   ────────────────────────────────────────────────────────────── */

function StrobeSection({
  strobeHz, setStrobeHz, commitStrobeHz, edgeConnected,
}: {
  strobeHz: number;
  setStrobeHz: (n: number) => void;
  commitStrobeHz: (n: number) => void;
  edgeConnected: boolean;
}) {
  return (
    <section className={'space-y-2 pt-4 ' + (edgeConnected ? '' : 'opacity-60')}>
      <div className="text-[10px] tracking-[0.18em] uppercase text-slate-400">
        Strobe frequency
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-1">
        {STROBE_PRESETS.map((preset) => {
          const active = Math.abs(strobeHz - preset.hz) < 0.05;
          return (
            <button
              key={preset.label}
              disabled={!edgeConnected}
              onClick={() => commitStrobeHz(preset.hz)}
              className={
                'text-left rounded-md px-2 py-1.5 border text-xs disabled:opacity-50 transition ' +
                (active
                  ? 'border-cyan-400/60 bg-cyan-500/10 text-cyan-100'
                  : 'border-slate-700 bg-slate-800/40 text-slate-200 hover:border-slate-500')
              }
              title={`${preset.band} band`}
            >
              <div className="font-medium">{preset.label}</div>
              <div className="text-slate-400 text-[10px]">{preset.hz.toFixed(1)} Hz · {preset.band}</div>
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-3 pt-1">
        <input
          type="range"
          min={1.0}
          max={50.0}
          step={0.1}
          value={strobeHz}
          disabled={!edgeConnected}
          onChange={(e) => setStrobeHz(Number(e.target.value))}
          onMouseUp={(e) => commitStrobeHz(Number((e.target as HTMLInputElement).value))}
          onTouchEnd={(e) => commitStrobeHz(Number((e.target as HTMLInputElement).value))}
          onKeyUp={(e) => commitStrobeHz(Number((e.target as HTMLInputElement).value))}
          className="flex-1 accent-cyan-400 disabled:opacity-50"
        />
        <span className="text-sm tabular-nums w-16 text-right text-slate-200">{strobeHz.toFixed(1)} Hz</span>
      </div>
      <div className="text-[11px] text-slate-500 leading-snug">
        Strobe only flashes during the <span className="font-medium">Breath + Strobe</span> program.
        Brainwave bands are approximate — try a few and notice how each feels.
      </div>
    </section>
  );
}

function SettingsSection({
  difficulty, setDifficulty,
  lensLimit, setLensLimit,
  adaptive, setAdaptive,
  edgeConnected,
}: {
  difficulty: CoherenceDifficulty;
  setDifficulty: (d: CoherenceDifficulty) => void;
  lensLimit: number;
  setLensLimit: (n: number) => void;
  adaptive: boolean;
  setAdaptive: (b: boolean) => void;
  edgeConnected: boolean;
}) {
  return (
    <section className={'space-y-3 pt-4 border-t border-slate-800/60 ' + (edgeConnected ? '' : 'opacity-60')}>
      <div className="text-[10px] tracking-[0.18em] uppercase text-slate-400">
        Settings
      </div>

      <Row label="Difficulty" help="How responsive the lens is to changes in your coherence.">
        <div className="grid grid-cols-4 gap-1">
          {(['easy', 'medium', 'hard', 'expert'] as CoherenceDifficulty[]).map((d) => (
            <button
              key={d}
              disabled={!edgeConnected}
              onClick={() => {
                setDifficulty(d);
                void edgeDevice.setDifficulty(d).catch(console.error);
              }}
              className={
                'rounded-md px-2 py-1 text-xs disabled:opacity-50 transition ' +
                (difficulty === d
                  ? 'bg-cyan-500/20 text-cyan-100 border border-cyan-400/60'
                  : 'bg-slate-800/40 text-slate-200 border border-slate-700 hover:border-slate-500')
              }
            >
              {d.charAt(0).toUpperCase() + d.slice(1)}
            </button>
          ))}
        </div>
      </Row>

      <Row label="Max lens darkness" help="Caps how dark the lens can get. Lower if it feels too intense.">
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={lensLimit}
            disabled={!edgeConnected}
            onChange={(e) => setLensLimit(Number(e.target.value))}
            onMouseUp={(e) => edgeDevice.setLensLimitPct(Number((e.target as HTMLInputElement).value)).catch(console.error)}
            onTouchEnd={(e) => edgeDevice.setLensLimitPct(Number((e.target as HTMLInputElement).value)).catch(console.error)}
            onKeyUp={(e) => edgeDevice.setLensLimitPct(Number((e.target as HTMLInputElement).value)).catch(console.error)}
            className="flex-1 accent-cyan-400 disabled:opacity-50"
          />
          <span className="text-sm tabular-nums w-12 text-right text-slate-200">{lensLimit}%</span>
        </div>
      </Row>

      <Row
        label="Follow my breathing rate"
        help="When on, the breathing programs (Breathing Guide, Breath + Strobe) start at 6 br/min and adjust to your actual breathing rate. Turn off for a fixed 6 br/min pace."
      >
        <label className="inline-flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={adaptive}
            disabled={!edgeConnected}
            onChange={(e) => {
              setAdaptive(e.target.checked);
              void edgeDevice.setAdaptivePacer(e.target.checked).catch(console.error);
            }}
            className="accent-cyan-400"
          />
          <span className="text-sm text-slate-200">{adaptive ? 'On' : 'Off'}</span>
        </label>
      </Row>
    </section>
  );
}

/* Standalone modes — Static / Strobe / Breathe / Pulse on Beat. These
 * bypass the coherence pipeline entirely; they drive the lens directly
 * via the firmware's mode-switch opcodes (0xA5/0xA6/0xB0/0xB6). Pulse on
 * Beat still needs a heart-rate source. */
function StandaloneSection({ edgeConnected }: { edgeConnected: boolean }) {
  const standalone = useDashboardStore((s) => s.standaloneMode);
  const setStandalone = useDashboardStore((s) => s.setStandaloneMode);
  const [staticDuty, setStaticDuty] = useState(50);

  const STANDALONE_INFO: Array<{
    key: 'static' | 'strobe' | 'breathe' | 'pulse';
    title: string;
    desc: string;
  }> = [
    { key: 'static',  title: 'Solid Tint',     desc: 'Lens darkens to a fixed level. No motion.' },
    { key: 'breathe', title: 'Breathe (no HR)', desc: 'Lens guides 6 br/min breathing. No heart sensor needed.' },
    { key: 'strobe',  title: 'Strobe Only',    desc: 'Flashes at the Strobe Frequency set above. Brainwave entrainment.' },
    { key: 'pulse',   title: 'Pulse on Beat',  desc: 'Flashes once per detected heartbeat. Needs a heart sensor.' },
  ];

  return (
    <section className={'space-y-2 pt-4 border-t border-slate-800/60 ' + (edgeConnected ? '' : 'opacity-60')}>
      <div className="text-[10px] tracking-[0.18em] uppercase text-slate-400">
        Standalone (no HR sensor)
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {STANDALONE_INFO.map((s) => {
          const active = standalone === s.key;
          return (
            <button
              key={s.key}
              disabled={!edgeConnected}
              onClick={() => void setStandalone(s.key, s.key === 'static' ? staticDuty : undefined)}
              className={
                'text-left rounded-lg p-3 border transition disabled:opacity-50 ' +
                (active
                  ? 'border-cyan-400/60 bg-cyan-500/10 text-cyan-100'
                  : 'border-slate-700 bg-slate-800/40 text-slate-100 hover:border-slate-500')
              }
            >
              <div className="font-medium text-sm">{s.title}</div>
              <div className="text-xs text-slate-400 mt-1 leading-snug">{s.desc}</div>
            </button>
          );
        })}
      </div>
      {standalone === 'static' && (
        <Row label="Tint level" help="How dark the lens stays in Solid Tint mode.">
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={staticDuty}
              disabled={!edgeConnected}
              onChange={(e) => setStaticDuty(Number(e.target.value))}
              onMouseUp={(e) => {
                const v = Number((e.target as HTMLInputElement).value);
                void edgeDevice.setStandaloneStatic(v).catch(console.error);
              }}
              onTouchEnd={(e) => {
                const v = Number((e.target as HTMLInputElement).value);
                void edgeDevice.setStandaloneStatic(v).catch(console.error);
              }}
              onKeyUp={(e) => {
                const v = Number((e.target as HTMLInputElement).value);
                void edgeDevice.setStandaloneStatic(v).catch(console.error);
              }}
              className="flex-1 accent-cyan-400 disabled:opacity-50"
            />
            <span className="text-sm tabular-nums w-12 text-right text-slate-200">{staticDuty}%</span>
          </div>
        </Row>
      )}
    </section>
  );
}

function Row({
  label, help, children,
}: {
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <div className="text-sm text-slate-200">{label}</div>
      </div>
      {children}
      {help && <div className="text-[11px] text-slate-500 mt-1 leading-snug">{help}</div>}
    </div>
  );
}
