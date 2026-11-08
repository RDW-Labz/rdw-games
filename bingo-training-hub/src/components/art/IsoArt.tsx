/* Small isometric "toy" objects in the cobalt/stone palette — section
   emblems for folders and floating props for the navy band. Each one is
   built from boxes with lit tops (stone), cobalt sides and an ink outline. */
type B = { x: number; y: number; z: number; w: number; d: number; h: number; top?: string; left?: string; right?: string; tag?: boolean };

const C = Math.cos(Math.PI / 6);
const S = Math.sin(Math.PI / 6);
const pr = (x: number, y: number, z: number) => [(x - y) * C, (x + y) * S - z] as const;
const pts = (...p: (readonly [number, number])[]) => p.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(' ');
const INK = '#1b2440';

const STONE = '#d9d1c2', COBALT = '#024cb8', DEEP = '#023689', KRAFT = '#d6c29c', KRAFT_S = '#b39c74', ORANGE = '#ec633d', NAVY = '#283f7d';

function Box({ b }: { b: B }) {
  const { x, y, z, w, d, h } = b;
  const top = pts(pr(x, y, z + h), pr(x + w, y, z + h), pr(x + w, y + d, z + h), pr(x, y + d, z + h));
  const left = pts(pr(x, y + d, z), pr(x + w, y + d, z), pr(x + w, y + d, z + h), pr(x, y + d, z + h));
  const right = pts(pr(x + w, y, z), pr(x + w, y + d, z), pr(x + w, y + d, z + h), pr(x + w, y, z + h));
  const s = { stroke: INK, strokeWidth: 1.3, strokeLinejoin: 'round' as const };
  return (
    <g>
      <polygon points={left} fill={b.left ?? COBALT} {...s} />
      <polygon points={right} fill={b.right ?? DEEP} {...s} />
      <polygon points={top} fill={b.top ?? STONE} {...s} />
      {b.tag && <polygon points={pts(pr(x + w * 0.2, y + d, z + h * 0.35), pr(x + w * 0.62, y + d, z + h * 0.35), pr(x + w * 0.62, y + d, z + h * 0.72), pr(x + w * 0.2, y + d, z + h * 0.72))} fill="#fdf8f0" {...s} />}
    </g>
  );
}

const KINDS: Record<string, B[]> = {
  pallet: [
    { x: 0, y: 0, z: 0, w: 64, d: 64, h: 6, top: COBALT, left: '#0447ad', right: DEEP },
    { x: 4, y: 4, z: 6, w: 28, d: 56, h: 30, top: KRAFT, left: KRAFT_S, right: DEEP, tag: true },
    { x: 34, y: 4, z: 6, w: 26, d: 26, h: 22, top: KRAFT, left: KRAFT_S, right: DEEP },
    { x: 34, y: 32, z: 6, w: 26, d: 28, h: 40, top: KRAFT, left: KRAFT_S, right: DEEP, tag: true },
  ],
  lot: [
    { x: 0, y: 0, z: 0, w: 56, d: 46, h: 40, top: KRAFT, left: KRAFT_S, right: DEEP, tag: true },
    { x: 8, y: 6, z: 40, w: 36, d: 30, h: 22, top: STONE, left: ORANGE, right: '#c14d2c' },
  ],
  counter: [
    { x: 0, y: 0, z: 0, w: 70, d: 28, h: 30, top: STONE, left: COBALT, right: DEEP },
    { x: 44, y: 4, z: 30, w: 20, d: 18, h: 14, top: '#fdf8f0', left: NAVY, right: DEEP },
    { x: 8, y: 6, z: 30, w: 24, d: 14, h: 3, top: '#fdf8f0', left: '#e9e1d2', right: '#cfc6b6' },
  ],
  night: [
    { x: 0, y: 0, z: 0, w: 34, d: 34, h: 34, top: STONE, left: COBALT, right: DEEP },
    { x: 36, y: 0, z: 0, w: 26, d: 26, h: 52, top: STONE, left: NAVY, right: DEEP },
    { x: 0, y: 36, z: 0, w: 30, d: 26, h: 18, top: STONE, left: ORANGE, right: '#c14d2c' },
  ],
  check: [
    { x: 0, y: 0, z: 0, w: 50, d: 50, h: 50, top: STONE, left: COBALT, right: DEEP },
  ],
};

export function IsoArt({ kind, size = 150, className = '', float = true }: { kind: keyof typeof KINDS | string; size?: number; className?: string; float?: boolean }) {
  const boxes = KINDS[kind] ?? KINDS.lot;
  const sorted = [...boxes].sort((a, b) => a.x + a.y + a.z - (b.x + b.y + b.z));
  return (
    <svg viewBox="-62 -66 124 104" width={size} height={(size * 104) / 124} className={`${float ? 'iso-float' : ''} ${className}`} aria-hidden>
      <polygon points="-48,30 6,2 52,26 -2,52" transform="translate(-20 4) skewX(-28)" fill="rgba(120,96,52,.28)" />
      <g transform="translate(0 -4)">
        {sorted.map((b, i) => (
          <Box key={i} b={b} />
        ))}
        {kind === 'check' && <path d={`M${pr(12, 50, 28)[0]} ${pr(12, 50, 28)[1]}L${pr(22, 50, 18)[0]} ${pr(22, 50, 18)[1]}L${pr(40, 50, 40)[0]} ${pr(40, 50, 40)[1]}`} fill="none" stroke="#fdf8f0" strokeWidth="5" strokeLinecap="square" />}
      </g>
      <style>{`.iso-float { animation: iso-bob 6s ease-in-out infinite; } @keyframes iso-bob { 0%,100% { transform: translateY(0) rotate(-1deg); } 50% { transform: translateY(-6px) rotate(1deg); } } @media (prefers-reduced-motion: reduce) { .iso-float { animation: none; } }`}</style>
    </svg>
  );
}

export const kindForCategory = (name: string) => {
  const n = name.toLowerCase();
  if (n.includes('safety')) return 'pallet';
  if (n.includes('lot') || n.includes('list')) return 'lot';
  if (n.includes('checkout') || n.includes('pickup') || n.includes('cash')) return 'counter';
  if (n.includes('night') || n.includes('auction')) return 'night';
  return 'lot';
};
