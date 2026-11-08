/* Isometric wireframe of a loaded pallet — the blueprint drawing in the footer. */
type Box = [number, number, number, number, number, number]; // x, y, z, w(x), d(y), h(z)

const C = Math.cos(Math.PI / 6);
const S = Math.sin(Math.PI / 6);
const pr = (x: number, y: number, z: number) => [(x - y) * C, (x + y) * S - z] as const;
const pts = (...p: (readonly [number, number])[]) => p.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(' ');

const BOXES: Box[] = [
  // pallet deck + runners
  [0, 0, 0, 240, 200, 10],
  [0, 0, -14, 240, 24, 14], [0, 88, -14, 240, 24, 14], [0, 176, -14, 240, 24, 14],
  // load
  [8, 8, 10, 110, 90, 70], [122, 8, 10, 110, 90, 54], [8, 102, 10, 110, 90, 54], [122, 102, 10, 110, 90, 82],
  [20, 20, 80, 92, 74, 52], [130, 112, 92, 92, 74, 40], [134, 20, 64, 84, 70, 44],
];

function face(b: Box) {
  const [x, y, z, w, d, h] = b;
  const top = pts(pr(x, y, z + h), pr(x + w, y, z + h), pr(x + w, y + d, z + h), pr(x, y + d, z + h));
  const left = pts(pr(x, y + d, z), pr(x + w, y + d, z), pr(x + w, y + d, z + h), pr(x, y + d, z + h));
  const right = pts(pr(x + w, y, z), pr(x + w, y + d, z), pr(x + w, y + d, z + h), pr(x + w, y, z + h));
  return { top, left, right };
}

export function IsoStack({ className = '' }: { className?: string }) {
  const sorted = [...BOXES].sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]));
  return (
    <svg viewBox="-230 -200 470 330" className={className} aria-hidden>
      <g strokeLinejoin="round" className="iso-draw">
        {/* floor grid */}
        {Array.from({ length: 9 }, (_, i) => (
          <g key={i} stroke="rgba(255,255,255,.18)" strokeWidth="1" strokeDasharray="3 5">
            <polyline points={pts(pr(-40 + i * 40, -40, -14), pr(-40 + i * 40, 280, -14))} fill="none" />
            <polyline points={pts(pr(-40, -40 + i * 40, -14), pr(280, -40 + i * 40, -14))} fill="none" />
          </g>
        ))}
        {sorted.map((b, i) => {
          const f = face(b);
          return (
            <g key={i} stroke="rgba(255,255,255,.9)" strokeWidth="1.3">
              <polygon points={f.left} fill="rgba(1,30,90,.28)" pathLength={1} />
              <polygon points={f.right} fill="rgba(1,30,90,.12)" pathLength={1} />
              <polygon points={f.top} fill="rgba(255,255,255,.07)" pathLength={1} />
              {b[2] >= 10 && <polyline points={pts(pr(b[0] + b[3] / 2, b[1], b[2] + b[5]), pr(b[0] + b[3] / 2, b[1] + b[4], b[2] + b[5]))} fill="none" strokeOpacity=".55" strokeDasharray="4 3" />}
            </g>
          );
        })}
        {/* jack handle */}
        <polyline points={pts(pr(260, 100, 0), pr(330, 100, 0), pr(350, 100, 110))} fill="none" stroke="rgba(255,255,255,.9)" strokeWidth="1.3" />
        <polyline points={pts(pr(260, 70, 0), pr(330, 70, 0))} fill="none" stroke="rgba(255,255,255,.9)" strokeWidth="1.3" />
        <polyline points={pts(pr(260, 130, 0), pr(330, 130, 0))} fill="none" stroke="rgba(255,255,255,.9)" strokeWidth="1.3" />
      </g>
      <style>{`.iso-draw [pathLength] { stroke-dasharray: 1; stroke-dashoffset: 1; animation: iso 2.2s cubic-bezier(.333,0,0,1) forwards; } @keyframes iso { to { stroke-dashoffset: 0; } } @media (prefers-reduced-motion: reduce) { .iso-draw [pathLength] { animation: none; stroke-dashoffset: 0; } }`}</style>
    </svg>
  );
}
