/*
 * CalibrationPanel.tsx — posture check + the guided learning sequence.
 *
 * Deliberately sits ABOVE the classification. If the two straps disagree about
 * which way is forward, nothing below it means anything: a recording where they
 * were 23 degrees apart produced a PARADOXICAL warning from a subject breathing
 * perfectly normally. So the posture state is reported first, and the
 * classification is marked provisional until it is sound.
 *
 * The guided sequence then replaces the spec's fixed ratio thresholds with what
 * each pattern actually looks like on this subject, in this session, with these
 * straps at this tightness.
 *
 * Steps run from a QUEUE rather than a straight walk through the list, which is
 * what lets a single botched demonstration be redone — during it, or afterwards
 * — without discarding the ones the subject already sat through.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { sessionLog, type StrapId } from './log';
import {
  analyseDualStreams,
  resolveAbdoInversion,
  DEFAULT_DIAPHRAGM_OPTIONS,
  type AccAxis,
} from './diaphragm';
import {
  BREATHS_PER_STEP_OPTIONS,
  CALIBRATION_STEPS,
  learnedThresholds,
  matchPosture,
  mergeCalibration,
  stepSeconds,
  totalCalibrationSec,
  type BreathingSignature,
  type BreathingStepId,
  type PostureSignature,
  type PostureStepId,
  type StepId,
} from './calibration';
import { assessPosture, postureAdvice, type PostureStatus } from './posture';
import { CLASSIFICATION, INK } from './theme';
import { useSettings } from './settings';
import { Info, Select } from './ui';

/** Gravity and amplitude are averaged over the trailing part of a step, skipping
 * the first couple of seconds so the subject has time to get into position. */
const SETTLE_SEC = 2;

const STATE_COLOR: Record<PostureStatus['state'], string> = {
  aligned: CLASSIFICATION.DIAPHRAGMATIC,
  drifted: CLASSIFICATION.THORACIC,
  misaligned: CLASSIFICATION.PARADOXICAL,
  uncalibrated: INK.muted,
  unknown: INK.muted,
};

const STATE_LABEL: Record<PostureStatus['state'], string> = {
  aligned: 'Posture aligned',
  drifted: 'Posture drifted',
  misaligned: 'Straps misaligned',
  uncalibrated: 'Not calibrated',
  unknown: 'Waiting for both straps',
};

export default function CalibrationPanel({
  chestStrap,
  abdoStrap,
  axis,
  bothLive,
  breathPeriodSec,
}: {
  chestStrap: StrapId;
  abdoStrap: StrapId;
  axis: AccAxis;
  bothLive: boolean;
  /** Measured breath period, used to size the breathing steps. */
  breathPeriodSec: number | null;
}): ReactNode {
  const {
    calibrationModel,
    setCalibrationModel,
    postureReference,
    setPostureReference,
    setAbdoInverted,
    calibBreaths,
    setCalibBreaths,
  } = useSettings();

  const [status, setStatus] = useState<PostureStatus | null>(null);
  /** Indices into CALIBRATION_STEPS still to run. Empty = idle. */
  const [queue, setQueue] = useState<number[]>([]);
  const [stepEndsAt, setStepEndsAt] = useState(0);
  const [, setTick] = useState(0);

  const ctx = useRef({
    chestStrap,
    abdoStrap,
    axis,
    postureReference,
    breathPeriodSec,
    calibBreaths,
    calibrationModel,
  });
  ctx.current = {
    chestStrap,
    abdoStrap,
    axis,
    postureReference,
    breathPeriodSec,
    calibBreaths,
    calibrationModel,
  };
  const captured = useRef<{ breathing: BreathingSignature[]; postures: PostureSignature[] }>({
    breathing: [],
    postures: [],
  });

  // Live posture, 2 Hz. Cheap: two window means.
  useEffect(() => {
    const run = (): void => {
      const c = ctx.current;
      const now = Date.now();
      setStatus(
        assessPosture(
          sessionLog.accMeanVector(c.chestStrap, 3, now),
          sessionLog.accMeanVector(c.abdoStrap, 3, now),
          c.postureReference,
        ),
      );
    };
    run();
    const id = setInterval(run, 500);
    return () => clearInterval(id);
  }, []);

  const durationOf = (index: number): number =>
    stepSeconds(CALIBRATION_STEPS[index], ctx.current.breathPeriodSec, ctx.current.calibBreaths);

  /** Capture whatever the step was meant to measure. */
  const captureStep = (index: number): void => {
    const step = CALIBRATION_STEPS[index];
    const c = ctx.current;
    const now = Date.now();
    const win = Math.max(2, durationOf(index) - SETTLE_SEC);
    if (step.kind === 'posture') {
      const chest = sessionLog.accMeanVector(c.chestStrap, win, now);
      const abdo = sessionLog.accMeanVector(c.abdoStrap, win, now);
      if (chest && abdo) {
        // Replace any earlier capture of the same step — a redo supersedes.
        captured.current.postures = captured.current.postures.filter((p) => p.id !== step.id);
        captured.current.postures.push({ id: step.id as PostureStepId, chest, abdo });
      }
      return;
    }
    const r = analyseDualStreams(
      sessionLog.accWindow(c.chestStrap, win, now, c.axis),
      sessionLog.accWindow(c.abdoStrap, win, now, c.axis),
      // Uncalibrated and unflipped on purpose: these ARE the calibration, and
      // the sign is one of the things being decided from them.
      { ...DEFAULT_DIAPHRAGM_OPTIONS, calibChest: 1, calibAbdo: 1, invertAbdo: false },
    );
    if (r.ratio != null && r.chestPtP != null && r.abdoPtP != null) {
      captured.current.breathing = captured.current.breathing.filter((b) => b.id !== step.id);
      captured.current.breathing.push({
        id: step.id as BreathingStepId,
        ratio: r.ratio,
        chestPtP: r.chestPtP,
        abdoPtP: r.abdoPtP,
        phaseDeg: r.phaseAngleDeg,
        correlation: r.correlation,
      });
    }
  };

  const finish = (): void => {
    const model = mergeCalibration(
      ctx.current.calibrationModel,
      captured.current.breathing,
      captured.current.postures,
      ctx.current.axis,
      Date.now(),
    );
    setCalibrationModel(model);
    const upright = model.postures.find((p) => p.id === 'upright');
    if (upright) {
      setPostureReference({
        chest: upright.chest,
        abdo: upright.abdo,
        interStrapDeg: null,
        capturedAt: Date.now(),
      });
    }
    // Every demonstration is a NORMAL pattern, so a consistently negative
    // chest-abdomen correlation means the abdominal axis reads backwards.
    const sign = resolveAbdoInversion(model.breathing.map((b) => b.correlation));
    if (sign !== null) setAbdoInverted(sign);
    setQueue([]);
  };

  // Step clock.
  useEffect(() => {
    if (queue.length === 0) return;
    const index = queue[0];
    const remaining = stepEndsAt - Date.now();
    const advance = setTimeout(
      () => {
        captureStep(index);
        const rest = queue.slice(1);
        if (rest.length === 0) {
          finish();
          return;
        }
        setQueue(rest);
        setStepEndsAt(Date.now() + durationOf(rest[0]) * 1000);
      },
      Math.max(0, remaining),
    );
    const ticker = setInterval(() => setTick((t) => t + 1), 200);
    return () => {
      clearTimeout(advance);
      clearInterval(ticker);
    };
    // Everything else is read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, stepEndsAt]);

  const startQueue = (indices: number[]): void => {
    if (indices.length === 0) return;
    setQueue(indices);
    setStepEndsAt(Date.now() + durationOf(indices[0]) * 1000);
  };

  const startAll = (): void => {
    captured.current = { breathing: [], postures: [] };
    startQueue(CALIBRATION_STEPS.map((_, i) => i));
  };

  /** Restart the step in progress. Nothing else is discarded. */
  const redoCurrent = (): void => {
    if (queue.length === 0) return;
    setStepEndsAt(Date.now() + durationOf(queue[0]) * 1000);
  };

  /** Re-run one step alone; its result merges into the existing model. */
  const redoOne = (id: StepId): void => {
    const idx = CALIBRATION_STEPS.findIndex((s) => s.id === id);
    if (idx < 0) return;
    captured.current = { breathing: [], postures: [] };
    startQueue([idx]);
  };

  /** Capture now and move on, rather than dropping the step entirely. */
  const skipCurrent = (): void => {
    if (queue.length === 0) return;
    setStepEndsAt(Date.now());
  };

  const cancel = (): void => setQueue([]);

  const running = queue.length > 0;
  const stepIndex = running ? queue[0] : null;
  const step = stepIndex != null ? CALIBRATION_STEPS[stepIndex] : null;
  const stepDur = stepIndex != null ? durationOf(stepIndex) : 0;
  const remainingSec = running ? Math.max(0, Math.ceil((stepEndsAt - Date.now()) / 1000)) : 0;
  const isSingle = running && queue.length === 1 && CALIBRATION_STEPS.length > 1;
  const doneCount = running ? CALIBRATION_STEPS.length - queue.length : 0;
  const st = status?.state ?? 'unknown';
  const thresholds = learnedThresholds(calibrationModel);
  const posture = matchPosture(
    calibrationModel,
    sessionLog.accMeanVector(chestStrap, 3, Date.now()),
    sessionLog.accMeanVector(abdoStrap, 3, Date.now()),
  );
  const totalSec = totalCalibrationSec(breathPeriodSec, calibBreaths);

  return (
    <div className="calib">
      <div className="calib-head">
        <span className="pill" style={{ borderColor: STATE_COLOR[st], color: STATE_COLOR[st] }}>
          <span
            className="dot"
            style={{ background: STATE_COLOR[st], boxShadow: `0 0 0 3px ${STATE_COLOR[st]}22` }}
          />
          {STATE_LABEL[st]}
          {status?.interStrapDeg != null && ` · straps ${Math.round(status.interStrapDeg)}° apart`}
        </span>
        {posture && !running && (
          <span className="pill">
            Sitting: {posture.label} ({Math.round(posture.deg)}° off)
          </span>
        )}
        <Info text="Checked before anything else, because an accelerometer axis is a direction in the STRAP's frame, not the body's. A 20-25° difference between a sternal and an abdominal strap is normal — the chest slopes — so only a much larger angle is flagged." />
        <span style={{ marginLeft: 'auto' }} />

        {!running && (
          <>
            <Select
              label="Per step"
              value={calibBreaths}
              options={BREATHS_PER_STEP_OPTIONS}
              onChange={setCalibBreaths}
              info="How many breaths each breathing demonstration runs for. Counted in breaths rather than seconds because that is what decides whether a demonstration is long enough — 20 s is two breaths at 6 br/min but four at 12. The step length is derived from your own measured breath period."
            />
            <button className="btn primary sm" disabled={!bothLive} onClick={startAll}>
              {calibrationModel ? 'Recalibrate' : `Guided calibration (~${totalSec}s)`}
            </button>
          </>
        )}
        {running && (
          <>
            <button className="btn sm" onClick={redoCurrent} title="Restart just this step">
              Redo step
            </button>
            <button className="btn sm" onClick={skipCurrent} title="Capture now and move on">
              Skip ahead
            </button>
            <button className="btn sm" onClick={cancel}>
              Cancel
            </button>
          </>
        )}
      </div>

      {!running && status && st !== 'aligned' && (
        <div className="calib-advice">{postureAdvice(status)}</div>
      )}

      {running && step && (
        <div className="calib-step">
          <div className="calib-step-head">
            <span className="calib-step-n">
              {isSingle ? 'Redoing' : `Step ${doneCount + 1} of ${CALIBRATION_STEPS.length}`}
            </span>
            <strong>{step.label}</strong>
            {step.kind === 'breathing' && (
              <span className="calib-step-n">
                {calibBreaths} breaths · {stepDur}s
              </span>
            )}
            <span className="calib-count">{remainingSec}s</span>
          </div>
          <div className="calib-instruction">{step.instruction}</div>
          <div className="calib-bar">
            <div
              className="calib-bar-fill"
              style={{
                width: `${100 * (1 - remainingSec / Math.max(1, stepDur))}%`,
                background: step.kind === 'posture' ? INK.accent : CLASSIFICATION.BALANCED,
              }}
            />
          </div>
          <div className="calib-hint">
            Lost the pattern? <strong>Redo step</strong> restarts this one only — steps already
            captured are kept.
          </div>
        </div>
      )}

      {!running && calibrationModel && (
        <div className="calib-model">
          <span className="calib-model-title">Learned on this subject:</span>
          {calibrationModel.breathing.map((b) => (
            <button
              key={b.id}
              className="calib-chip calib-chip-btn"
              title={`Redo the ${b.id} demonstration on its own`}
              disabled={!bothLive}
              onClick={() => redoOne(b.id)}
            >
              {b.id} <strong>{b.ratio.toFixed(2)}</strong> <span className="calib-redo">redo</span>
            </button>
          ))}
          {thresholds ? (
            <span className="calib-chip">
              boundaries <strong>{thresholds.thoracic.toFixed(2)}</strong> /{' '}
              <strong>{thresholds.diaphragmatic.toFixed(2)}</strong>
            </span>
          ) : (
            <span className="calib-chip" style={{ color: CLASSIFICATION.THORACIC }}>
              demonstrations too alike — using the default 0.7 / 1.5
            </span>
          )}
          {calibrationModel.postures.map((p) => (
            <button
              key={p.id}
              className="calib-chip calib-chip-btn"
              title={`Recapture the ${p.id} posture on its own`}
              disabled={!bothLive}
              onClick={() => redoOne(p.id)}
            >
              {p.id} <span className="calib-redo">redo</span>
            </button>
          ))}
          <button
            className="btn sm"
            onClick={() => {
              setCalibrationModel(null);
              setPostureReference(null);
              setAbdoInverted(null);
            }}
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}
