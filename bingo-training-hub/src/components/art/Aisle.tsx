/* One-point-perspective warehouse aisle for the employee home: racking
   recedes to the far wall's window, sun pours down the aisle and through
   high side windows in hard stripes. Same cobalt/stone two-pass toon light
   as the other scenes; the worker + pallet sprite stands in the foreground. */
import { useEffect, useId, useRef } from 'react';
import { reducedMotion } from '@/lib/motion';
import { Front, INK, LIT, SHADOW, type Pal } from './Warehouse';

const CX = 960, CY = 300, F = 700, EYE = 1.7;
const P = (x: number, y: number, z: number) => [CX + (F * x) / z, CY - (F * (y - EYE)) / z] as const;
const pt = (...ps: (readonly [number, number])[]) => ps.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(' ');
const RX = -5; // rack face plane
const UPS = [3.2, 4.6, 6.4, 8.8, 11.6, 14.6];
const LV = [0.12, 1.3, 2.5, 3.65];
const ZEND = 16;

// boxes: [z0, z1, level, height, kraft?]
const BOX: [number, number, number, number, 0 | 1][] = [];
(() => {
  let seed = 7;
  const r = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  for (let b = 0; b < UPS.length - 1; b++) {
    for (let l = 0; l < 3; l++) {
      let z = UPS[b] + 0.12;
      const end = UPS[b + 1] - 0.1;
      while (z < end - 0.4) {
        const len = Math.min(end - z, (UPS[b + 1] - UPS[b]) * (0.28 + r() * 0.36));
        BOX.push([z, z + len, l, 0.45 + r() * 0.6, r() > 0.45 ? 1 : 0]);
        z += len + 0.08 + r() * 0.1;
      }
    }
  }
})();

function Scene({ p, stroke = false }: { p: Pal; stroke?: boolean }) {
  const s = stroke ? { stroke: INK, strokeWidth: 1.4, strokeLinejoin: 'round' as const, vectorEffect: 'non-scaling-stroke' as const } : {};
  const f = (c: string) => (stroke ? 'none' : c);
  const far = (x: number, y: number) => P(x, y, ZEND);
  return (
    <g>
      {!stroke && (
        <>
          {/* ceiling, floor, end wall, right wall */}
          <polygon points={pt([0, 0], [1200, 0], far(3, 5.2), far(RX, 5.2))} fill={p.wallTop} />
          <polygon points={pt([0, 600], [1200, 600], far(3, 0), far(RX, 0))} fill={p.floor} />
          {p === LIT && <polygon points={pt([0, 600], [1200, 600], far(3, 0), far(RX, 0))} fill="url(#whHatchFine)" opacity=".2" />}
          <polygon points={pt(far(RX, 0), far(3, 0), far(3, 5.2), far(RX, 5.2))} fill={p.wall} />
          <polygon points={pt(P(3, 0, 9), far(3, 0), far(3, 5.2), P(3, 5.2, 9))} fill={p.up} />
          {/* aisle lines on the floor */}
          <polyline points={pt(P(-1.4, 0, 3), far(-1.4, 0))} stroke={p.floorMark} strokeWidth="5" strokeDasharray="34 22" fill="none" />
          <polyline points={pt(P(1.6, 0, 3), far(1.6, 0))} stroke={p.floorMark} strokeWidth="5" strokeDasharray="34 22" fill="none" />
        </>
      )}
      {/* rack: back panel, uprights, beams, stock */}
      <polygon points={pt(P(RX, 0, UPS[0]), P(RX, 0, ZEND), P(RX, LV[3] + 0.12, ZEND), P(RX, LV[3] + 0.12, UPS[0]))} fill={f(p.deck)} {...(stroke ? {} : {})} />
      {BOX.map(([z0, z1, l, h, k], i) => {
        const y0 = LV[l] + 0.08;
        const face = pt(P(RX, y0, z0), P(RX, y0, z1), P(RX, y0 + h, z1), P(RX, y0 + h, z0));
        // top face visible below eye height: step into the rack (x more negative)
        const top = y0 + h < EYE ? pt(P(RX, y0 + h, z0), P(RX, y0 + h, z1), P(RX - 0.7, y0 + h, z1), P(RX - 0.7, y0 + h, z0)) : null;
        const zm = (z0 + z1) / 2;
        return (
          <g key={i} className="wh-box" style={{ animationDelay: `${0.3 + (i % 18) * 0.03}s` }}>
            {top && <polygon points={top} fill={f(p.boxTop)} {...s} />}
            <polygon points={face} fill={f(k ? p.box : p.box2)} {...s} />
            {stroke && k === 1 && h > 0.55 && i % 2 === 0 && <polygon points={pt(P(RX, y0 + h * 0.52, zm - 0.07), P(RX, y0 + h * 0.52, zm + 0.07), P(RX, y0 + h * 0.7, zm + 0.07), P(RX, y0 + h * 0.7, zm - 0.07))} fill="#fdf8f0" stroke={INK} strokeWidth=".9" />}
          </g>
        );
      })}
      {LV.slice(1).map((y) => (
        <polygon key={y} points={pt(P(RX, y, UPS[0] - 0.4), P(RX, y, ZEND), P(RX, y + 0.12, ZEND), P(RX, y + 0.12, UPS[0] - 0.4))} fill={f(p.beam)} {...s} />
      ))}
      {UPS.map((z) => (
        <polygon key={z} points={pt(P(RX, 0, z), P(RX, 0, z + 0.14), P(RX, LV[3] + 0.3, z + 0.14), P(RX, LV[3] + 0.3, z))} fill={f(p.up)} {...s} />
      ))}
      {stroke && <polygon points={pt(P(RX, 0, ZEND), P(3, 0, ZEND), P(3, 5.2, ZEND), P(RX, 5.2, ZEND))} fill="none" {...s} />}
      {/* lamps down the aisle */}
      {[5, 8.5, 12.5].map((z) => {
        const [x, y] = P(-0.8, 4.9, z);
        const w = 300 / z;
        return (
          <g key={z}>
            <line x1={x} y1={y - 400 / z} x2={x} y2={y} stroke={INK} strokeWidth="1.2" />
            <polygon points={pt([x - w / 2, y + w / 2.6], [x + w / 2, y + w / 2.6], [x + w / 5, y], [x - w / 5, y])} fill={f(p.cap)} {...s} />
          </g>
        );
      })}
    </g>
  );
}

export function Aisle({ className = '', label = 'AISLE 04' }: { className?: string; label?: string }) {
  const id = useId().replace(/:/g, '');
  const root = useRef<SVGSVGElement>(null);
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
      layers.forEach((g) => g.setAttribute('transform', `translate(${(-cx * Number(g.dataset.layer) * 5).toFixed(2)} ${(-cy * Number(g.dataset.layer) * 2.5).toFixed(2)})`));
      raf = Math.abs(tx - cx) + Math.abs(ty - cy) > 0.002 ? requestAnimationFrame(tick) : 0;
    };
    window.addEventListener('pointermove', onMove);
    return () => {
      window.removeEventListener('pointermove', onMove);
      cancelAnimationFrame(raf);
    };
  }, []);

  const win = [P(0.2, 2.1, ZEND), P(2.6, 2.1, ZEND), P(2.6, 3.9, ZEND), P(0.2, 3.9, ZEND)] as const;
  // sun down the aisle from the end window, plus stripes from high side windows
  const shaftEnd = pt(win[3], win[2], P(2.8, 0, 3.1), P(-1.9, 0, 3.1));
  // high side windows: each throws a slanted patch onto the rack face and a patch on the floor
  const stripes = [3.4, 6.2, 9.6].flatMap((z, i) => {
    const w = 0.9 + i * 0.25;
    return [
      pt(P(RX, 3.9, z), P(RX, 3.9, z + w), P(RX, 0.05, z + w + 1.6), P(RX, 0.05, z + 1.6)),
      pt(P(RX, 0, z + 1.6), P(RX, 0, z + w + 1.6), P(-0.2, 0, z + w + 2.6), P(-0.2, 0, z + 2.6)),
    ];
  });
  // the end window's patch lands on the floor in front of the worker
  const floorPatch = pt(P(-1.6, 0, 3.4), P(2.4, 0, 3.4), P(2.4, 0, 6.2), P(-1.6, 0, 6.2));
  const flip = 'translate(-40 30) scale(1)';
  return (
    <svg ref={root} viewBox="0 0 1200 600" preserveAspectRatio="xMaxYMid slice" className={`wh block h-full w-full ${className}`} role="img" aria-label="Illustration: a warehouse aisle with sun pouring down it and a worker pulling a pallet">
      <defs>
        <linearGradient id={`asky${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f1efe8" />
          <stop offset="1" stopColor="#a8bdd1" />
        </linearGradient>
        <pattern id="whHatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="5" stroke="#1b2440" strokeWidth="0.9" strokeOpacity=".42" />
        </pattern>
        <pattern id="whHatchFine" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(-30)">
          <line x1="0" y1="0" x2="0" y2="4" stroke="#7d7466" strokeWidth="0.7" />
        </pattern>
        <clipPath id={`alit${id}`}>
          <polygon className="wh-shaft" points={shaftEnd} />
          <polygon points={floorPatch} />
          {stripes.map((st, i) => (
            <polygon key={i} points={st} />
          ))}
        </clipPath>
        <filter id={`agd${id}`} x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.95" numOctaves="2" seed="4" stitchTiles="stitch" />
          <feColorMatrix values="0 0 0 0 0.05  0 0 0 0 0.07  0 0 0 0 0.16  4.2 0 0 0 -2.25" />
        </filter>
        <filter id={`agl${id}`} x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="1.1" numOctaves="2" seed="13" stitchTiles="stitch" />
          <feColorMatrix values="0 0 0 0 1  0 0 0 0 0.98  0 0 0 0 0.94  -4.2 0 0 0 1.85" />
        </filter>
      </defs>
      <g data-layer="0">
        <Scene p={SHADOW} />
        <g clipPath={`url(#alit${id})`}>
          <Scene p={LIT} />
        </g>
        <polygon points={pt(...win)} fill={`url(#asky${id})`} stroke={INK} strokeWidth="1.4" />
        <polyline points={pt([(win[0][0] + win[1][0]) / 2, win[0][1]], [(win[2][0] + win[3][0]) / 2, win[2][1]])} stroke="#023689" strokeWidth="3" />
        <polyline points={pt([win[0][0], (win[0][1] + win[3][1]) / 2], [win[1][0], (win[1][1] + win[2][1]) / 2])} stroke="#023689" strokeWidth="3" />
        <g className="wh-lines">
          <Scene p={SHADOW} stroke />
        </g>
      </g>
      <g transform={flip}>
        <Front p={SHADOW} />
        <g clipPath={`url(#alit${id})`}>
          <Front p={LIT} />
        </g>
        <g className="wh-lines">
          <Front p={SHADOW} stroke />
        </g>
      </g>
      <g data-layer="1">
        <line x1="560" y1="0" x2="560" y2="24" stroke={INK} strokeWidth="1.5" />
        <line x1="652" y1="0" x2="652" y2="24" stroke={INK} strokeWidth="1.5" />
        <rect x="532" y="24" width="148" height="38" fill="#fdf8f0" stroke={INK} strokeWidth="1.5" />
        <text x="606" y="49" textAnchor="middle" fontFamily="'Geist Mono', ui-monospace, monospace" fontSize="17" fontWeight="500" fill="#212121" letterSpacing="-0.3">
          {label}
        </text>
      </g>
      <rect width="1200" height="600" filter={`url(#agd${id})`} opacity=".3" pointerEvents="none" />
      <rect width="1200" height="600" filter={`url(#agl${id})`} opacity=".22" pointerEvents="none" />
      <style>{`
        .wh .wh-lines { animation: wh-ink 1.4s cubic-bezier(.333,0,0,1) both; }
        .wh .wh-box { animation: wh-drop .9s cubic-bezier(.2,0,.1,1) both; }
        @keyframes wh-ink { from { opacity: 0; } to { opacity: 1; } }
        @keyframes wh-drop { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: none; } }
        @media (prefers-reduced-motion: reduce) { .wh .wh-lines, .wh .wh-box { animation: none; } }
      `}</style>
    </svg>
  );
}
