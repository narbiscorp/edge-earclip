/*
 * BodyFigure.tsx — live seated profile showing posture and breathing motion.
 *
 * Renders at animation rate but does NOT re-render React: the analysis lands at
 * 2 Hz, and the figure interpolates between its samples on a rAF loop, writing
 * path attributes straight to the DOM. Same lesson as the plots — rebuilding a
 * component tree 30 times a second to move a curve is how the accelerometer
 * chart ended up looking like it updated once a second.
 *
 * The motion is played back slightly behind wall-clock so it is always
 * interpolating inside data that exists, rather than extrapolating past the end
 * of the analysis window.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import type { DiaphragmResult } from './diaphragm';
import type { PostureStatus } from './posture';
import { buildBody, leanDegFrom, normalise, sampleAt, HEAD, HIP } from './bodyPose';
import { CLASSIFICATION, INK, SERIES } from './theme';

/** Playback lag. The analysis refreshes every 500 ms and its window ends at
 * roughly "now", so sitting a little behind keeps the interpolation inside real
 * samples instead of running off the end. */
const PLAYBACK_LAG_MS = 700;
/** Posture lean is eased rather than snapped — a real torso does not teleport,
 * and the tilt estimate is noisy at the degree level. */
const LEAN_EASE = 0.06;

export default function BodyFigure({
  result,
  posture,
  live,
}: {
  result: DiaphragmResult | null;
  posture: PostureStatus | null;
  live: boolean;
}): ReactNode {
  const torsoRef = useRef<SVGPathElement | null>(null);
  const diaphRef = useRef<SVGPathElement | null>(null);
  const lungRef = useRef<SVGPathElement | null>(null);
  const ribRefs = [
    useRef<SVGPathElement | null>(null),
    useRef<SVGPathElement | null>(null),
    useRef<SVGPathElement | null>(null),
  ];
  const chestBandRef = useRef<SVGLineElement | null>(null);
  const abdoBandRef = useRef<SVGLineElement | null>(null);
  const rotRef = useRef<SVGGElement | null>(null);
  const chestDotRef = useRef<SVGCircleElement | null>(null);
  const abdoDotRef = useRef<SVGCircleElement | null>(null);

  // Latest inputs, read by the loop without re-subscribing it.
  const dataRef = useRef({ result, posture, live });
  dataRef.current = { result, posture, live };
  const leanRef = useRef(0);

  useEffect(() => {
    let raf = 0;
    const loop = (): void => {
      raf = requestAnimationFrame(loop);
      const { result: r, posture: p, live: isLive } = dataRef.current;

      let chest = 0;
      let abdo = 0;
      if (isLive && r && r.t.length > 1) {
        const at = Date.now() - PLAYBACK_LAG_MS;
        chest = normalise(sampleAt(r.t, r.chest, at), r.chestPtP);
        abdo = normalise(sampleAt(r.t, r.abdo, at), r.abdoPtP);
      }

      const targetLean = leanDegFrom(p?.chestTiltDeg ?? null, p?.abdoTiltDeg ?? null);
      leanRef.current += (targetLean - leanRef.current) * LEAN_EASE;

      const body = buildBody({ chest, abdo, leanDeg: leanRef.current });

      torsoRef.current?.setAttribute('d', body.torso);
      diaphRef.current?.setAttribute('d', body.diaphragm);
      lungRef.current?.setAttribute('d', body.lung);
      body.ribs.forEach((d, i) => ribRefs[i].current?.setAttribute('d', d));
      // Lung brightens through inhalation — the one place colour encodes phase.
      lungRef.current?.setAttribute('opacity', String(0.1 + 0.26 * ((chest + 1) / 2)));

      const cb = chestBandRef.current;
      if (cb) {
        cb.setAttribute('x1', String(body.chestStrap.x1));
        cb.setAttribute('y1', String(body.chestStrap.y1));
        cb.setAttribute('x2', String(body.chestStrap.x2));
        cb.setAttribute('y2', String(body.chestStrap.y2));
      }
      const ab = abdoBandRef.current;
      if (ab) {
        ab.setAttribute('x1', String(body.abdoStrap.x1));
        ab.setAttribute('y1', String(body.abdoStrap.y1));
        ab.setAttribute('x2', String(body.abdoStrap.x2));
        ab.setAttribute('y2', String(body.abdoStrap.y2));
      }
      chestDotRef.current?.setAttribute('cx', String(body.chestStrap.x2));
      chestDotRef.current?.setAttribute('cy', String(body.chestStrap.y2));
      abdoDotRef.current?.setAttribute('cx', String(body.abdoStrap.x2));
      abdoDotRef.current?.setAttribute('cy', String(body.abdoStrap.y2));

      rotRef.current?.setAttribute(
        'transform',
        `rotate(${leanRef.current.toFixed(2)} ${HIP.x} ${HIP.y})`,
      );
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const accent = CLASSIFICATION[result?.classification ?? 'UNKNOWN'];
  const initial = buildBody({ chest: 0, abdo: 0, leanDeg: 0 });

  return (
    <div className="figure-wrap">
      <svg viewBox="0 0 286 330" className="figure" role="img" aria-label="Seated side view showing posture and breathing motion">
        <defs>
          <linearGradient id="bodyFill" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#33455f" />
            <stop offset="55%" stopColor="#26364d" />
            <stop offset="100%" stopColor="#1d2b3e" />
          </linearGradient>
          <radialGradient id="lungFill" cx="0.45" cy="0.55" r="0.7">
            <stop offset="0%" stopColor={SERIES.s1} stopOpacity="0.95" />
            <stop offset="100%" stopColor={SERIES.s1} stopOpacity="0.15" />
          </radialGradient>
          <filter id="soft" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="3.2" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id="ground" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="6" />
          </filter>
        </defs>

        {/* Floor shadow — grounds the figure so it does not float. */}
        <ellipse cx="150" cy="316" rx="72" ry="7" fill="#0b1220" filter="url(#ground)" opacity="0.85" />

        {/* Chair, kept quiet: it is context, not data. */}
        <g stroke={INK.axis} strokeWidth="2.5" fill="none" opacity="0.45" strokeLinecap="round">
          <path d="M 74 252 L 196 252" />
          <path d="M 78 252 L 74 168" />
          <path d="M 88 252 L 88 300" />
          <path d="M 188 252 L 190 300" />
        </g>

        {/* Legs — fixed; only the torso responds to posture. */}
        <g
          stroke="#2b3d56"
          strokeWidth="21"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        >
          <path d="M 100 238 L 184 243" />
          <path d="M 184 243 L 192 300" />
        </g>
        <path d="M 192 302 L 218 306" stroke="#2b3d56" strokeWidth="13" strokeLinecap="round" fill="none" />

        {/* Everything above the hip rotates with posture. */}
        <g ref={rotRef} transform={`rotate(0 ${HIP.x} ${HIP.y})`}>
          {/* Torso */}
          <path
            ref={torsoRef}
            d={initial.torso}
            fill="url(#bodyFill)"
            stroke={accent}
            strokeOpacity="0.55"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />

          {/* Lung field */}
          <path ref={lungRef} d={initial.lung} fill="url(#lungFill)" opacity="0.2" />

          {/* Ribs */}
          <g stroke="#6d86a6" strokeWidth="1.5" fill="none" strokeLinecap="round" opacity="0.5">
            <path ref={ribRefs[0]} d={initial.ribs[0]} />
            <path ref={ribRefs[1]} d={initial.ribs[1]} />
            <path ref={ribRefs[2]} d={initial.ribs[2]} />
          </g>

          {/* Diaphragm — the one anatomical feature the whole card is about. */}
          <path
            ref={diaphRef}
            d={initial.diaphragm}
            fill="none"
            stroke={SERIES.s3}
            strokeWidth="3"
            strokeLinecap="round"
            filter="url(#soft)"
            opacity="0.95"
          />

          {/* Neck + head */}
          <path d="M 114 100 L 118 80" stroke="#2b3d56" strokeWidth="17" strokeLinecap="round" />
          <circle
            cx={HEAD.x}
            cy={HEAD.y}
            r={HEAD.r}
            fill="url(#bodyFill)"
            stroke={accent}
            strokeOpacity="0.45"
            strokeWidth="1.6"
          />
          {/* Brow/nose hint — just enough to read as facing right. */}
          <path d="M 139 57 q 7 5 -1 11" stroke="#6d86a6" strokeWidth="2" fill="none" strokeLinecap="round" opacity="0.7" />

          {/* Strap bands, in the same colours as their traces. */}
          <line
            ref={chestBandRef}
            x1={initial.chestStrap.x1}
            y1={initial.chestStrap.y1}
            x2={initial.chestStrap.x2}
            y2={initial.chestStrap.y2}
            stroke={SERIES.s1}
            strokeWidth="4.5"
            strokeLinecap="round"
            filter="url(#soft)"
          />
          <circle ref={chestDotRef} cx={initial.chestStrap.x2} cy={initial.chestStrap.y2} r="4" fill={SERIES.s1} />
          <line
            ref={abdoBandRef}
            x1={initial.abdoStrap.x1}
            y1={initial.abdoStrap.y1}
            x2={initial.abdoStrap.x2}
            y2={initial.abdoStrap.y2}
            stroke={SERIES.s2}
            strokeWidth="4.5"
            strokeLinecap="round"
            filter="url(#soft)"
          />
          <circle ref={abdoDotRef} cx={initial.abdoStrap.x2} cy={initial.abdoStrap.y2} r="4" fill={SERIES.s2} />
        </g>

        {/* Callouts. Outside the rotating group so they stay level and readable. */}
        <g fontSize="9" fontWeight="600" fill={INK.muted} letterSpacing="0.4">
          <line x1="176" y1="136" x2="206" y2="126" stroke={SERIES.s1} strokeWidth="1" opacity="0.5" />
          <text x="210" y="129" fill={SERIES.s1}>UPPER CHEST</text>
          <line x1="170" y1="164" x2="206" y2="168" stroke={SERIES.s3} strokeWidth="1" opacity="0.5" />
          <text x="210" y="171" fill={SERIES.s3}>DIAPHRAGM</text>
          <line x1="176" y1="184" x2="206" y2="208" stroke={SERIES.s2} strokeWidth="1" opacity="0.5" />
          <text x="210" y="211" fill={SERIES.s2}>BELLY</text>
        </g>

        {!live && (
          <text x="140" y="322" textAnchor="middle" fontSize="9" fill={INK.muted} letterSpacing="0.5">
            WAITING FOR BOTH STRAPS
          </text>
        )}
      </svg>
    </div>
  );
}
