/*
 * bodyPose.ts — geometry for the seated side-profile figure.
 *
 * Pure. Given a chest displacement, an abdominal displacement and a lean angle,
 * it returns the SVG path strings for one frame. Keeping it separate from the
 * component means the shape can be checked without a DOM, and — more usefully —
 * that the mapping from signal to anatomy is written down in one place rather
 * than scattered through JSX.
 *
 * The figure is SEATED and faces right, because every posture in the guided
 * sequence is a seated one and a profile is the only view in which thoracic and
 * abdominal excursion are separately visible.
 *
 * Displacements are normalised to -1..1, where +1 is the fullest inhale seen
 * recently. They are NOT absolute: a strap on a larger torso reads more
 * millI-g for the same breath, so the figure shows the shape of the breathing,
 * not its size. The numbers beside it carry the magnitudes.
 */

export interface Pose {
  /** Thoracic displacement, -1 (full exhale) .. +1 (full inhale). */
  chest: number;
  /** Abdominal displacement, same scale. */
  abdo: number;
  /** Forward lean in degrees. Positive slouches forward, negative leans back. */
  leanDeg: number;
}

export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface BodyPaths {
  /** Closed torso outline: up the spine, over the shoulder, down the front. */
  torso: string;
  /** The diaphragm dome. Descends and flattens on inhale. */
  diaphragm: string;
  /** Lung field, bounded below by the diaphragm. */
  lung: string;
  /** Rib arcs, front-most first. */
  ribs: string[];
  /** Strap bands, drawn across the torso at the two measured heights. */
  chestStrap: Segment;
  abdoStrap: Segment;
  /** Where to anchor the callout labels. */
  chestAnchor: { x: number; y: number };
  diaphragmAnchor: { x: number; y: number };
  abdoAnchor: { x: number; y: number };
}

/** Hip joint — everything above it rotates when posture changes. */
export const HIP = { x: 98, y: 236 };

/* Excursion in SVG units at full inhale. The belly is given more travel than
 * the chest because it genuinely moves further in diaphragmatic breathing, and
 * a figure that showed them equal would undercut the thing being taught. */
const CHEST_TRAVEL = 8;
const ABDO_TRAVEL = 13;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Interpolate a time series at `tMs`. Returns null outside its range, which is
 * the honest answer while the analysis window is still filling. */
export function sampleAt(
  t: readonly number[],
  y: readonly number[],
  tMs: number,
): number | null {
  const n = Math.min(t.length, y.length);
  if (n === 0) return null;
  if (tMs <= t[0]) return y[0];
  if (tMs >= t[n - 1]) return y[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= tMs) lo = mid;
    else hi = mid;
  }
  const span = t[hi] - t[lo];
  if (span <= 0) return y[lo];
  const f = (tMs - t[lo]) / span;
  return y[lo] + (y[hi] - y[lo]) * f;
}

/** Scale a displacement by the recent peak-to-peak into -1..1. A peak-to-peak
 * spans BOTH directions, so half of it is the amplitude. */
export function normalise(value: number | null, peakToPeak: number | null): number {
  if (value == null || peakToPeak == null || !(peakToPeak > 1e-6)) return 0;
  return clamp(value / (peakToPeak / 2), -1, 1);
}

/** Lean angle from the measured tilts. Chest and abdomen tilt differently in a
 * slouch, so the mean is used, capped so the figure stays legible. */
export const MAX_LEAN_DEG = 14;
/* Drawn lean is scaled down from measured tilt. A strap tilt of 20 degrees is a
 * noticeable slouch, but rotating the whole torso by 20 degrees about the hip
 * draws someone bowing — and swings the head far enough forward to collide with
 * the callout labels. Trunk flexion in a real slouch is also shared between the
 * hip and the spine, which a single pivot cannot represent, so understating it
 * is both safer and more honest. */
const LEAN_VISUAL_SCALE = 0.65;

export function leanDegFrom(
  chestTiltDeg: number | null,
  abdoTiltDeg: number | null,
): number {
  if (chestTiltDeg == null && abdoTiltDeg == null) return 0;
  const vals = [chestTiltDeg, abdoTiltDeg].filter((v): v is number => v != null);
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  return clamp(mean * LEAN_VISUAL_SCALE, -MAX_LEAN_DEG, MAX_LEAN_DEG);
}

/** Head centre and radius. Sits back far enough that the face does not
 * protrude past the sternum — a profile where the head leads the chest reads
 * as a stoop no matter what the data says. */
export const HEAD = { x: 122, y: 62, r: 23 };

const pt = (x: number, y: number): string => `${x.toFixed(1)},${y.toFixed(1)}`;

/**
 * Build one frame.
 *
 * The front contour is a cubic spline through six anatomical landmarks, each
 * displaced by the signal that actually measures it: the sternal and mid-chest
 * points follow the chest strap, the epigastric and belly points follow the
 * abdominal strap, and the lower-rib point between them follows a blend —
 * which is what makes a paradoxical pattern look wrong on the figure rather
 * than merely reading wrong in the numbers.
 */
export function buildBody(pose: Pose): BodyPaths {
  const c = clamp(pose.chest, -1, 1);
  const a = clamp(pose.abdo, -1, 1);

  // Front landmarks, back-to-front displacement applied along +x.
  const sternum = { x: 140 + c * CHEST_TRAVEL * 0.75, y: 116 };
  const midChest = { x: 149 + c * CHEST_TRAVEL, y: 136 };
  const lowerRib = { x: 152 + (c * 0.4 + a * 0.5) * CHEST_TRAVEL, y: 159 };
  const epigastric = { x: 150 + a * ABDO_TRAVEL, y: 182 };
  const belly = { x: 144 + a * ABDO_TRAVEL * 0.85, y: 206 };
  const lowerBelly = { x: 126 + a * ABDO_TRAVEL * 0.35, y: 228 };

  // Spine side — barely moves with breathing; a slouch is handled by rotation.
  const torso =
    `M ${pt(HIP.x, HIP.y)}` +
    ` C ${pt(90, 206)} ${pt(85, 168)} ${pt(87, 126)}` +
    ` C ${pt(88, 111)} ${pt(92, 104)} ${pt(99, 101)}` +
    ` L ${pt(126, 97)}` +
    ` C ${pt(134, 100)} ${pt(138, 108)} ${pt(sternum.x, sternum.y)}` +
    ` C ${pt(sternum.x + 5, sternum.y + 8)} ${pt(midChest.x, midChest.y - 8)} ${pt(midChest.x, midChest.y)}` +
    ` C ${pt(midChest.x + 2, midChest.y + 9)} ${pt(lowerRib.x, lowerRib.y - 8)} ${pt(lowerRib.x, lowerRib.y)}` +
    ` C ${pt(lowerRib.x + 1, lowerRib.y + 9)} ${pt(epigastric.x, epigastric.y - 9)} ${pt(epigastric.x, epigastric.y)}` +
    ` C ${pt(epigastric.x + 1, epigastric.y + 10)} ${pt(belly.x + 3, belly.y - 8)} ${pt(belly.x, belly.y)}` +
    ` C ${pt(belly.x - 4, belly.y + 11)} ${pt(lowerBelly.x + 6, lowerBelly.y - 4)} ${pt(lowerBelly.x, lowerBelly.y)}` +
    ` Z`;

  // Diaphragm: descends (y grows) and flattens as the belly fills.
  const diaphY = 160 + a * 10;
  const domeRise = 17 - a * 7;
  const diaphBackX = 89;
  const diaphFrontX = lowerRib.x - 4;
  const diaphragm =
    `M ${pt(diaphBackX, diaphY)}` +
    ` Q ${pt((diaphBackX + diaphFrontX) / 2, diaphY - domeRise)} ${pt(diaphFrontX, diaphY)}`;

  // Lung field sits on the dome and expands upward/forward with the chest.
  const lung =
    `M ${pt(diaphBackX + 2, diaphY - 2)}` +
    ` Q ${pt((diaphBackX + diaphFrontX) / 2, diaphY - domeRise - 2)} ${pt(diaphFrontX - 2, diaphY - 2)}` +
    ` C ${pt(diaphFrontX - 1, 140)} ${pt(midChest.x - 6, 124)} ${pt(sternum.x - 8, 114)}` +
    ` L ${pt(104, 108)}` +
    ` C ${pt(95, 118)} ${pt(91, 138)} ${pt(diaphBackX + 2, diaphY - 2)}` +
    ` Z`;

  // Ribs angle down and forward, riding the chest displacement.
  const ribs = [0, 1, 2].map((i) => {
    const y = 122 + i * 14;
    const frontX = sternum.x - 4 + (midChest.x - sternum.x) * (i / 2.4) - i * 1.5;
    const backX = 92 + i * 1.5;
    return `M ${pt(backX, y)} Q ${pt((backX + frontX) / 2, y + 7 + i)} ${pt(frontX, y + 4 + i * 2)}`;
  });

  return {
    torso,
    diaphragm,
    lung,
    ribs,
    // Straps cross the torso, so in profile they are a band from spine to front.
    chestStrap: { x1: 88, y1: midChest.y, x2: midChest.x + 1, y2: midChest.y },
    abdoStrap: { x1: 92, y1: epigastric.y, x2: epigastric.x + 1, y2: epigastric.y },
    chestAnchor: { x: midChest.x, y: midChest.y },
    diaphragmAnchor: { x: diaphFrontX, y: diaphY - domeRise * 0.5 },
    abdoAnchor: { x: epigastric.x, y: epigastric.y },
  };
}
