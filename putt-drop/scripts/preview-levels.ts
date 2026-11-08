import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLevel, sandAreaFraction } from "../src/sim/level.js";
import { BALL_R, CUP_R, CUP_PULL_RADIUS, moverCenter, simulateShot } from "../src/sim/physics.js";
import { parseIntended, solveLevel } from "../src/sim/solver.js";
import type { BallState, Level, Vec2 } from "../src/sim/types.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const levelsDir = join(root, "levels");
const outDir = join(root, "build", "previews");

const COLORS = {
  bg: "#0b0d1a",
  wall: "#00e5ff",
  bumper: "#ffffff",
  sand: "#ffb300",
  water: "#2196f3",
  slope: "#88ff88",
  mover: "#ff00ff",
  tee: "#4caf50",
  cup: "#ffffff",
};

const STROKE_COLORS = ["#b8ff00", "#7fff00", "#d4ff4d", "#a3e635", "#84cc16", "#65a30d"];

function polyPoints(poly: Vec2[]): string {
  return poly.map((p) => `${p[0]},${p[1]}`).join(" ");
}

function wallSegments(level: Level): string {
  let s = "";
  for (const wall of level.walls) {
    const pts = wall.points;
    for (let i = 0; i < pts.length - 1; i++) {
      s += `<line x1="${pts[i][0]}" y1="${pts[i][1]}" x2="${pts[i + 1][0]}" y2="${pts[i + 1][1]}" stroke="${COLORS.wall}" stroke-width="3" stroke-opacity="0.95"/>\n`;
    }
    if (wall.closed && pts.length > 2) {
      const last = pts.length - 1;
      s += `<line x1="${pts[last][0]}" y1="${pts[last][1]}" x2="${pts[0][0]}" y2="${pts[0][1]}" stroke="${COLORS.wall}" stroke-width="3" stroke-opacity="0.95"/>\n`;
    }
  }
  return s;
}

function moverBar(m: Level["movers"][0], t: number): string {
  const c = moverCenter(m, t);
  const dx = m.to[0] - m.from[0];
  const dy = m.to[1] - m.from[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy;
  const ny = ux;
  const hw = m.width / 2;
  const ht = m.thickness / 2;
  const corners = [
    [c[0] + ux * hw + nx * ht, c[1] + uy * hw + ny * ht],
    [c[0] + ux * hw - nx * ht, c[1] + uy * hw - ny * ht],
    [c[0] - ux * hw - nx * ht, c[1] - uy * hw - ny * ht],
    [c[0] - ux * hw + nx * ht, c[1] - uy * hw + ny * ht],
  ];
  const pts = corners.map((p) => `${p[0]},${p[1]}`).join(" ");
  const travel = `<line x1="${m.from[0]}" y1="${m.from[1]}" x2="${m.to[0]}" y2="${m.to[1]}" stroke="${COLORS.mover}" stroke-width="1" stroke-dasharray="6 4" stroke-opacity="0.5"/>`;
  const bar = `<polygon points="${pts}" fill="${COLORS.mover}" fill-opacity="0.7"/>`;
  return travel + bar;
}

function pathPolyline(points: Vec2[], color: string, dotted = false): string {
  if (points.length < 2) return "";
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p[0]} ${p[1]}`).join(" ");
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" ${dotted ? 'stroke-dasharray="2 6" stroke-opacity="0.3"' : 'stroke-opacity="0.95"'} stroke-linecap="round"/>`;
}

function renderLevelSvg(level: Level, best: number, cushions: number, paths: Vec2[][], bestPaths: Vec2[][]): string {
  let body = `<rect width="360" height="640" fill="${COLORS.bg}"/>\n`;

  body += `<polygon points="${polyPoints(level.walls[0].points)}" fill="#102a2c"/>\n`;
  // Surface coverage outside the boundary is not playable. Clip it so the
  // mechanic-only view shows the actual fairway silhouette and usable patches.
  body += `<defs><clipPath id="fairway"><polygon points="${polyPoints(level.walls[0].points)}"/></clipPath></defs><g clip-path="url(#fairway)">`;

  for (const [index, z] of (level.fastTurf ?? []).entries()) {
    const clip = `turf-${index}`;
    body += `<defs><clipPath id="${clip}"><polygon points="${polyPoints(z.poly)}"/></clipPath></defs>`;
    body += `<polygon points="${polyPoints(z.poly)}" fill="#E1F9FF" fill-opacity="0.55" stroke="#276B78" stroke-width="1.5"/>`;
    body += `<g clip-path="url(#${clip})" stroke="#276B78" stroke-width="1.5" stroke-linecap="round" opacity="0.7">`;
    for (let y = 84; y < 624; y += 24) for (let x = 24; x < 344; x += 26) {
      body += `<path d="M${x},${y} l5,-7 M${x + 7},${y} l5,-7"/>`;
    }
    body += `</g>`;
  }

  for (const z of level.sand) {
    body += `<polygon points="${polyPoints(z.poly)}" fill="${COLORS.sand}" fill-opacity="0.35"/>\n`;
  }
  for (const z of level.water) {
    body += `<polygon points="${polyPoints(z.poly)}" fill="${COLORS.water}" fill-opacity="0.4"/>\n`;
  }
  for (const s of level.slopes) {
    body += `<polygon points="${polyPoints(s.poly)}" fill="${COLORS.slope}" fill-opacity="0.15"/>\n`;
    const cx = s.poly.reduce((a, p) => a + p[0], 0) / s.poly.length;
    const cy = s.poly.reduce((a, p) => a + p[1], 0) / s.poly.length;
    const [fx, fy] = s.force;
    const fl = Math.hypot(fx, fy) || 1;
    body += `<line x1="${cx}" y1="${cy}" x2="${cx + (fx / fl) * 14}" y2="${cy + (fy / fl) * 14}" stroke="${COLORS.slope}" stroke-width="1" stroke-opacity="0.5"/>\n`;
  }

  body += `</g>`;
  body += wallSegments(level);
  for (const gate of level.oneWayGates ?? []) {
    const [ax, ay] = gate.from, [bx, by] = gate.to, [nx, ny] = gate.normal;
    body += `<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="#F58E6C" stroke-width="4" stroke-dasharray="5 4"/>`;
    for (const [x, y] of [gate.from, gate.to]) body += `<circle cx="${x}" cy="${y}" r="4" fill="#FAF1D7" stroke="#B49A71"/>`;
    for (const fraction of [0.25, 0.5, 0.75]) {
      const x = ax + (bx - ax) * fraction, y = ay + (by - ay) * fraction;
      body += `<path d="M${x - nx * 4 - ny * 5},${y - ny * 4 + nx * 5} L${x + nx * 5},${y + ny * 5} L${x - nx * 4 + ny * 5},${y - ny * 4 - nx * 5}" fill="none" stroke="#F58E6C" stroke-width="2"/>`;
    }
  }


  for (const m of level.movers) {
    body += moverBar(m, 0);
  }

  for (const b of level.bumpers) {
    body += `<circle cx="${b.x}" cy="${b.y}" r="${b.r}" fill="none" stroke="${COLORS.bumper}" stroke-width="2"/>\n`;
  }

  for (const path of bestPaths) body += pathPolyline(path, "#ffffff", true);
  for (let i = 0; i < paths.length; i++) {
    body += pathPolyline(paths[i], STROKE_COLORS[i % STROKE_COLORS.length]);
    const start = paths[i][0];
    body += `<circle cx="${start[0]}" cy="${start[1]}" r="4" fill="#b8ff00"/>`;
    body += `<text x="${start[0] + 8}" y="${start[1] - 8}" fill="#d4ff4d" font-family="monospace" font-size="12">${i + 1}</text>`;
  }

  body += `<circle cx="${level.tee[0]}" cy="${level.tee[1]}" r="${BALL_R * 0.85}" fill="${COLORS.tee}"/>\n`;
  body += `<circle cx="${level.cup[0]}" cy="${level.cup[1]}" r="${CUP_PULL_RADIUS}" fill="none" stroke="#a0ffc8" stroke-width="0.7" stroke-dasharray="2 3" stroke-opacity="0.5"/>\n`;
  body += `<circle cx="${level.cup[0]}" cy="${level.cup[1]}" r="${CUP_R}" fill="none" stroke="${COLORS.cup}" stroke-width="2"/>\n`;

  const title = `${level.id} — ${level.name}`;
  body += `<text x="8" y="30" fill="#a0ffc8" font-family="monospace" font-size="13">${escapeXml(title)}</text>\n`;

  body += `<text x="8" y="52" fill="#a0ffc8" font-family="monospace" font-size="11">par ${level.par} · best ${best} · cush ${cushions}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 640" width="360" height="640">\n${body}</svg>\n`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function solutionPaths(level: Level, shots: { angle: number; power: number }[]): Vec2[][] {
  const paths: Vec2[][] = [];
  let state: BallState = { x: level.tee[0], y: level.tee[1], t: 0 };
  for (const shot of shots) {
    const result = simulateShot(level, state, shot, { recordPath: true });
    if (result.path && result.path.length > 1) {
      paths.push(result.path);
    }
    if (result.inWater) {
      state = { x: state.x, y: state.y, t: result.end.t };
    } else {
      state = result.end;
    }
    if (result.holed) break;
  }
  return paths;
}

mkdirSync(outDir, { recursive: true });

// Omitted means all holes; an invalid filter must never silently skip checks.
const worldArg = process.argv.indexOf("--world");
const world = worldArg < 0 ? undefined : Number(process.argv[worldArg + 1]);
if (world !== undefined && ![1, 2, 3].includes(world)) throw new Error("--world requires 1, 2 or 3");
const fileWorld = (file: string) => Math.ceil(Number(file.match(/^hole(\d+)\.json$/)?.[1] ?? 1) / 12);

const files = readdirSync(levelsDir)
  .filter((f) => f.endsWith(".json") && (world === undefined || fileWorld(f) === world))
  .sort();

const cards: string[] = [];
const worldCards = new Map<number, string[]>();

for (const file of files) {
  const json = JSON.parse(readFileSync(join(levelsDir, file), "utf8"));
  const level = parseLevel(json, file);
  const result = solveLevel(level, { maxStrokes: level.par + 2, checkFeasibility: false });
  const best = result.solvable ? result.strokes : -1;
  const intended = parseIntended(json, file);
  const route = intended ? solveLevel(level, {
    maxStrokes: intended.strokes, maxCushions: intended.maxCushions, checkFeasibility: false,
  }) : undefined;
  if (intended && !route?.solvable) throw new Error(`${file}: intended route failed`);
  const paths = route?.solvable ? solutionPaths(level, route.shots) : [];
  const bestPaths = result.solvable ? solutionPaths(level, result.shots) : [];
  const svg = renderLevelSvg(level, best, result.cushions, paths, bestPaths);
  writeFileSync(join(outDir, `${level.id}.svg`), svg);
  writeFileSync(join(outDir, `${level.id}-layout.svg`), renderLevelSvg(level, best, result.cushions, [], []));
  const card = (
    `<figure><img src="${level.id}.svg" alt="${escapeXml(level.name)}"/><figcaption><strong>${level.id}</strong> ${escapeXml(level.name)}<br/>par ${level.par} · best ${best} · cush ${result.cushions}<br/>intended ${route?.strokes ?? "—"} strokes · cush ${route?.cushions ?? "—"}<br/>sand ${(sandAreaFraction(level) * 100).toFixed(1)}%<br/><a href="${level.id}-layout.svg">Silhouette and mechanics only</a></figcaption></figure>`
  );
  cards.push(card);
  const group = worldCards.get(fileWorld(file)) ?? [];
  group.push(card); worldCards.set(fileWorld(file), group);
}

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>Putt Drop — level previews</title>
  <style>
    body { background: #0b0d1a; color: #e0e0e0; font-family: system-ui, sans-serif; margin: 1rem; }
    h1 { font-size: 1.25rem; color: #a0ffc8; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 1rem; }
    figure { margin: 0; text-align: center; }
    img { width: 100%; max-width: 200px; height: auto; border: 1px solid #333; border-radius: 4px; }
    figcaption { font-size: 0.8rem; margin-top: 0.35rem; color: #aaa; }
  </style>
</head>
<body>
  <h1>Putt Drop — ${world ? `World ${world}` : "all worlds"} preview</h1>
  <nav><a href="index.html">All holes</a> · <a href="world1.html">Free garden</a> · <a href="world2.html">Dewglass Garden</a> · <a href="world3.html">Wicket Grove</a></nav>
  <p>Pale leaf dashes: fast turf. Coral chevrons: permitted wicket direction.</p>
  <p>Solid lime: intended route. Faint dotted white: overall best. Magenta: gates at t=0. Dashed cup ring: pull radius (17.6 units).</p>
  <div class="grid">
    ${cards.join("\n    ")}
  </div>
</body>
</html>
`;

if (world === undefined) writeFileSync(join(outDir, "index.html"), html);
for (const [number, group] of worldCards) {
  writeFileSync(join(outDir, `world${number}.html`), html
    .replace(cards.join("\n    "), group.join("\n    "))
    .replace(/all worlds/g, `World ${number}`));
}
console.log(`Wrote ${files.length} previews to ${outDir}`);
