/*
 * posture.ts — strap alignment and posture, from the two gravity vectors.
 *
 * This exists because of a real false alarm. A dual-strap recording produced a
 * PARADOXICAL warning — abdomen moving opposite the chest — from a subject who
 * was breathing normally. The cause was not physiology: the two straps were
 * mounted at different rotations about the torso, 23 degrees apart, so the same
 * accelerometer axis pointed different ways on each and the chest wall's motion
 * projected onto it with opposite sign.
 *
 * An accelerometer axis is a direction in the STRAP's frame. Nothing downstream
 * can recover from comparing two straps that disagree about where "forward" is,
 * so that has to be established BEFORE any conclusion is drawn from the pair.
 * Gravity is the one direction both straps can measure independently, which
 * makes it the reference they can be checked against.
 *
 * All pure.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function magnitude(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

/** Angle between two vectors, in degrees. Returns null if either has no length. */
export function angleBetweenDeg(a: Vec3, b: Vec3): number | null {
  const ma = magnitude(a);
  const mb = magnitude(b);
  if (ma < 1e-6 || mb < 1e-6) return null;
  const cos = (a.x * b.x + a.y * b.y + a.z * b.z) / (ma * mb);
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

/** A strap's gravity direction, captured while still. */
export interface PostureReference {
  chest: Vec3;
  abdo: Vec3;
  /** Angle between the straps at capture time. */
  interStrapDeg: number | null;
  capturedAt: number;
}

export type PostureState =
  | 'unknown' // not enough data from one or both straps
  | 'uncalibrated' // never captured a reference
  | 'aligned' // straps agree and posture matches the reference
  | 'drifted' // posture has moved since the reference was taken
  | 'misaligned'; // the straps disagree about which way is which

export interface PostureStatus {
  state: PostureState;
  /** Current angle between the two straps' gravity vectors. Large means they
   * are rotated differently on the body, and per-axis comparison is invalid. */
  interStrapDeg: number | null;
  /** How far each strap has tilted since the reference was captured. */
  chestTiltDeg: number | null;
  abdoTiltDeg: number | null;
  /** Gravity magnitude per strap. Far from ~1000 mG means the subject is moving,
   * so this is not a clean posture reading. */
  chestMagMg: number | null;
  abdoMagMg: number | null;
  moving: boolean;
}

/**
 * Angle between the straps' gravity vectors above which they are genuinely
 * mounted wrong.
 *
 * NOT 15 degrees, which is what this was. A sternal strap and an epigastric one
 * lie on surfaces that slope differently — the chest is not a cylinder — so
 * they are never parallel even when both are worn correctly. Two independent
 * recordings from a correctly-strapped subject measured 23.0 and 22.4 degrees,
 * so the old threshold fired on every good session and the warning never
 * cleared. Anything under about 35 degrees is ordinary anatomy.
 *
 * Whether the two straps are COMPARABLE is answered by whether their signals
 * correlate, not by this angle — see chooseAxis. This threshold now only
 * catches a strap that is obviously twisted or upside down.
 */
export const STRAP_ALIGN_WARN_DEG = 40;
/** Angles above this are worth mentioning, but are not a fault. */
export const STRAP_ALIGN_NOTE_DEG = 30;
/** Posture change from the calibrated reference worth flagging. */
export const POSTURE_DRIFT_WARN_DEG = 12;
/** Gravity should read ~1 g when still; beyond this the subject is moving and
 * the vector is not a posture measurement. */
export const STILLNESS_TOLERANCE_MG = 120;

export function assessPosture(
  chest: Vec3 | null,
  abdo: Vec3 | null,
  reference: PostureReference | null,
): PostureStatus {
  const base: PostureStatus = {
    state: 'unknown',
    interStrapDeg: null,
    chestTiltDeg: null,
    abdoTiltDeg: null,
    chestMagMg: chest ? magnitude(chest) : null,
    abdoMagMg: abdo ? magnitude(abdo) : null,
    moving: false,
  };
  if (!chest || !abdo) return base;

  base.interStrapDeg = angleBetweenDeg(chest, abdo);
  base.moving =
    Math.abs((base.chestMagMg ?? 1000) - 1000) > STILLNESS_TOLERANCE_MG ||
    Math.abs((base.abdoMagMg ?? 1000) - 1000) > STILLNESS_TOLERANCE_MG;

  if (reference) {
    base.chestTiltDeg = angleBetweenDeg(chest, reference.chest);
    base.abdoTiltDeg = angleBetweenDeg(abdo, reference.abdo);
  }

  // Misalignment is reported ahead of drift: if the straps disagree with each
  // other, how closely they match an earlier posture is beside the point.
  if (base.interStrapDeg != null && base.interStrapDeg > STRAP_ALIGN_WARN_DEG) {
    base.state = 'misaligned';
    return base;
  }
  if (!reference) {
    base.state = 'uncalibrated';
    return base;
  }
  const drifted =
    (base.chestTiltDeg ?? 0) > POSTURE_DRIFT_WARN_DEG ||
    (base.abdoTiltDeg ?? 0) > POSTURE_DRIFT_WARN_DEG;
  base.state = drifted ? 'drifted' : 'aligned';
  return base;
}

/** Mean of a 3-axis window — the gravity direction once breathing averages out. */
export function meanVector(
  x: readonly number[],
  y: readonly number[],
  z: readonly number[],
): Vec3 | null {
  const n = Math.min(x.length, y.length, z.length);
  if (n === 0) return null;
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i];
    sy += y[i];
    sz += z[i];
  }
  return { x: sx / n, y: sy / n, z: sz / n };
}

/** One-line summary for the UI, phrased as what to DO about it. */
export function postureAdvice(s: PostureStatus): string {
  switch (s.state) {
    case 'misaligned':
      return `Straps are ${Math.round(s.interStrapDeg ?? 0)}° apart — far enough that one is probably twisted or upside down. Check both sit squarely front-and-centre with the logo upright, then recalibrate. (A difference of 20-25° is normal: the chest slopes, so the two straps never sit parallel.)`;
    case 'uncalibrated':
      return 'Sit upright and still, then run the posture alignment calibration. It records where both straps sit so later readings can be checked against it.';
    case 'drifted':
      return `Posture has moved since calibration (chest ${Math.round(s.chestTiltDeg ?? 0)}°, abdomen ${Math.round(s.abdoTiltDeg ?? 0)}°). Slouching or leaning changes what each strap sees; sit back the way you calibrated, or recalibrate.`;
    case 'aligned':
      return 'Straps agree with each other and with the calibrated posture.';
    case 'unknown':
    default:
      return 'Waiting for both straps.';
  }
}
