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
  CALIBRATION_STEPS,
  TOTAL_CALIBRATION_SEC,
  learnedThresholds,
  matchPosture,
  type BreathingSignature,
  type BreathingStepId,
  type CalibrationModel,
  type PostureSignature,
  type PostureStepId,
} from './calibration';
import { assessPosture, postureAdvice, type PostureStatus } from './posture';
import { CLASSIFICATION, INK } from './theme';
import { useSettings } from './settings';
import { Info } from './ui';

/** Gravity is averaged over the trailing part of a step, skipping the first
 * couple of seconds so the subject has time to actually get into position. */
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
}: {
  chestStrap: StrapId;
  abdoStrap: StrapId;
  axis: AccAxis;
  bothLive: boolean;
}): ReactNode {
  const {
    calibrationModel,
    setCalibrationModel,
    postureReference,
    setPostureReference,
    setAbdoInverted,
  } = useSettings();

  const [status, setStatus] = useState<PostureStatus | null>(null);
  const [stepIndex, setStepIndex] = useState<number | null>(null);
  const [stepEndsAt, setStepEndsAt] = useState(0);
  const [, setTick] = useState(0);

  const ctx = useRef({ chestStrap, abdoStrap, axis, postureReference });
  ctx.current = { chestStrap, abdoStrap, axis, postureReference };
  // Captures accumulate here across steps and become the model at the end.
  const captured = useRef<{ breathing: BreathingSignature[]; postures: PostureSignature[] }>({
    breathing: [],
    postures: [],
  });

  // Live posture, 2 Hz. Cheap: two window means.
  useEffect(() => {
    const run = (): void => {
      const c = ctx.current;
      const now = Date.now();
      const chest = sessionLog.accMeanVector(c.chestStrap, 3, now);
      const abdo = sessionLog.accMeanVector(c.abdoStrap, 3, now);
      setStatus(assessPosture(chest, abdo, c.postureReference));
    };
    run();
    const id = setInterval(run, 500);
    return () => clearInterval(id);
  }, []);

  /** Capture whatever the step at `index` was meant to measure. */
  const captureStep = (index: number): void => {
    const step = CALIBRATION_STEPS[index];
    const c = ctx.current;
    const now = Date.now();
    const win = Math.max(2, step.seconds - SETTLE_SEC);
    if (step.kind === 'posture') {
      const chest = sessionLog.accMeanVector(c.chestStrap, win, now);
      const abdo = sessionLog.accMeanVector(c.abdoStrap, win, now);
      if (chest && abdo) {
        captured.current.postures.push({ id: step.id as PostureStepId, chest, abdo });
      }
      return;
    }
    const r = analyseDualStreams(
      sessionLog.accWindow(c.chestStrap, win, now, c.axis),
      sessionLog.accWindow(c.abdoStrap, win, now, c.axis),
      // Uncalibrated on purpose: these ARE the calibration.
      { ...DEFAULT_DIAPHRAGM_OPTIONS, calibChest: 1, calibAbdo: 1 },
    );
    if (r.ratio != null && r.chestPtP != null && r.abdoPtP != null) {
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

  // Step clock.
  useEffect(() => {
    if (stepIndex == null) return;
    const remaining = stepEndsAt - Date.now();
    const advance = setTimeout(() => {
      captureStep(stepIndex);
      const next = stepIndex + 1;
      if (next >= CALIBRATION_STEPS.length) {
        const model: CalibrationModel = {
          breathing: captured.current.breathing,
          postures: captured.current.postures,
          axis: ctx.current.axis,
          createdAt: Date.now(),
        };
        setCalibrationModel(model);
        // Resolve which way the abdominal axis points. Every demonstration here
        // is a NORMAL pattern, in which chest and belly move together — so a
        // consistently negative correlation means the axis reads backwards.
        const sign = resolveAbdoInversion(model.breathing.map((b) => b.correlation));
        if (sign !== null) setAbdoInverted(sign);
        const upright = model.postures.find((p) => p.id === 'upright');
        if (upright) {
          setPostureReference({
            chest: upright.chest,
            abdo: upright.abdo,
            interStrapDeg: null,
            capturedAt: Date.now(),
          });
        }
        setStepIndex(null);
        return;
      }
      setStepIndex(next);
      setStepEndsAt(Date.now() + CALIBRATION_STEPS[next].seconds * 1000);
    }, Math.max(0, remaining));
    const ticker = setInterval(() => setTick((t) => t + 1), 200);
    return () => {
      clearTimeout(advance);
      clearInterval(ticker);
    };
    // captureStep reads through refs, so it does not need to be a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIndex, stepEndsAt]);

  const start = (): void => {
    captured.current = { breathing: [], postures: [] };
    setStepIndex(0);
    setStepEndsAt(Date.now() + CALIBRATION_STEPS[0].seconds * 1000);
  };
  const cancel = (): void => setStepIndex(null);

  const running = stepIndex != null;
  const step = running ? CALIBRATION_STEPS[stepIndex] : null;
  const remainingSec = running ? Math.max(0, Math.ceil((stepEndsAt - Date.now()) / 1000)) : 0;
  const st = status?.state ?? 'unknown';
  const thresholds = learnedThresholds(calibrationModel);
  const posture = matchPosture(
    calibrationModel,
    sessionLog.accMeanVector(chestStrap, 3, Date.now()),
    sessionLog.accMeanVector(abdoStrap, 3, Date.now()),
  );

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
        <Info text="Checked before anything else, because an accelerometer axis is a direction in the STRAP's frame, not the body's. If the two straps are rotated differently, the same axis points different ways on each and a phase comparison measures how they were put on rather than how you breathe — which is exactly how this app once reported paradoxical breathing on a normal recording." />
        <span style={{ marginLeft: 'auto' }} />
        {!running && (
          <button className="btn primary sm" disabled={!bothLive} onClick={start}>
            {calibrationModel ? 'Recalibrate' : `Guided calibration (${TOTAL_CALIBRATION_SEC}s)`}
          </button>
        )}
        {running && (
          <button className="btn sm" onClick={cancel}>
            Cancel
          </button>
        )}
      </div>

      {!running && status && st !== 'aligned' && (
        <div className="calib-advice">{postureAdvice(status)}</div>
      )}

      {running && step && (
        <div className="calib-step">
          <div className="calib-step-head">
            <span className="calib-step-n">
              Step {(stepIndex ?? 0) + 1} of {CALIBRATION_STEPS.length}
            </span>
            <strong>{step.label}</strong>
            <span className="calib-count">{remainingSec}s</span>
          </div>
          <div className="calib-instruction">{step.instruction}</div>
          <div className="calib-bar">
            <div
              className="calib-bar-fill"
              style={{
                width: `${100 * (1 - remainingSec / step.seconds)}%`,
                background: step.kind === 'posture' ? INK.accent : CLASSIFICATION.BALANCED,
              }}
            />
          </div>
        </div>
      )}

      {!running && calibrationModel && (
        <div className="calib-model">
          <span className="calib-model-title">Learned on this subject:</span>
          {calibrationModel.breathing.map((b) => (
            <span key={b.id} className="calib-chip">
              {b.id} <strong>{b.ratio.toFixed(2)}</strong>
            </span>
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
          <button
            className="btn sm"
            onClick={() => {
              setCalibrationModel(null);
              setPostureReference(null);
            }}
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}
