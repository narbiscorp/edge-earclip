/*
 * DiaphragmChart.tsx — dual-strap diaphragmatic activation and biofeedback.
 *
 * Chest and abdomen traces on one plot (they share a unit and the whole point
 * is their relative amplitude and timing, so here they DO belong on one axis),
 * a balance bar, and the live classification.
 *
 * The classification is a claim about how someone is breathing, so the card
 * shows what it is based on — the two peak-to-peak amplitudes, the phase angle,
 * the breath period, and the correlation the phase was measured at. A low
 * correlation means the phase angle is not describing a shared rhythm, and the
 * card says so rather than printing a confident number.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Data } from 'plotly.js';
import { sessionLog, type StrapId } from './log';
import {
  analyseDualStreams,
  balancePosition,
  chooseAxis,
  peakToPeak,
  AXIS_ORIENTATION_WARN_MG,
  MIN_CLASSIFY_CORRELATION,
  DEFAULT_DIAPHRAGM_OPTIONS,
  PHASE_PARADOXICAL_DEG,
  PHASE_SYNCHRONOUS_DEG,
  RATIO_DIAPHRAGMATIC,
  RATIO_THORACIC,
  type AccAxis,
  type AxisQuality,
  type Classification,
  type DiaphragmResult,
} from './diaphragm';
import { removeBaseline } from './dsp';
import { useAnalysisPlot } from './plot';
import { SERIES, INK, CLASSIFICATION, baseLayout, axisStyle } from './theme';
import { useSettings } from './settings';
import { Info, Select, Segmented, fmt } from './ui';
import CalibrationPanel from './CalibrationPanel';
import BodyFigure from './BodyFigure';
import { assessPosture, type PostureStatus } from './posture';
import { matchBreathing, learnedThresholds } from './calibration';

const CALIBRATION_MS = 10_000;
/** Below this the phase angle is not describing a shared rhythm. */
const PHASE_TRUST_CORRELATION = 0.35;

const LABELS: Record<Classification, string> = {
  DIAPHRAGMATIC: 'Diaphragmatic',
  BALANCED: 'Balanced',
  THORACIC: 'Thoracic',
  PARADOXICAL: 'Paradoxical warning',
  UNKNOWN: 'Waiting for both straps',
};

const BLURB: Record<Classification, string> = {
  DIAPHRAGMATIC: 'Belly leading — deep abdominal engagement.',
  BALANCED: 'Chest and belly expanding together.',
  THORACIC: 'Shallow upper-chest breathing.',
  PARADOXICAL: 'Abdomen moving opposite the chest. Check strap placement before reading anything into this.',
  UNKNOWN: 'Needs both straps streaming for a few breaths.',
};

export default function DiaphragmChart({
  chestConnected,
  abdoConnected,
}: {
  chestConnected: boolean;
  abdoConnected: boolean;
}): ReactNode {
  const settings = useSettings();
  const {
    chestStrap,
    setChestStrap,
    diaphragmAxis,
    setDiaphragmAxis,
    diaphragmView,
    setDiaphragmView,
    calibChest,
    calibAbdo,
    setCalibration,
  } = settings;
  const abdoStrap: StrapId = chestStrap === 'main' ? 'lower' : 'main';

  const [result, setResult] = useState<DiaphragmResult | null>(null);
  const [axisPick, setAxisPick] = useState<AxisQuality | null>(null);
  const [posture, setPosture] = useState<PostureStatus | null>(null);
  const [calibratingUntil, setCalibratingUntil] = useState<number | null>(null);
  const [, setTick] = useState(0);

  const viewRef = useRef(settings.viewWindowSec);
  viewRef.current = settings.viewWindowSec;
  const followRef = useRef(settings.follow);
  followRef.current = settings.follow;
  const viewModeRef = useRef(diaphragmView);
  viewModeRef.current = diaphragmView;
  // The latest analysis, so the plot's pull() can draw the aligned traces
  // without recomputing them at frame rate.
  const resultRef = useRef<DiaphragmResult | null>(null);
  /** Bumped each time a new analysis lands, so the plot knows to rebuild. */
  const analysisSeq = useRef(0);
  /** Axis the auto picker settled on, for the calibration routine. */
  const axisPickRef = useRef<AccAxis | null>(null);
  // Switching overlay/differential changes the traces without new data arriving.
  useEffect(() => {
    analysisSeq.current += 1;
  }, [diaphragmView]);

  const optsRef = useRef({
    chestStrap,
    abdoStrap,
    diaphragmAxis,
    calibChest,
    calibAbdo,
    postureReference: settings.postureReference,
  });
  optsRef.current = {
    chestStrap,
    abdoStrap,
    diaphragmAxis,
    calibChest,
    calibAbdo,
    postureReference: settings.postureReference,
  };

  // Analysis runs at 2 Hz, not at frame rate: it resamples, detrends and
  // cross-correlates a whole window, which is far too much to redo 8 times a
  // second for a number that moves on the timescale of a breath.
  useEffect(() => {
    const run = (): void => {
      const o = optsRef.current;
      const now = Date.now();
      const win = Math.min(120, Math.max(30, viewRef.current));
      const opts = {
        ...DEFAULT_DIAPHRAGM_OPTIONS,
        calibChest: o.calibChest,
        calibAbdo: o.calibAbdo,
      };
      const grab = (strap: StrapId, ax: AccAxis) => sessionLog.accWindow(strap, win, now, ax);

      // 'auto' asks which axis the two straps are actually comparable on,
      // rather than assuming they were mounted identically.
      let axis: AccAxis;
      if (o.diaphragmAxis === 'auto') {
        const pick = chooseAxis(
          (['x', 'y', 'z'] as const).map((ax) => ({
            axis: ax,
            chest: grab(o.chestStrap, ax),
            abdo: grab(o.abdoStrap, ax),
          })),
          opts,
        );
        setAxisPick(pick);
        axisPickRef.current = pick?.axis ?? null;
        axis = pick?.axis ?? 'z';
      } else {
        axis = o.diaphragmAxis;
        setAxisPick(null);
      }

      const chest = grab(o.chestStrap, axis);
      const abdo = grab(o.abdoStrap, axis);
      const r = analyseDualStreams(chest, abdo, opts);

      setPosture(
        assessPosture(
          sessionLog.accMeanVector(o.chestStrap, 3, now),
          sessionLog.accMeanVector(o.abdoStrap, 3, now),
          o.postureReference,
        ),
      );
      resultRef.current = r;
      analysisSeq.current += 1;
      setResult(r);
    };
    run();
    const id = setInterval(run, 500);
    return () => clearInterval(id);
  }, []);

  // Calibration: capture 10 s, then take each strap's peak-to-peak over exactly
  // that span as its scale factor. Two deep breaths give the two straps a
  // common reference, which is what makes the ratio comparable between people
  // and between sessions.
  useEffect(() => {
    if (calibratingUntil == null) return;
    const remaining = calibratingUntil - Date.now();
    const finish = setTimeout(() => {
      const o = optsRef.current;
      const now = Date.now();
      const sec = CALIBRATION_MS / 1000;
      const ax: AccAxis = o.diaphragmAxis === 'auto' ? (axisPickRef.current ?? 'z') : o.diaphragmAxis;
      const c = sessionLog.accWindow(o.chestStrap, sec, now, ax);
      const a = sessionLog.accWindow(o.abdoStrap, sec, now, ax);
      const cP = peakToPeak(removeBaseline(c.x, c.y, DEFAULT_DIAPHRAGM_OPTIONS.detrendSec));
      const aP = peakToPeak(removeBaseline(a.x, a.y, DEFAULT_DIAPHRAGM_OPTIONS.detrendSec));
      // Refuse to store a degenerate factor — dividing by it later would produce
      // an infinite ratio that looks like a spectacular result.
      if (cP != null && aP != null && cP > 0.5 && aP > 0.5) {
        setCalibration(cP, aP);
      }
      setCalibratingUntil(null);
    }, Math.max(0, remaining));
    const ticker = setInterval(() => setTick((t) => t + 1), 250);
    return () => {
      clearTimeout(finish);
      clearInterval(ticker);
    };
  }, [calibratingUntil, setCalibration]);

  const layout = useMemo(
    () =>
      baseLayout({
        margin: { l: 62, r: 16, t: 4, b: 30 },
        xaxis: axisStyle('x', {
          showspikes: true,
          spikemode: 'across',
          spikethickness: 1,
          spikecolor: INK.muted,
          spikedash: 'dot',
        }),
        yaxis: axisStyle('y', {
          title: { text: 'mG, baseline removed', font: { color: INK.muted, size: 11 } },
        }),
        showlegend: false,
      }),
    [],
  );

  const divRef = useAnalysisPlot({
    key: 'diaphragm',
    baseLayout: layout,
    follow: () => followRef.current,
    windowSec: () => viewRef.current,
    refreshHz: 20,
    exportName: 'narbis-diaphragm',
    seq: () => analysisSeq.current,
    pull: () => {
      const r = resultRef.current;
      if (!r || r.t.length === 0) return { traces: [] };
      const x = r.t.map((t) => new Date(t));
      const traces: Data[] =
        viewModeRef.current === 'differential'
          ? [
              {
                x,
                y: r.differential,
                type: 'scattergl',
                mode: 'lines',
                name: 'Abdomen − chest',
                line: { color: SERIES.s3, width: 1.6 },
                hovertemplate: 'differential: %{y:.1f} mG<extra></extra>',
              } as Data,
            ]
          : [
              {
                x,
                y: r.chest,
                type: 'scattergl',
                mode: 'lines',
                name: 'Chest',
                line: { color: SERIES.s1, width: 1.6 },
                hovertemplate: 'chest: %{y:.1f} mG<extra></extra>',
              } as Data,
              {
                x,
                y: r.abdo,
                type: 'scattergl',
                mode: 'lines',
                name: 'Abdomen',
                line: { color: SERIES.s2, width: 1.6 },
                hovertemplate: 'abdomen: %{y:.1f} mG<extra></extra>',
              } as Data,
            ];
      return { traces };
    },
  });

  const learned = matchBreathing(settings.calibrationModel, result?.ratio ?? null);
  const learnedBounds = learnedThresholds(settings.calibrationModel);
  const cls: Classification = result?.classification ?? 'UNKNOWN';
  const color = CLASSIFICATION[cls];
  const pos = balancePosition(result?.ratio ?? null);
  const bothLive = chestConnected && abdoConnected;
  const phaseTrusted =
    result?.correlation != null && result.correlation >= PHASE_TRUST_CORRELATION;
  const calibrated = calibChest !== 1 || calibAbdo !== 1;
  const calibRemaining =
    calibratingUntil != null ? Math.max(0, Math.ceil((calibratingUntil - Date.now()) / 1000)) : 0;

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">
          Diaphragmatic activation
          <Info text="Compares chest against abdominal movement to tell diaphragmatic breathing from shallow thoracic breathing. Both straps are baseline-removed and put on one common time grid first, because the two devices have independent clocks — cross-correlating their raw samples would measure the gap between two BLE streams rather than between two parts of a torso." />
        </h2>
        <span
          className="pill"
          style={{
            borderColor: color,
            color,
            fontWeight: 650,
            // A misaligned pair cannot support a confident claim, and this one
            // reads as clinical. Show it muted and say it is provisional rather
            // than letting it look like a finding.
            opacity: posture?.state === 'misaligned' ? 0.55 : 1,
          }}
          title={BLURB[cls]}
        >
          <span className="dot" style={{ background: color, boxShadow: `0 0 0 3px ${color}22` }} />
          {LABELS[cls].toUpperCase()}
          {posture?.state === 'misaligned' && ' · PROVISIONAL'}
        </span>
      </div>

      <CalibrationPanel
        chestStrap={chestStrap}
        abdoStrap={abdoStrap}
        axis={(axisPick?.axis ?? (diaphragmAxis === 'auto' ? 'z' : diaphragmAxis)) as AccAxis}
        bothLive={bothLive}
      />

      {axisPick && axisPick.gravityDeltaMg > AXIS_ORIENTATION_WARN_MG && (
        <div className="card-note" style={{ color: '#fde68a' }}>
          The straps are rotated differently — their gravity readings differ by{' '}
          {Math.round(axisPick.gravityDeltaMg)} mG on the axis in use. Auto has picked the axis they
          agree on best; a phase angle from a mismatched axis measures strap placement, not
          breathing.
        </div>
      )}

      {result?.correlation != null &&
        Math.abs(result.correlation) < MIN_CLASSIFY_CORRELATION &&
        bothLive && (
          <div className="card-note">
            The two straps are only loosely correlated ({result.correlation.toFixed(2)}), so no
            phase-based call is being made — the classification is on amplitude alone. Check both
            straps are snug and roughly level with each other.
          </div>
        )}

      {!bothLive && (
        <div className="card-note">
          Needs both straps connected — the main strap and the lower strap. Assign which one is on
          the sternum below.
        </div>
      )}

      <div className="body-row">
        <BodyFigure result={result} posture={posture} live={bothLive} />

        <div className="body-readouts">
      {/* Balance bar */}
      <div className="balance">
        <span className="balance-end">Thoracic<br />(chest)</span>
        <div className="balance-track">
          <div className="balance-mid" />
          {pos != null && (
            <div className="balance-marker" style={{ left: `${pos * 100}%`, background: color }} />
          )}
        </div>
        <span className="balance-end right">
          Diaphragmatic
          <br />
          (belly)
        </span>
      </div>
      <div className="balance-caption">
        {result?.ratio != null ? (
          <>
            Ratio <strong style={{ color }}>{result.ratio.toFixed(2)}</strong> — {BLURB[cls]}
            {learned && (
              <>
                {' '}Closest to your <strong>{learned.label.toLowerCase()}</strong> demonstration
                {learned.confidence < 0.25 && ' (though your demonstrations were similar, so this is a weak call)'}
                {learnedBounds &&
                  ` — your own boundaries are ${learnedBounds.thoracic.toFixed(2)} / ${learnedBounds.diaphragmatic.toFixed(2)}, not the default 0.70 / 1.50.`}
              </>
            )}
          </>
        ) : (
          BLURB.UNKNOWN
        )}
      </div>

      {/* Metrics */}
      <div className="metric-row">
        <Metric
          k="Ratio R"
          v={fmt(result?.ratio, 2)}
          info={`Normalised abdominal peak-to-peak divided by thoracic. ≥ ${RATIO_DIAPHRAGMATIC} diaphragmatic, < ${RATIO_THORACIC} thoracic.`}
          color={color}
        />
        <Metric
          k="Phase Δφ"
          v={phaseTrusted ? fmt(result?.phaseAngleDeg, 0) : '—'}
          unit="°"
          info={`Phase lag between the two straps over one breath. ≤ ${PHASE_SYNCHRONOUS_DEG}° is normal; > ${PHASE_PARADOXICAL_DEG}° is paradoxical. Shown only when the two traces actually correlate — otherwise there is no shared rhythm to measure a phase against.`}
        />
        <Metric k="Chest p-p" v={fmt(result?.chestPtP, 1)} unit="mG" />
        <Metric k="Abdomen p-p" v={fmt(result?.abdoPtP, 1)} unit="mG" />
        <Metric
          k="Breath period"
          v={result?.breathPeriodMs != null ? (result.breathPeriodMs / 1000).toFixed(1) : '—'}
          unit="s"
        />
        <Metric
          k="Correlation"
          v={fmt(result?.correlation, 2)}
          info="Peak normalised cross-correlation between the two traces. Below 0.35 the phase angle is meaningless and is hidden."
        />
      </div>

        </div>
      </div>

      <div className="card-body">
        <div className="plot-wrap">
          <div ref={divRef} className="plot" style={{ height: 240 }} />
          {(!result || result.t.length === 0) && (
            <div className="plot-overlay">
              {bothLive
                ? 'Collecting — needs about 10 seconds of both straps.'
                : 'Connect both the main and lower straps to see chest against abdomen.'}
            </div>
          )}
        </div>
      </div>

      <div className="shaping">
        <Segmented
          label="View"
          value={diaphragmView}
          options={[
            { value: 'overlay', label: 'Overlay' },
            { value: 'differential', label: 'Differential' },
          ]}
          onChange={setDiaphragmView}
          info="Overlay draws chest and abdomen together. Differential draws abdomen minus chest — posture tilts and chair movement appear on both straps, so subtracting cancels them and leaves only motion that is genuinely differential."
        />
        <div className="sep" />
        <Select
          label="Sternum strap"
          value={chestStrap}
          options={[
            { value: 'main', label: 'Main strap' },
            { value: 'lower', label: 'Lower strap' },
          ]}
          onChange={(v) => setChestStrap(v as StrapId)}
          info="Which physical strap is across the mid-sternum. The other one is treated as the abdominal strap. Swap this rather than re-pairing if they went on the other way round."
        />
        <Select
          label="Axis"
          value={diaphragmAxis}
          options={[
            { value: 'auto', label: axisPick ? `Auto (${axisPick.axis.toUpperCase()})` : 'Auto' },
            { value: 'z', label: 'Z' },
            { value: 'x', label: 'X' },
            { value: 'y', label: 'Y' },
            { value: 'mag', label: '|mag|' },
          ]}
          onChange={(v) => setDiaphragmAxis(v as AccAxis | 'auto')}
          info="An accelerometer axis is a direction in the STRAP's frame, not the body's. If the two straps sit at different rotations, the same axis points different ways on each and comparing them measures how they were put on rather than how the subject breathes. Auto picks the axis where the two straps genuinely track one rhythm (strongest correlation, either sign) instead of assuming they were mounted identically."
        />
        <div className="sep" />
        <button
          className={calibratingUntil != null ? 'btn sm' : 'btn primary sm'}
          disabled={!bothLive || calibratingUntil != null}
          onClick={() => setCalibratingUntil(Date.now() + CALIBRATION_MS)}
        >
          {calibratingUntil != null ? `Breathe deeply… ${calibRemaining}s` : 'Calibrate baselines'}
        </button>
        {calibrated && (
          <button className="btn sm" onClick={() => setCalibration(1, 1)}>
            Clear calibration
          </button>
        )}
        <span className="hint">
          {calibratingUntil != null
            ? 'Take two full, deep breaths. The peak-to-peak of each strap over these 10 seconds becomes its scale factor.'
            : calibrated
              ? `Calibrated — chest ÷${calibChest.toFixed(1)} mG, abdomen ÷${calibAbdo.toFixed(1)} mG. The ratio is normalised by these, so it reflects effort rather than how much tissue each strap sits on.`
              : 'Uncalibrated: the ratio compares raw millI-g, so it is affected by strap tightness and body shape. Calibrate with two deep breaths to make it comparable between sessions.'}
        </span>
      </div>
    </section>
  );
}

function Metric({
  k,
  v,
  unit,
  info,
  color,
}: {
  k: string;
  v: string;
  unit?: string;
  info?: string;
  color?: string;
}): ReactNode {
  const dim = v === '—';
  return (
    <div className="metric">
      <div className="k">
        {k}
        {info && <Info text={info} />}
      </div>
      <div className="v" style={{ color: dim ? '#64748b' : color }}>
        {v}
        {unit && !dim && <span className="u">{unit}</span>}
      </div>
    </div>
  );
}
