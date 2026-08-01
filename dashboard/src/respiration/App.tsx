/*
 * App.tsx — Respiration Analysis shell.
 *
 * Layout order is deliberate: devices, then the numbers as they stand right
 * now, then the one filter row that scopes every chart, then the charts
 * themselves, then the export and the raw table. Anything that changes what all
 * three charts show lives in that single row — per-chart controls only change
 * how one signal is conditioned, never which slice of time is on screen.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { respirationSession, type SessionState, type SessionEventDetail } from './session';
import { demoRequested, startDemo, type DemoHandle } from './demo';
import { sessionLog, type MetricRow } from './log';
import { useSettings, VIEW_WINDOWS, ANALYSIS_WINDOWS } from './settings';
import { Segmented, Select, Info, fmt } from './ui';
import CardiacChart from './CardiacChart';
import IbiChart from './IbiChart';
import AccChart from './AccChart';
import EcgChart from './EcgChart';
import DiaphragmChart from './DiaphragmChart';
import {
  downloadText,
  downloadZip,
  estimateBytes,
  sessionStamp,
  writeAccCSV,
  writeBeatsCSV,
  writeMetricsCSV,
  writeEcgCSV,
} from './csv';

const MAX_LOG_LINES = 200;

export default function App(): ReactNode {
  const [state, setState] = useState<SessionState>(() => respirationSession.getState());
  const [latest, setLatest] = useState<MetricRow | null>(null);
  const [events, setEvents] = useState<SessionEventDetail[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [showTable, setShowTable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ecgBusy, setEcgBusy] = useState(false);
  // Drives the live readouts in the chart headers. The plots redraw themselves
  // on rAF; this only refreshes the numbers beside the labels.
  const [, setTick] = useState(0);

  const settings = useSettings();

  useEffect(() => {
    const onState = (ev: Event): void => setState((ev as CustomEvent<SessionState>).detail);
    const onMetric = (ev: Event): void => setLatest((ev as CustomEvent<MetricRow>).detail);
    const onLog = (ev: Event): void => {
      const d = (ev as CustomEvent<SessionEventDetail>).detail;
      setEvents((prev) => [d, ...prev].slice(0, MAX_LOG_LINES));
    };
    const onTruncated = (): void => setTruncated(true);

    respirationSession.addEventListener('state', onState);
    respirationSession.addEventListener('metric', onMetric);
    respirationSession.addEventListener('log', onLog);
    sessionLog.addEventListener('truncated', onTruncated);
    respirationSession.start();

    // ?demo=1 — synthetic H10, so the UI and the whole analysis chain can be
    // exercised with no hardware. Started after the session so its 'connected'
    // event is heard.
    let demo: DemoHandle | null = null;
    if (demoRequested()) {
      respirationSession.setDemo(true);
      demo = startDemo();
    }

    const readoutTimer = setInterval(() => setTick((t) => t + 1), 500);

    return () => {
      clearInterval(readoutTimer);
      demo?.stop();
      respirationSession.removeEventListener('state', onState);
      respirationSession.removeEventListener('metric', onMetric);
      respirationSession.removeEventListener('log', onLog);
      sessionLog.removeEventListener('truncated', onTruncated);
      respirationSession.stop();
    };
  }, []);

  // Keep the session's analysis settings in step with the control row.
  useEffect(() => {
    respirationSession.setAnalysisWindowSec(settings.analysisWindowSec);
  }, [settings.analysisWindowSec]);
  useEffect(() => {
    respirationSession.setAnalysisSource(settings.analysisSource);
  }, [settings.analysisSource]);

  const manifestExtras = useCallback(
    () => ({
      polarName: state.polarName,
      earclipName: state.earclipName,
      lowerName: state.lowerName,
      analysisSource: state.analysisSource,
      analysisWindowSec: state.analysisWindowSec,
      buildId: __BUILD_ID__,
      demo: state.demo,
    }),
    [state],
  );

  const stamp = sessionStamp(sessionLog);
  const hasData = !sessionLog.isEmpty;

  const onDownloadAll = async (): Promise<void> => {
    setBusy(true);
    try {
      await downloadZip(sessionLog, manifestExtras());
    } finally {
      setBusy(false);
    }
  };

  const onClear = (): void => {
    if (!window.confirm('Discard the recorded session? Every logged beat, accelerometer sample and metric row is deleted. Download first if you need it.')) {
      return;
    }
    sessionLog.clear();
    setLatest(null);
    setTruncated(false);
  };

  const bytes = estimateBytes(sessionLog);
  const durationSec = sessionLog.durationMs / 1000;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 13c2.5 0 3-5 5.5-5S11 18 13.5 18 17 13 19 13h3" />
          </svg>
          <div>
            <h1>Respiration Analysis</h1>
            <div className="sub">edge-earclip · build {__BUILD_ID__}</div>
          </div>
        </div>

        <StatusPill
          label={state.polarName ?? 'Polar H10'}
          status={state.polar}
          detail={state.accStreaming ? 'ACC streaming' : state.polar === 'connected' ? 'no ACC' : undefined}
        />
        {state.polar === 'connected' ? (
          <button className="btn" onClick={() => void respirationSession.disconnectPolar()}>
            Disconnect H10
          </button>
        ) : (
          <>
            <button
              className="btn primary"
              disabled={state.polar === 'connecting'}
              onClick={() => void respirationSession.connectPolar().catch(() => {})}
            >
              {state.polar === 'connecting'
                ? 'Connecting…'
                : state.polarName
                  ? `Reconnect ${state.polarName}`
                  : 'Connect Polar H10'}
            </button>
            {state.polarName && state.polar !== 'connecting' && (
              <button
                className="btn sm"
                title="Forget this strap and choose a different one"
                onClick={() => respirationSession.forgetPolar()}
              >
                Change
              </button>
            )}
          </>
        )}

        <StatusPill
          label={state.lowerName ?? 'Lower strap'}
          status={state.lower}
          detail={state.lowerAccStreaming ? 'ACC streaming' : undefined}
        />
        {state.lower === 'connected' ? (
          <button className="btn" onClick={() => void respirationSession.disconnectLower()}>
            Disconnect lower
          </button>
        ) : (
          <>
            <button
              className="btn"
              disabled={state.lower === 'connecting'}
              onClick={() => void respirationSession.connectLower().catch(() => {})}
            >
              {state.lower === 'connecting'
                ? 'Connecting…'
                : state.lowerName
                  ? `Reconnect ${state.lowerName}`
                  : 'Connect lower strap'}
            </button>
            {state.lowerName && state.lower !== 'connecting' && (
              <button
                className="btn sm"
                title="Forget this strap and choose a different one"
                onClick={() => respirationSession.forgetLower()}
              >
                Change
              </button>
            )}
          </>
        )}

        <StatusPill label={state.earclipName ?? 'Earclip'} status={state.earclip} />
        {state.earclip === 'connected' ? (
          <button className="btn" onClick={() => void respirationSession.disconnectEarclip()}>
            Disconnect earclip
          </button>
        ) : (
          <button className="btn" onClick={() => void respirationSession.connectEarclip().catch(() => {})}>
            Connect earclip
          </button>
        )}

        <a className="home-link" href="./index.html">
          ← Dev hub
        </a>
      </header>

      {state.demo && (
        <div className="banner warn">
          <WarnIcon />
          <div>
            <strong>Demo mode.</strong> The heart rate, IBIs and accelerometer traces below are a
            synthetic signal generated in the browser — no device is connected and nothing here is a
            measurement of anyone. Exports made in this mode are labelled as synthetic in the
            manifest. Reload without <code>?demo=1</code> to use a real Polar H10.
          </div>
        </div>
      )}

      {!state.demo && !navigator.bluetooth && (
        <div className="banner warn">
          <WarnIcon />
          <div>
            This browser has no Web Bluetooth, so no device can be connected. Use Chrome, Edge or
            Brave on desktop or Android. Firefox and iOS Safari do not support it.
          </div>
        </div>
      )}

      {events.some((e) => e.level === 'error' && /connect|session|strap/i.test(e.message)) &&
        state.polar !== 'connected' && (
          <div className="banner info">
            <WarnIcon />
            <div>
              <strong>Strap not connecting?</strong> A Polar H10 only advertises while it is being
              worn with <em>damp</em> electrodes — a dry strap on a desk is invisible to the browser.
              It also accepts one connection at a time, so close the Polar app on your phone and any
              other tab holding it. Retries now happen automatically and the strap is remembered, so
              pressing Reconnect goes straight back to it without the chooser.
            </div>
          </div>
        )}

      {truncated && (
        <div className="banner warn">
          <WarnIcon />
          <div>
            The session log hit its capacity and has stopped accepting new samples. Everything
            captured so far is intact — download it, then clear the session to start recording again.
          </div>
        </div>
      )}

      <div className="stats">
        <Stat k="Session" v={formatDuration(durationSec)} />
        <Stat
          k="Heart rate"
          v={fmt(latest?.meanHr, 0)}
          unit="bpm"
          info="Mean over the analysis window."
        />
        <Stat k="RMSSD" v={fmt(latest?.rmssd, 1)} unit="ms" />
        <Stat k="SDNN" v={fmt(latest?.sdnn, 1)} unit="ms" />
        <Stat
          k="Coherence"
          v={fmt(latest?.engineCoherence, 1)}
          info="Live output of the app-side Coherence Engine, 0–100."
        />
        <Stat
          k="Respiration"
          v={fmt(latest?.accRespBpm ?? (latest?.engineRespHz != null ? latest.engineRespHz * 60 : null), 1)}
          unit="br/min"
          info="Measured from the H10 accelerometer when available, otherwise inferred from the tachogram."
        />
        <Stat k="Beats" v={String(sessionLog.beatCount)} />
        <Stat k="ACC samples" v={String(sessionLog.accCount('main'))} />
        {(state.lower !== 'disconnected' || sessionLog.accCount('lower') > 0) && (
          <Stat k="ACC lower" v={String(sessionLog.accCount('lower'))} />
        )}
        <Stat k="ECG samples" v={String(sessionLog.ecg.t.length)} />
      </div>

      {/* One filter row, above everything it scopes. */}
      <section className="card">
        <div className="shaping" style={{ borderTop: 'none' }}>
          <Segmented
            label="View window"
            value={settings.viewWindowSec}
            options={VIEW_WINDOWS}
            onChange={settings.setViewWindowSec}
            info="How much time every chart shows at once. This is a view control — it does not change how any metric is computed."
          />
          <div className="sep" />
          <Segmented
            label="Playback"
            value={settings.follow ? 'live' : 'paused'}
            options={[
              { value: 'live', label: 'Live' },
              { value: 'paused', label: 'Paused' },
            ]}
            onChange={(v) => settings.setFollow(v === 'live')}
            info="Pausing stops the x-axis from tracking the clock and unlocks pan, zoom and box-select on every chart. Recording continues either way."
          />
          <div className="sep" />
          <Select
            label="Analysis window"
            value={settings.analysisWindowSec}
            options={ANALYSIS_WINDOWS}
            onChange={settings.setAnalysisWindowSec}
            info="How many seconds of beats each 1 Hz metric is computed over. Longer is steadier but slower to respond. Note the Coherence Engine and the firmware-port coherence each keep their own fixed 64 s window, so only the time-domain and Lomb-Scargle metrics follow this setting."
          />
          <Select
            label="Source"
            value={settings.analysisSource}
            options={[
              { value: 'h10', label: 'Polar H10' },
              { value: 'earclip', label: 'Narbis earclip' },
            ]}
            onChange={settings.setAnalysisSource}
            info="Which device's beats feed the HRV metrics and the Coherence Engine. Both devices are always logged regardless. The breath–heart coherence needs the H10, because only the H10 measures the breath directly."
          />
          {settings.analysisSource === 'earclip' && (
            <span className="hint">
              With the earclip as the source, the engine has no accelerometer channel — respiration
              is inferred from the tachogram alone, and breath–heart γ² stays empty.
            </span>
          )}
        </div>
      </section>

      <CardiacChart latest={latest} />
      <IbiChart />
      <DiaphragmChart
        chestConnected={
          settings.chestStrap === 'main' ? state.accStreaming : state.lowerAccStreaming
        }
        abdoConnected={
          settings.chestStrap === 'main' ? state.lowerAccStreaming : state.accStreaming
        }
      />

      <AccChart
        strap="main"
        title="Polar H10 accelerometer"
        subtitle="main strap"
        streaming={state.accStreaming}
        connected={state.polar === 'connected'}
      />
      {(state.lower !== 'disconnected' || sessionLog.accCount('lower') > 0) && (
        <AccChart
          strap="lower"
          title="Polar H10 accelerometer"
          subtitle="lower strap"
          streaming={state.lowerAccStreaming}
          connected={state.lower === 'connected'}
        />
      )}
      <EcgChart
        streaming={state.ecgStreaming}
        busy={ecgBusy}
        onToggle={(on) => {
          setEcgBusy(true);
          const done = (): void => setEcgBusy(false);
          if (on) {
            void respirationSession.startEcg().then(done, done);
          } else {
            void respirationSession.stopEcg().then(done, done);
          }
        }}
      />

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">
            Recorded data
            <Info text="Logging is continuous and starts as soon as a device connects — there is no record button to forget. Exports are always the raw log; the display filters never touch them." />
          </h2>
          <span className="pill">
            {sessionLog.metrics.length} metric rows · {(bytes / 1e6).toFixed(1)} MB buffered
          </span>
        </div>

        <div className="shaping" style={{ borderTop: 'none' }}>
          <button
            className="btn primary"
            disabled={!hasData || busy}
            onClick={() => void onDownloadAll()}
          >
            {busy ? 'Packaging…' : 'Download all (ZIP)'}
          </button>
          <div className="sep" />
          <button
            className="btn"
            disabled={sessionLog.metrics.length === 0}
            onClick={() => downloadText(writeMetricsCSV(sessionLog), `respiration-${stamp}-metrics.csv`)}
          >
            metrics_1hz.csv
          </button>
          <button
            className="btn"
            disabled={sessionLog.beatCount === 0}
            onClick={() => downloadText(writeBeatsCSV(sessionLog), `respiration-${stamp}-beats.csv`)}
          >
            beats.csv
          </button>
          <button
            className="btn"
            disabled={sessionLog.accCount('main') === 0}
            onClick={() =>
              downloadText(writeAccCSV(sessionLog, 'main'), `respiration-${stamp}-acc.csv`)
            }
          >
            acc_samples.csv
          </button>
          {sessionLog.accCount('lower') > 0 && (
            <button
              className="btn"
              onClick={() =>
                downloadText(
                  writeAccCSV(sessionLog, 'lower'),
                  `respiration-${stamp}-acc-lower.csv`,
                )
              }
            >
              acc_lower_samples.csv
            </button>
          )}
          <button
            className="btn"
            disabled={sessionLog.ecg.t.length === 0}
            onClick={() => downloadText(writeEcgCSV(sessionLog), `respiration-${stamp}-ecg.csv`)}
          >
            ecg_samples.csv
          </button>
          <div className="sep" />
          <button className="btn sm" onClick={() => setShowTable((v) => !v)}>
            {showTable ? 'Hide table' : 'Table view'}
          </button>
          <button className="btn danger sm" disabled={!hasData} onClick={onClear}>
            Clear session
          </button>
          <span className="hint">
            Every CSV carries an absolute epoch timestamp and a session-relative seconds column, so
            rows line up against another recorder or against each other.
          </span>
        </div>

        {showTable && <MetricsTable />}
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Event log</h2>
        </div>
        {events.length === 0 ? (
          <div className="empty">Nothing yet. Connect a device to begin.</div>
        ) : (
          <div className="log">
            {events.map((e, i) => (
              <div key={`${e.timestamp}-${i}`} className={`log-row log-${e.level}`}>
                <span className="t">{new Date(e.timestamp).toLocaleTimeString()}</span>
                <span>{e.message}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/** The chart's WCAG-clean twin: the same numbers, readable without color. */
function MetricsTable(): ReactNode {
  const rows = sessionLog.metrics.slice(-200).reverse();
  if (rows.length === 0) {
    return <div className="empty">No metric rows yet.</div>;
  }
  const t0 = sessionLog.startedAt ?? 0;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Time</th>
            <th>Session s</th>
            <th>Beats</th>
            <th>HR bpm</th>
            <th>RMSSD ms</th>
            <th>SDNN ms</th>
            <th>Coherence</th>
            <th>Resp br/min</th>
            <th>LF/HF</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.t}>
              <td>{new Date(r.t).toLocaleTimeString()}</td>
              <td>{((r.t - t0) / 1000).toFixed(0)}</td>
              <td>{r.beatCount}</td>
              <td>{fmt(r.meanHr, 1)}</td>
              <td>{fmt(r.rmssd, 1)}</td>
              <td>{fmt(r.sdnn, 1)}</td>
              <td>{fmt(r.engineCoherence, 1)}</td>
              <td>{fmt(r.accRespBpm ?? (r.engineRespHz != null ? r.engineRespHz * 60 : null), 2)}</td>
              <td>{fmt(r.lfHfRatio, 2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Stat({
  k,
  v,
  unit,
  info,
}: {
  k: string;
  v: string;
  unit?: string;
  info?: string;
}): ReactNode {
  const dim = v === '—';
  return (
    <div className="stat">
      <div className="k">
        {k}
        {info && <Info text={info} />}
      </div>
      <div className={`v${dim ? ' dim' : ''}`}>
        {v}
        {unit && !dim && <span className="u">{unit}</span>}
      </div>
    </div>
  );
}

function StatusPill({
  label,
  status,
  detail,
}: {
  label: string;
  status: SessionState['polar'];
  detail?: string;
}): ReactNode {
  const cls =
    status === 'connected' ? 'on' : status === 'connecting' || status === 'reconnecting' ? 'wait' : 'off';
  return (
    <span className="pill">
      <span className={`dot ${cls}`} aria-hidden="true" />
      {label}
      {status !== 'connected' && <span style={{ color: 'var(--muted)' }}>· {status}</span>}
      {detail && <span style={{ color: 'var(--muted)' }}>· {detail}</span>}
    </span>
  );
}

function WarnIcon(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function formatDuration(sec: number): string {
  if (sec <= 0) return '0:00';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}
