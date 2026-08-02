/*
 * calibration.ts — guided learning sequence for the dual-strap analysis.
 *
 * The spec classifies breathing against fixed ratio thresholds (>= 1.5
 * diaphragmatic, < 0.7 thoracic). Those are population guesses, and the ratio
 * they are applied to depends on strap tightness, body shape and where exactly
 * each strap sits — so the same person can cross a threshold by re-fastening a
 * strap. A false PARADOXICAL warning on a normally-breathing subject already
 * showed what happens when a hard-coded assumption meets a real torso.
 *
 * So instead: ask the subject to demonstrate each pattern once, measure what it
 * looks like ON THEM, and classify by which demonstration the current breathing
 * most resembles. The postures are captured the same way, so the app can say
 * "you have slouched since you calibrated" rather than silently letting posture
 * contaminate the comparison.
 *
 * Pure. The component drives the clock; this only defines the steps and turns
 * captures into a model.
 */
import type { AccAxis } from './diaphragm';
import { angleBetweenDeg, type Vec3 } from './posture';

export type BreathingStepId = 'chest' | 'diaphragm' | 'belly';
export type PostureStepId = 'upright' | 'slouched' | 'back';
export type StepId = BreathingStepId | PostureStepId;

export interface CalibrationStep {
  id: StepId;
  kind: 'breathing' | 'posture';
  label: string;
  instruction: string;
  /** Posture steps: hold still for this long. */
  seconds: number;
  /** Breathing steps: how many breaths, which is what actually determines
   * whether the demonstration is long enough. A fixed 20 s is two breaths at
   * 6 br/min but four at 12 — so the same setting produced very different
   * amounts of evidence depending on how fast the subject happened to breathe. */
  breaths?: number;
}

/**
 * Order matters. Upright comes first so the canonical posture is captured while
 * the subject is freshest and before any breathing effort has moved the straps;
 * the breathing demonstrations then all happen from that same posture, which is
 * what makes their ratios comparable to each other. Slouched and back are last
 * because they deliberately disturb the posture the breathing steps assumed.
 */
export const CALIBRATION_STEPS: readonly CalibrationStep[] = [
  {
    id: 'upright',
    kind: 'posture',
    label: 'Sit upright',
    instruction:
      'Sit tall and still, feet flat, breathing normally. This becomes the reference posture everything else is measured against.',
    seconds: 10,
  },
  {
    id: 'chest',
    kind: 'breathing',
    label: 'Chest breathing',
    instruction:
      'Breathe deliberately into your upper chest only — shoulders and sternum rising, belly kept still. This is the pattern to be able to RECOGNISE, not the one to aim for.',
    seconds: 20,
    breaths: 4,
  },
  {
    id: 'diaphragm',
    kind: 'breathing',
    label: 'Diaphragmatic breathing',
    instruction:
      'Breathe low and easy so the belly leads and the chest follows gently. This is the target pattern.',
    seconds: 20,
    breaths: 4,
  },
  {
    id: 'belly',
    kind: 'breathing',
    label: 'Belly breathing',
    instruction:
      'Push the breath as far into the belly as you comfortably can, chest as still as possible. Marks the far end of the range.',
    seconds: 20,
    breaths: 4,
  },
  {
    id: 'slouched',
    kind: 'posture',
    label: 'Sit slouched',
    instruction: 'Let yourself slump forward, breathing normally.',
    seconds: 10,
  },
  {
    id: 'back',
    kind: 'posture',
    label: 'Sit back',
    instruction: 'Lean back against the chair, breathing normally.',
    seconds: 10,
  },
];

/** Breath-count options for the knob. */
export const BREATHS_PER_STEP_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 2, label: '2 breaths' },
  { value: 3, label: '3 breaths' },
  { value: 4, label: '4 breaths' },
  { value: 6, label: '6 breaths' },
  { value: 8, label: '8 breaths' },
];

/** Assumed breath period when none has been measured yet — 10 br/min. */
export const FALLBACK_BREATH_SEC = 6;
/** A demonstration shorter than this cannot support a band-passed estimate;
 * longer than this and people stop cooperating. */
const MIN_STEP_SEC = 12;
const MAX_STEP_SEC = 75;

/**
 * How long a step should run.
 *
 * Posture steps are a fixed hold. Breathing steps are `breaths` times the
 * subject's own measured period, so a slow breather gets the time they need and
 * a fast one is not held longer than necessary. Clamped at both ends: too short
 * and the band-pass has nothing to work with, too long and the demonstration
 * stops being one.
 */
export function stepSeconds(
  step: CalibrationStep,
  breathPeriodSec: number | null,
  breathsOverride?: number,
): number {
  if (step.kind !== 'breathing' || !step.breaths) return step.seconds;
  const breaths = breathsOverride ?? step.breaths;
  const period =
    breathPeriodSec != null && breathPeriodSec >= 2 && breathPeriodSec <= 20
      ? breathPeriodSec
      : FALLBACK_BREATH_SEC;
  return Math.round(Math.min(MAX_STEP_SEC, Math.max(MIN_STEP_SEC, breaths * period)));
}

/** Total run time for the whole sequence, given the current settings. */
export function totalCalibrationSec(
  breathPeriodSec: number | null,
  breathsOverride?: number,
): number {
  return CALIBRATION_STEPS.reduce(
    (acc, st) => acc + stepSeconds(st, breathPeriodSec, breathsOverride),
    0,
  );
}

export const TOTAL_CALIBRATION_SEC = CALIBRATION_STEPS.reduce((s, x) => s + x.seconds, 0);

/** What a breathing demonstration looked like on this subject. */
export interface BreathingSignature {
  id: BreathingStepId;
  /** Raw (uncalibrated) abdominal / thoracic peak-to-peak. */
  ratio: number;
  chestPtP: number;
  abdoPtP: number;
  phaseDeg: number | null;
  correlation: number | null;
}

export interface PostureSignature {
  id: PostureStepId;
  chest: Vec3;
  abdo: Vec3;
}

export interface CalibrationModel {
  breathing: BreathingSignature[];
  postures: PostureSignature[];
  /** Axis the demonstrations were measured on — a model learned on one axis
   * does not transfer to another. */
  axis: AccAxis;
  createdAt: number;
}

/** A demonstration with no measurable movement teaches nothing and would drag
 * every later comparison toward it. */
const MIN_DEMO_PTP_MG = 2;

export function isUsableSignature(s: BreathingSignature): boolean {
  return (
    Number.isFinite(s.ratio) &&
    s.ratio > 0 &&
    s.chestPtP >= MIN_DEMO_PTP_MG &&
    s.abdoPtP >= MIN_DEMO_PTP_MG
  );
}

export interface BreathingMatch {
  id: BreathingStepId;
  label: string;
  /** 0..1. How much closer this signature is than the runner-up — low means the
   * demonstrations were too similar to tell apart, which is a fact about the
   * calibration, not about the current breath. */
  confidence: number;
  /** log2 distance to the matched signature. */
  distance: number;
}

const BREATHING_LABELS: Record<BreathingStepId, string> = {
  chest: 'Chest',
  diaphragm: 'Diaphragmatic',
  belly: 'Belly',
};

/**
 * Fold fresh captures into an existing model, replacing same-id entries.
 *
 * This is what makes redoing ONE step possible: a botched belly demonstration
 * can be replaced without discarding the chest and diaphragm ones, which were
 * fine and which the subject already sat through.
 */
export function mergeCalibration(
  existing: CalibrationModel | null,
  breathing: BreathingSignature[],
  postures: PostureSignature[],
  axis: AccAxis,
  now: number,
): CalibrationModel {
  const byId = new Map<string, BreathingSignature>();
  for (const b of existing?.breathing ?? []) byId.set(b.id, b);
  for (const b of breathing) byId.set(b.id, b);
  const pById = new Map<string, PostureSignature>();
  for (const p of existing?.postures ?? []) pById.set(p.id, p);
  for (const p of postures) pById.set(p.id, p);
  // Keep the canonical order rather than insertion order, so the UI is stable.
  const order = CALIBRATION_STEPS.map((s) => s.id);
  const sortByStep = <T extends { id: string }>(xs: T[]): T[] =>
    xs.sort((a, b) => order.indexOf(a.id as StepId) - order.indexOf(b.id as StepId));
  return {
    breathing: sortByStep([...byId.values()]),
    postures: sortByStep([...pById.values()]),
    axis,
    createdAt: now,
  };
}

/**
 * Which demonstration the current ratio most resembles.
 *
 * Compared in log2 space: a ratio is a ratio, so 0.5 and 2.0 are equally far
 * from 1.0 and should be treated as such. On a linear scale everything below 1
 * is crushed together and every chest-dominant pattern looks alike.
 */
export function matchBreathing(
  model: CalibrationModel | null,
  ratio: number | null,
): BreathingMatch | null {
  if (!model || ratio == null || !Number.isFinite(ratio) || ratio <= 0) return null;
  const usable = model.breathing.filter(isUsableSignature);
  if (usable.length === 0) return null;
  const target = Math.log2(ratio);
  const scored = usable
    .map((s) => ({ s, d: Math.abs(Math.log2(s.ratio) - target) }))
    .sort((a, b) => a.d - b.d);
  const best = scored[0];
  const runnerUp = scored[1];
  // Confidence from the gap to the runner-up, relative to their spread. With one
  // demonstration there is nothing to be unsure between, so confidence is 1.
  let confidence = 1;
  if (runnerUp) {
    const gap = runnerUp.d - best.d;
    const spread = Math.abs(Math.log2(runnerUp.s.ratio) - Math.log2(best.s.ratio));
    confidence = spread > 1e-6 ? Math.max(0, Math.min(1, gap / spread)) : 0;
  }
  return {
    id: best.s.id,
    label: BREATHING_LABELS[best.s.id],
    confidence,
    distance: best.d,
  };
}

export interface PostureMatch {
  id: PostureStepId;
  label: string;
  /** Mean angle from the matched posture, degrees. */
  deg: number;
}

const POSTURE_LABELS: Record<PostureStepId, string> = {
  upright: 'Upright',
  slouched: 'Slouched',
  back: 'Leaning back',
};

/** Which calibrated posture the subject is currently in. Uses both straps —
 * a slouch rotates the sternum and the epigastrium by different amounts, and
 * one strap alone cannot tell leaning back from sliding down. */
export function matchPosture(
  model: CalibrationModel | null,
  chest: Vec3 | null,
  abdo: Vec3 | null,
): PostureMatch | null {
  if (!model || !chest || !abdo || model.postures.length === 0) return null;
  let best: PostureMatch | null = null;
  for (const p of model.postures) {
    const a = angleBetweenDeg(chest, p.chest);
    const b = angleBetweenDeg(abdo, p.abdo);
    if (a == null || b == null) continue;
    const deg = (a + b) / 2;
    if (!best || deg < best.deg) best = { id: p.id, label: POSTURE_LABELS[p.id], deg };
  }
  return best;
}

/**
 * Ratio boundaries learned from the demonstrations, replacing the spec's fixed
 * 1.5 / 0.7. Each boundary is the geometric mean of the two demonstrations it
 * separates — the midpoint in log space, which is the neutral choice when the
 * quantity is a ratio.
 *
 * Returns null when the demonstrations are too close together to define a
 * boundary, which happens when the subject could not actually produce distinct
 * patterns. Fixed thresholds are the fallback, and that is the honest outcome:
 * better to keep the population defaults than to invent a personal boundary
 * from two demonstrations that were the same.
 */
export function learnedThresholds(
  model: CalibrationModel | null,
): { thoracic: number; diaphragmatic: number } | null {
  if (!model) return null;
  const by = (id: BreathingStepId): BreathingSignature | undefined =>
    model.breathing.find((s) => s.id === id && isUsableSignature(s));
  const chest = by('chest');
  const dia = by('diaphragm');
  const belly = by('belly');
  if (!chest || !dia) return null;
  const geo = (a: number, b: number): number => Math.sqrt(a * b);
  const thoracic = geo(chest.ratio, dia.ratio);
  // Without a belly demonstration, place the upper boundary as far above the
  // diaphragmatic ratio as the lower one sits below it.
  const diaphragmatic = belly ? geo(dia.ratio, belly.ratio) : (dia.ratio * dia.ratio) / thoracic;
  if (!(diaphragmatic > thoracic)) return null; // demonstrations were not distinct
  return { thoracic, diaphragmatic };
}
