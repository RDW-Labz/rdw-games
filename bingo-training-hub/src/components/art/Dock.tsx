/* Loading-dock scene for the sign-in page: a half-open roll-up door, a
   trailer backed up to the dock, low sun pouring across the dock plate.
   Same two-pass toon lighting as the aisle scene, light from the door. */
import { useEffect, useId, useRef } from 'react';
import { reducedMotion } from '@/lib/motion';
import { Front, INK, LIT, SHADOW, poly, type Pal } from './Warehouse';

const DOOR = { x0: 150, x1: 560, top: 110, floor: 470 };

function Room({ p, stroke = false }: { p: Pal; stroke?: boolean }) {
  const s = stroke ? { stroke: INK, strokeWidth: 1.5, strokeLinejoin: 'round' as const, vectorEffect: 'non-scaling-stroke' as const } : {};
  const f = (c: string) => (stroke ? 'none' : c);
  const { x0, x1, top, floor } = DOOR;
  return (
    <g>
      {!stroke && (
        <>
          <path d={`M0 0H1200V${floor}H0Z M${x0} ${top + 104}V${floor}H${x1}V${top + 104}Z`} fill={p.wall} fillRule="evenodd" />
          <rect x="0" y="0" width="1200" height="56" fill={p.wallTop} />
          <polygon points={`0,${floor} 1200,${floor} 1200,600 0,600`} fill={p.floor} />
          {p === LIT && <polygon points={`0,${floor} 1200,${floor} 1200,600 0,600`} fill="url(#whHatchFine)" opacity=".22" />}
          {/* yellow-line safety zone in front of the door (orange in this palette) */}
          <path d={`M${x0 - 20} ${floor + 40}H${x1 + 20}`} stroke={p.floorMark} strokeWidth="6" strokeDasharray="30 18" />
        </>
      )}
      {/* door frame + header */}
      <g data-layer="1">
        <rect x={x0 - 22} y={top - 22} width={x1 - x0 + 44} height="22" fill={f(p.up)} {...s} />
        <rect x={x0 - 22} y={top} width="22" height={floor - top} fill={f(p.up)} {...s} />
        <rect x={x1} y={top} width="22" height={floor - top} fill={f(p.up)} {...s} />
        {/* roll-up door, half open */}
        <rect x={x0} y={top} width={x1 - x0} height="104" fill={f(p.deck)} {...s} />
        {stroke && [1, 2, 3, 4, 5].map((i) => <line key={i} x1={x0} y1={top + i * 17} x2={x1} y2={top + i * 17} stroke={INK} strokeWidth="1" opacity=".55" />)}
        <rect x={x0 + 180} y={top + 92} width="50" height="8" fill={f(p.cap)} {...s} />
        {/* dock bumpers */}
        <rect x={x0 + 18} y={floor - 46} width="22" height="40" fill={f('#1b2440')} {...s} />
        <rect x={x1 - 40} y={floor - 46} width="22" height="40" fill={f('#1b2440')} {...s} />
        {/* dock control box */}
        <rect x={x1 + 52} y="276" width="38" height="56" fill={f(p.tag)} {...s} />
        <circle cx={x1 + 71} cy="294" r="6" fill={f(p.floorMark === '#ec633d' ? '#ec633d' : '#5d86cf')} {...s} />
        <rect x={x1 + 62} y="308" width="18" height="12" fill={f(p.box2)} {...s} />
        {/* bollards */}
        {[x0 - 70, x1 + 130].map((x) => (
          <g key={x}>
            <rect x={x} y={floor - 90} width="22" height="96" fill={f(p.beam)} {...s} />
            {stroke && <path d={`M${x} ${floor - 66}h22M${x} ${floor - 40}h22`} stroke="#fdf8f0" strokeWidth="5" opacity=".9" />}
          </g>
        ))}
        {/* dock leveler plate */}
        <polygon points={poly(x0, floor, x1, floor, x1 + 26, floor + 34, x0 - 26, floor + 34)} fill={f(p.metal)} {...s} />
        {!stroke && <polygon points={poly(x0, floor, x1, floor, x1 + 26, floor + 34, x0 - 26, floor + 34)} fill="url(#dockDiamond)" opacity=".5" />}
      </g>
    </g>
  );
}

export function Dock({ className = '', label = 'DOCK 2', variant = 'trailer' }: { className?: string; label?: string; variant?: 'trailer' | 'pickup' }) {
  const id = useId().replace(/:/g, '');
  const root = useRef<SVGSVGElement>(null);
  const { x0, x1, top, floor } = DOOR;

  useEffect(() => {
    const svg = root.current;
    if (!svg || reducedMotion()) return;
    const layers = Array.from(svg.querySelectorAll<SVGGElement>('[data-layer]'));
    let raf = 0, tx = 0, ty = 0, cx = 0, cy = 0;
    const onMove = (e: PointerEvent) => {
      tx = (e.clientX / window.innerWidth - 0.5) * 2;
      ty = (e.clientY / window.innerHeight - 0.5) * 2;
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const tick = () => {
      cx += (tx - cx) * 0.08;
      cy += (ty - cy) * 0.08;
      layers.forEach((g) => {
        const d = Number(g.dataset.layer) * 5;
        g.setAttribute('transform', `translate(${(-cx * d).toFixed(2)} ${(-cy * d * 0.5).toFixed(2)})`);
      });
      raf = Math.abs(tx - cx) + Math.abs(ty - cy) > 0.002 ? requestAnimationFrame(tick) : 0;
    };
    window.addEventListener('pointermove', onMove);
    return () => {
      window.removeEventListener('pointermove', onMove);
      cancelAnimationFrame(raf);
    };
  }, []);

  // Light pours in through the door toward the viewer and to the right.
  const shaft = poly(x0, top + 104, x1, top + 104, 1200, 470, 1200, 600, 180, 600);
  const flip = 'translate(1520 0) scale(-1 1)';
  return (
    <svg ref={root} viewBox="0 0 1200 600" preserveAspectRatio="xMidYMid slice" className={`wh block h-full w-full ${className}`} role="img" aria-label="Illustration: a loading dock with a trailer backed up and a worker moving a pallet">
      <defs>
        <linearGradient id={`dsky${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f1efe8" />
          <stop offset="1" stopColor="#b5c4d2" />
        </linearGradient>
        <pattern id="whHatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="5" stroke="#1b2440" strokeWidth="0.9" strokeOpacity=".32" />
        </pattern>
        <pattern id="whHatchFine" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(-30)">
          <line x1="0" y1="0" x2="0" y2="4" stroke="#7d7466" strokeWidth="0.7" />
        </pattern>
        <pattern id="dockDiamond" width="10" height="6" patternUnits="userSpaceOnUse">
          <path d="M2 3l3-2 3 2-3 2z" fill="none" stroke="#1b2440" strokeWidth=".6" />
        </pattern>
        <clipPath id={`dlit${id}`}>
          <polygon className="wh-shaft" points={shaft} />
        </clipPath>
        <filter id={`dgd${id}`} x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.95" numOctaves="2" seed="5" stitchTiles="stitch" />
          <feColorMatrix values="0 0 0 0 0.05  0 0 0 0 0.07  0 0 0 0 0.16  4.2 0 0 0 -2.25" />
        </filter>
        <filter id={`dgl${id}`} x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="1.1" numOctaves="2" seed="11" stitchTiles="stitch" />
          <feColorMatrix values="0 0 0 0 1  0 0 0 0 0.98  0 0 0 0 0.94  -4.2 0 0 0 1.85" />
        </filter>
      </defs>

      {/* outside, seen through the opening: sky, tree line, then a trailer or a customer's pickup */}
      <g>
        <rect x={x0} y={top} width={x1 - x0} height={floor - top} fill={`url(#dsky${id})`} />
        <path d={`M${x0} 330l30-14 26 10 34-22 30 16 40-12 36 18 30-8 44 14 40-16 50 12 50-8v${floor - 330}H${x0}z`} fill="#8fa3b8" opacity=".55" />
      </g>
      {variant === 'pickup' ? (
        <g stroke={INK} strokeWidth="1.5" strokeLinejoin="round">
          {/* cab + bed, tailgate down, two boxes strapped */}
          <rect x={x0 + 60} y="268" width={x1 - x0 - 120} height="58" fill="#0447ad" />
          <rect x={x0 + 40} y="318" width={x1 - x0 - 80} height="96" fill="#024cb8" />
          <rect x={x0 + 78} y="246" width="78" height="54" fill="#d9c6a0" />
          <rect x={x0 + 168} y="232" width="96" height="68" fill="#ccb68c" />
          <rect x={x0 + 276} y="254" width="58" height="46" fill="#d9c6a0" />
          <path d={`M${x0 + 70} 300C${x0 + 150} 222 ${x0 + 280} 222 ${x1 - 70} 300`} fill="none" stroke="#ec633d" strokeWidth="4" />
          <polygon points={`${x0 + 40},414 ${x1 - 40},414 ${x1 - 20},446 ${x0 + 20},446`} fill="#c9c2b6" />
          <rect x={x0 + 46} y="330" width="22" height="34" fill="#ec633d" />
          <rect x={x1 - 68} y="330" width="22" height="34" fill="#ec633d" />
          <rect x={x0 + 150} y="352" width="110" height="26" fill="#fdf8f0" />
          <rect x={x0 + 34} y="446" width={x1 - x0 - 68} height="14" fill="#9a9284" />
          <rect x={x0 + 56} y="458" width="52" height="12" fill="#1b2440" />
          <rect x={x1 - 108} y="458" width="52" height="12" fill="#1b2440" />
        </g>
      ) : (
      <g>
        <rect x={x0 + 34} y="238" width={x1 - x0 - 68} height={floor - 238} fill="#c9c2b6" stroke={INK} strokeWidth="1.5" />
        <rect x={x0 + 52} y="254" width={x1 - x0 - 104} height={floor - 254} fill="#022d70" stroke={INK} strokeWidth="1.5" />
        {[0, 1, 2].map((i) => (
          <rect key={i} x={x0 + 70 + i * 92} y={floor - 70 - (i % 2) * 26} width="78" height={70 + (i % 2) * 26} fill="#0b56c4" stroke={INK} strokeWidth="1.2" />
        ))}
        <path d={`M${x0 + 34} 238v${floor - 238}M${x1 - 34} 238v${floor - 238}`} stroke="#9a9284" strokeWidth="6" />
      </g>
      )}

      <Room p={SHADOW} />
      <g clipPath={`url(#dlit${id})`}>
        <Room p={LIT} />
      </g>
      <g className="wh-lines">
        <Room p={SHADOW} stroke />
        <line x1="0" y1={floor} x2="1200" y2={floor} stroke={INK} strokeWidth="1.5" />
      </g>

      {/* worker + loaded pallet, mirrored so the light comes from behind them */}
      <g transform={flip}>
        <Front p={SHADOW} />
      </g>
      <g clipPath={`url(#dlit${id})`}>
        <g transform={flip}>
          <Front p={LIT} />
        </g>
      </g>
      <g className="wh-lines" transform={flip}>
        <Front p={SHADOW} stroke />
      </g>

      {/* dock sign */}
      <g data-layer="1">
        <rect x={x0 + 140} y="44" width="130" height="38" fill="#fdf8f0" stroke={INK} strokeWidth="1.5" />
        <text x={x0 + 205} y="69" textAnchor="middle" fontFamily="'Geist Mono', ui-monospace, monospace" fontSize="17" fontWeight="500" fill="#212121" letterSpacing="-0.3">
          {label}
        </text>
      </g>
      <rect width="1200" height="600" filter={`url(#dgd${id})`} opacity=".3" pointerEvents="none" />
      <rect width="1200" height="600" filter={`url(#dgl${id})`} opacity=".22" pointerEvents="none" />
      <style>{`
        .wh .wh-lines { animation: wh-ink 1.4s cubic-bezier(.333,0,0,1) both; }
        .wh .wh-box { animation: wh-drop .9s cubic-bezier(.2,0,.1,1) both; }
        @keyframes wh-ink { from { opacity: 0; } to { opacity: 1; } }
        @keyframes wh-drop { from { opacity: 0; transform: translateY(-14px); } to { opacity: 1; transform: none; } }
        @media (prefers-reduced-motion: reduce) { .wh .wh-lines, .wh .wh-box { animation: none; } }
      `}</style>
    </svg>
  );
}
