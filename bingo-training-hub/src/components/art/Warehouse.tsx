/* Original two-tone "cobalt & stone" warehouse illustration.
   Everything is drawn twice — once in shadow (cobalt) and once lit (stone) —
   and the lit copy is clipped to the sunlight shafts, giving the hard,
   toon-shaded light of the reference art. Oblique depth (faces step up-right),
   thick ink outlines, grain. Outlines draw in, stock drops onto the shelves,
   and the layers drift with the pointer. */
import { useEffect, useId, useRef } from 'react';
import { reducedMotion } from '@/lib/motion';

export type Pal = {
  wall: string; wallTop: string; floor: string; floorMark: string; up: string; upSide: string; beam: string; beamTop: string; deck: string;
  box: string; box2: string; boxTop: string; boxSide: string; tag: string; pallet: string; jack: string; vest: string; shirt: string; skin: string; pants: string; cap: string; metal: string;
};
export const SHADOW: Pal = {
  wall: '#024cb8', wallTop: '#023689', floor: '#0b3f9c', floorMark: '#1f58b8', up: '#023a92', upSide: '#022d70', beam: '#1d55b5', beamTop: '#2a64c4', deck: '#033f9e',
  box: '#0b58c8', box2: '#0447ad', boxTop: '#2a6fd6', boxSide: '#033684', tag: '#5d86cf', pallet: '#03367f', jack: '#0a3f98', vest: '#2b5cc0', shirt: '#0b4fb8', skin: '#2a63c6', pants: '#022c6e', cap: '#022560', metal: '#0b3c8f',
};
export const LIT: Pal = {
  wall: '#cbc4b8', wallTop: '#b9b1a4', floor: '#c1baae', floorMark: '#ec633d', up: '#aaa295', upSide: '#948b7d', beam: '#ec633d', beamTop: '#f28a68', deck: '#b4ab9c',
  box: '#d9c6a0', box2: '#ccb68c', boxTop: '#e8dbbd', boxSide: '#b09a73', tag: '#fdf8f0', pallet: '#b3a998', jack: '#e05c3a', vest: '#ec633d', shirt: '#3c4f78', skin: '#e2c7ac', pants: '#3c4f78', cap: '#283f7d', metal: '#9a9284',
};
export const INK = '#1b2440';

const LV = [470, 334, 204];
const UP = [36, 272, 508, 744];
// x, w, h, level, alt, tagged
const BOXES: [number, number, number, number, 0 | 1, 0 | 1][] = [
  [56, 92, 70, 0, 0, 1], [152, 64, 52, 0, 1, 0], [220, 40, 84, 0, 0, 0],
  [292, 120, 88, 0, 1, 1], [418, 74, 60, 0, 0, 0],
  [530, 64, 96, 0, 0, 0], [598, 128, 64, 0, 1, 1],
  [56, 70, 56, 1, 1, 0], [130, 120, 74, 1, 0, 1],
  [292, 58, 92, 1, 0, 0], [354, 84, 50, 1, 1, 1], [442, 52, 70, 1, 0, 0],
  [530, 100, 82, 1, 1, 1], [634, 92, 58, 1, 0, 0],
  [60, 104, 66, 2, 0, 1], [170, 80, 90, 2, 1, 0],
  [300, 92, 60, 2, 1, 0], [396, 92, 84, 2, 0, 1],
  [534, 58, 52, 2, 0, 0], [596, 126, 96, 2, 1, 1],
];

export const poly = (...p: number[]) => p.join(' ');
// One-point perspective: every depth edge runs toward the window light.
const VPX = 1010, VPY = 118, K = 0.05;
const dp = (x: number, y: number) => [x + (VPX - x) * K, y + (VPY - y) * K] as const;
const pts = (...p: (readonly [number, number])[]) => p.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(' ');

/** front rect + perspective top + side faces */
export function Block({ x, y, w, h, front, top, side, stroke, delay }: { x: number; y: number; w: number; h: number; front: string; top: string; side: string; stroke?: boolean; delay?: number }) {
  const s = stroke ? { stroke: INK, strokeWidth: 1.5, strokeLinejoin: 'round' as const, vectorEffect: 'non-scaling-stroke' as const } : {};
  const A = [x, y] as const, B = [x + w, y] as const, C = [x + w, y + h] as const, D = [x, y + h] as const;
  const showTop = y > VPY;
  const right = x + w < VPX;
  return (
    <g className={delay !== undefined ? 'wh-box' : undefined} style={delay !== undefined ? { animationDelay: `${delay}s` } : undefined}>
      {right ? <polygon points={pts(B, dp(...B), dp(...C), C)} fill={stroke ? 'url(#whHatch)' : side} {...s} /> : <polygon points={pts(A, dp(...A), dp(...D), D)} fill={stroke ? 'url(#whHatch)' : side} {...s} />}
      {showTop && <polygon points={pts(A, B, dp(...B), dp(...A))} fill={top} {...s} />}
      <rect x={x} y={y} width={w} height={h} fill={front} {...s} />
    </g>
  );
}

function Worker({ p, stroke }: { p: Pal; stroke?: boolean }) {
  const s = stroke ? { stroke: INK, strokeWidth: 1.5, strokeLinejoin: 'round' as const, strokeLinecap: 'round' as const, vectorEffect: 'non-scaling-stroke' as const } : {};
  const f = (c: string) => (stroke ? 'none' : c);
  const h = stroke ? { fill: 'url(#whHatch)' } : null; // pencil hatch on the shaded side (ink pass only)
  // side view, facing left, pulling the jack tiller with both hands at ~(1004, 424)
  return (
    <g>
      {/* far arm: upper arm + forearm, mitten hand on the grip */}
      <polygon points="1046,394 1062,400 1050,438 1036,433" fill={f(p.pants)} {...s} />
      <polygon points="1036,433 1050,438 1014,430 1008,419" fill={f(p.pants)} {...s} />
      {/* back leg (shaded) */}
      <polygon points="1064,474 1090,472 1100,554 1074,558" fill={f(p.pants)} {...s} />
      {h && <polygon points="1064,474 1090,472 1100,554 1074,558" {...h} />}
      <path d="M1070 554l32-3c3 0 5 3 4 7l-1 6h-43z" fill={f(p.cap)} {...s} />
      {/* front leg, stepping */}
      <polygon points="1038,476 1068,476 1054,556 1027,551" fill={f(p.pants)} {...s} />
      <path d="M1018 549l36 3-1 13h-42c-2-6 1-12 7-16z" fill={f(p.cap)} {...s} />
      {/* torso: tapered, shoulders wider than the waist */}
      <path d="M1026 392c10-8 54-12 74-6l-6 92-60 2z" fill={f(p.shirt)} {...s} />
      <path d="M1031 396c9-6 46-9 64-4l-5 84-54 2z" fill={f(p.vest)} {...s} />
      {h && <path d="M1074 393c8 0 15 1 21 3l-5 80-16 1z" {...h} />}
      {stroke && <path d="M1036 446h53M1037 458h52" stroke="#fdf8f0" strokeWidth="3.2" opacity=".9" />}
      {stroke && <path d="M1054 398l2 78" stroke={INK} strokeWidth="1" opacity=".5" />}
      <rect x="1034" y="474" width="58" height="8" fill={f(p.pants)} {...s} />
      {/* near arm: sleeve bent at the elbow, mitten on the grip */}
      <path d="M1058 398c10 0 18 4 20 10l-14 40-17-5z" fill={f(p.shirt)} {...s} />
      <polygon points="1047,443 1064,448 1022,440 1016,427" fill={f(p.shirt)} {...s} />
      {h && <path d="M1066 404c5 1 9 3 12 6l-12 36-6-2z" {...h} />}
      <path d="M1000 418c4-6 14-6 18 0l2 10c-2 7-14 9-19 3z" fill={f(p.skin)} {...s} />
      {/* thick neck + head in 3/4 profile, facing left */}
      <path d="M1053 362h24l3 30h-29z" fill={f(p.skin)} {...s} />
      <path d="M1066 331C1078 331 1084 341 1083 352C1082 362 1076 369 1066 371C1058 372 1052 369 1049 363L1047 357L1043 355L1046 351L1047 344C1050 336 1057 331 1066 331Z" fill={f(p.skin)} {...s} />
      {h && <path d="M1072 335c7 3 11 10 11 17s-3 13-9 16z" {...h} />}
      <ellipse cx="1071" cy="353" rx="3.2" ry="4.2" fill={f(p.skin)} {...s} />
      <path d="M1045 348c0-14 9-22 21-22s20 8 20 19z" fill={f(p.cap)} {...s} />
      <path d="M1048 344h-17c0-4 4-7 9-7h8z" fill={f(p.cap)} {...s} />
      {stroke && <path d="M1049 342.5l7-1M1050 363.5c2 1 4 1 6-.5" fill="none" stroke={INK} strokeWidth="1.3" strokeLinecap="round" />}
      {stroke && <circle cx="1053" cy="347.5" r="1.5" fill={INK} />}
    </g>
  );
}

export function Front({ p, stroke = false }: { p: Pal; stroke?: boolean }) {
  const s = stroke ? { stroke: INK, strokeWidth: 1.5, vectorEffect: 'non-scaling-stroke' as const } : {};
  return (
    <g transform="translate(0 -38)">
      {!stroke && p === LIT && (
        <g data-layer="2" fill={SHADOW.floor}>
          {/* hard cast shadows, thrown away from the window */}
          <polygon points="702,570 990,570 820,638 520,638" />
          <polygon points="1010,566 1104,566 990,638 880,638" />
          <polygon points="950,566 990,566 905,638 860,638" />
        </g>
      )}
      <g data-layer="2">
        {/* pallet + load */}
        {/* forks run inside the pallet, rollers at the tips */}
        <rect x="716" y="562" width="252" height="7" fill={stroke ? 'none' : p.jack} {...s} />
        <circle cx="726" cy="573" r="5" fill={stroke ? 'none' : p.cap} {...s} />
        <circle cx="830" cy="573" r="5" fill={stroke ? 'none' : p.cap} {...s} />
        <Block x={700} y={548} w={250} h={12} front={stroke ? 'none' : p.pallet} top={stroke ? 'none' : p.deck} side={stroke ? 'none' : p.pallet} stroke={stroke} />
        {[710, 814, 918].map((x) => (
          <rect key={x} x={x} y="560" width="22" height="12" fill={stroke ? 'none' : p.pallet} {...s} />
        ))}
        <Block x={712} y={456} w={104} h={92} front={stroke ? 'none' : p.box} top={stroke ? 'none' : p.boxTop} side={stroke ? 'none' : p.boxSide} stroke={stroke} />
        <Block x={828} y={476} w={104} h={72} front={stroke ? 'none' : p.box2} top={stroke ? 'none' : p.boxTop} side={stroke ? 'none' : p.boxSide} stroke={stroke} />
        <Block x={736} y={392} w={140} h={64} front={stroke ? 'none' : p.box2} top={stroke ? 'none' : p.boxTop} side={stroke ? 'none' : p.boxSide} stroke={stroke} />
        <rect x="748" y="404" width="40" height="22" fill={stroke ? 'none' : p.tag} {...s} />
        {stroke && <path d="M754 412h26M754 419h18" stroke={INK} />}
        {/* pallet jack: forks under the pallet, tiller to the worker */}
        <rect x="950" y="552" width="40" height="12" fill={stroke ? 'none' : p.jack} {...s} />
        <polygon points="966,552 982,552 1012,424 1000,420" fill={stroke ? 'none' : p.jack} {...s} />
        <rect x="992" y="410" width="30" height="10" fill={stroke ? 'none' : p.jack} {...s} transform="rotate(14 1006 415)" />
        <circle cx="976" cy="572" r="12" fill={stroke ? 'none' : p.cap} {...s} />
        <Worker p={p} stroke={stroke} />
      </g>
    </g>
  );
}

function Scene({ p, stroke = false, part }: { p: Pal; stroke?: boolean; part: 'back' | 'front' }) {
  const s = stroke ? { stroke: INK, strokeWidth: 1.5, vectorEffect: 'non-scaling-stroke' as const } : {};
  if (part === 'front') return <Front p={p} stroke={stroke} />;
  return (
    <>
      {!stroke && (
        <>
          <rect x="0" y="0" width="1200" height="470" fill={p.wall} />
          <rect x="0" y="0" width="1200" height="60" fill={p.wallTop} />
          <polygon points="0,470 1200,470 1200,600 0,600" fill={p.floor} />
          {/* aisle floor marking */}
          <path d="M0 520h1200" stroke={p.floorMark} strokeWidth="6" strokeDasharray="44 26" />
          {p === LIT && <polygon points="0,470 1200,470 1200,600 0,600" fill="url(#whHatchFine)" opacity=".22" />}
          {p === LIT && <rect x="0" y="64" width="1200" height="406" fill="url(#whHatchFine)" opacity=".12" />}
        </>
      )}
      {/* lamps */}
      <g data-layer="1">
        {[160, 640].map((x) => (
          <g key={x}>
            <line x1={x} y1="0" x2={x} y2="30" stroke={INK} strokeWidth="1.5" />
            <polygon points={poly(x - 22, 46, x + 22, 46, x + 8, 30, x - 8, 30)} fill={stroke ? 'none' : p.cap} {...s} />
            {!stroke && <ellipse cx={x} cy="47" rx="16" ry="3" fill="#fdf3d8" />}
          </g>
        ))}
      </g>
      <g data-layer="1">
        {/* uprights */}
        {UP.map((x) => (
          <Block key={x} x={x} y={70} w={16} h={400} front={stroke ? 'none' : p.up} top={stroke ? 'none' : p.upSide} side={stroke ? 'none' : p.upSide} stroke={stroke} />
        ))}
        {/* decks + beams */}
        {[LV[2], LV[1]].map((y) => (
          <g key={y}>
            <polygon points={pts([36, y], [760, y], dp(760, y), dp(36, y))} fill={stroke ? 'none' : p.deck} {...s} />
            <rect x="36" y={y} width="724" height="11" fill={stroke ? 'none' : p.beam} {...s} />
          </g>
        ))}
        <rect x="36" y="74" width="724" height="11" fill={stroke ? 'none' : p.beam} {...s} />
        {/* bay number plates on beams */}
        {[0, 1, 2].map((i) =>
          [LV[1], LV[2]].map((y) => (
            <g key={i + '-' + y}>
              <rect x={60 + i * 236} y={y + 1.5} width="26" height="8" fill={stroke ? 'none' : p.tag} {...s} />
            </g>
          ))
        )}
        {!stroke && p === LIT && [508, 744].map((x) => <polygon key={'us' + x} points={poly(x, 70, x - 40, 96, x - 40, 470, x, 470)} fill={SHADOW.wall} />)}
        {/* stock — boxes in the sun throw hard shadows down-left onto the wall */}
        {!stroke && p === LIT &&
          BOXES.filter(([x]) => x > 470).map(([x, w, h, lv], i) => (
            <polygon key={'sh' + i} points={poly(x, LV[lv] - h, x - 34, LV[lv] - h + 22, x - 34, LV[lv] + 6, x + w - 8, LV[lv] + 6, x + w - 8, LV[lv])} fill={SHADOW.wall} />
          ))}
        {BOXES.map(([x, w, h, lv, alt, tag], i) => (
          <g key={i}>
            <Block x={x} y={LV[lv] - h} w={w - 8} h={h} front={stroke ? 'none' : alt ? p.box2 : p.box} top={stroke ? 'none' : p.boxTop} side={stroke ? 'none' : p.boxSide} stroke={stroke} delay={0.35 + i * 0.04} />
            {tag === 1 && (
              <g className="wh-box" style={{ animationDelay: `${0.5 + i * 0.04}s` }}>
                <rect x={x + 8} y={LV[lv] - h + 10} width="30" height="18" fill={stroke ? 'none' : p.tag} {...s} />
                {stroke && <path d={`M${x + 12} ${LV[lv] - h + 16}h18M${x + 12} ${LV[lv] - h + 22}h12`} stroke={INK} strokeWidth="1" />}
              </g>
            )}
            {stroke && <line x1={x + (w - 8) / 2} y1={LV[lv] - h} x2={x + (w - 8) / 2} y2={LV[lv] - h + Math.min(16, h / 3)} stroke={INK} strokeOpacity=".6" />}
          </g>
        ))}
      </g>
    </>
  );
}

export function Warehouse({ className = '', label = 'AISLE 04', view }: { className?: string; label?: string; view?: string }) {
  const id = useId().replace(/:/g, '');
  const root = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const svg = root.current;
    if (!svg || reducedMotion()) return;
    const layers = Array.from(svg.querySelectorAll<SVGGElement>('[data-layer]'));
    let raf = 0;
    let tx = 0, ty = 0, cx = 0, cy = 0;
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

  return (
    <svg ref={root} viewBox={view ?? '0 0 1200 600'} preserveAspectRatio="xMaxYMid slice" className={`wh block h-full w-full ${className}`} role="img" aria-label="Illustration: a worker pulls a loaded pallet past warehouse racking">
      <defs>
        <linearGradient id={`sky${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#eef1ef" />
          <stop offset="1" stopColor="#a6bbd0" />
        </linearGradient>
        <pattern id="whHatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="5" stroke="#1b2440" strokeWidth="0.9" strokeOpacity=".42" />
        </pattern>
        <pattern id="whHatchFine" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(-30)">
          <line x1="0" y1="0" x2="0" y2="4" stroke="#7d7466" strokeWidth="0.7" />
        </pattern>
        <clipPath id={`lit${id}`}>
          <polygon className="wh-shaft" points="900,64 1150,64 1090,600 560,600" />
          <polygon className="wh-shaft" points="872,64 888,64 516,600 486,600" />
        </clipPath>
        <filter id={`gd${id}`} x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.95" numOctaves="2" seed="3" stitchTiles="stitch" />
          <feColorMatrix values="0 0 0 0 0.05  0 0 0 0 0.07  0 0 0 0 0.16  4.2 0 0 0 -2.25" />
        </filter>
        <filter id={`gl${id}`} x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="1.1" numOctaves="2" seed="9" stitchTiles="stitch" />
          <feColorMatrix values="0 0 0 0 1  0 0 0 0 0.98  0 0 0 0 0.94  -4.2 0 0 0 1.85" />
        </filter>
      </defs>
      <Scene p={SHADOW} part="back" />
      <g clipPath={`url(#lit${id})`}>
        <Scene p={LIT} part="back" />
      </g>
      {/* clerestory window */}
      <g>
        <rect x="900" y="64" width="250" height="120" fill={`url(#sky${id})`} />
        <path d="M900 124h250M962 64v120M1025 64v120M1088 64v120" stroke="#023689" strokeWidth="4" />
        <rect x="900" y="64" width="250" height="120" fill="none" stroke={INK} strokeWidth="1.5" />
        <path d="M915 150l40-30 30 18 40-44 50 40 40-20" fill="none" stroke="#7f98b6" strokeWidth="1.2" opacity=".7" />
      </g>
      <g className="wh-lines">
        <Scene p={SHADOW} stroke part="back" />
        <line x1="0" y1="470" x2="1200" y2="470" stroke={INK} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </g>
      <Scene p={SHADOW} part="front" />
      <g clipPath={`url(#lit${id})`}>
        <Scene p={LIT} part="front" />
      </g>
      <g className="wh-lines">
        <Scene p={SHADOW} stroke part="front" />
      </g>
      {/* aisle sign */}
      <g data-layer="1">
        <line x1="560" y1="0" x2="560" y2="20" stroke={INK} strokeWidth="1.5" />
        <line x1="652" y1="0" x2="652" y2="20" stroke={INK} strokeWidth="1.5" />
        <rect x="532" y="20" width="148" height="38" fill="#fdf8f0" stroke={INK} strokeWidth="1.5" />
        <text x="606" y="45" textAnchor="middle" fontFamily="'Geist Mono', ui-monospace, monospace" fontSize="17" fontWeight="500" fill="#212121" letterSpacing="-0.3">
          {label}
        </text>
      </g>
      <rect width="1200" height="600" filter={`url(#gd${id})`} opacity=".3" pointerEvents="none" />
      <rect width="1200" height="600" filter={`url(#gl${id})`} opacity=".22" pointerEvents="none" />
      <style>{`
        .wh .wh-lines { animation: wh-ink 1.4s cubic-bezier(.333,0,0,1) both; }
        .wh .wh-box { animation: wh-drop .9s cubic-bezier(.2,0,.1,1) both; }
        .wh .wh-shaft { animation: wh-shaft 9s ease-in-out infinite alternate; transform-origin: 1025px 64px; }
        @keyframes wh-ink { from { opacity: 0; } to { opacity: 1; } }
        @keyframes wh-drop { from { opacity: 0; transform: translateY(-14px); } to { opacity: 1; transform: none; } }
        @keyframes wh-shaft { from { transform: rotate(-1.1deg); } to { transform: rotate(1.3deg); } }
        @media (prefers-reduced-motion: reduce) { .wh .wh-lines, .wh .wh-box, .wh .wh-shaft { animation: none; } }
      `}</style>
    </svg>
  );
}
