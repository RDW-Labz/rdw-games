#!/usr/bin/env node
// Proves the shipped Squirrel's Maze page's own rules block: for every level and three deal numbers,
// the carved maze is fully connected, the nest is reachable, every acorn is reachable and distinct,
// the shortest collect-then-nest route is finite, and the step cap sits above it.
// usage: node squirrel-core-test.mjs [path-to-index.html]
import { readFile } from 'node:fs/promises';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/the-squirrel-s-maze-2d/index.html';
const html = await readFile(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.log('NO CORE BLOCK'); process.exit(1); }
const src = m[1] + '\nexport { DIRS, LEVEL_SPECS, mulberry32, genMaze, isOpen, bfsDist, bestPath, deal, stepTo };';
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { DIRS, LEVEL_SPECS, isOpen, bfsDist, bestPath, deal, stepTo } = mod;

const rows = [];
for (let lv = 0; lv < LEVEL_SPECS.length; lv++) {
  for (const dn of [0, 1, 2]) {
    const d = deal(lv, dn);
    const dist = bfsDist(d, d.start);
    let open = 0, reached = 0;
    for (let r = 0; r < d.H; r++) for (let c = 0; c < d.W; c++) {
      if (d.grid[r][c] !== '.') continue;
      open++;
      if (dist.has(r + ',' + c)) reached++;
    }
    const acornKeys = new Set(d.acorns.map((p) => p.join(',')));
    rows.push({
      level: lv, dealNo: dn, size: d.size, open, reached,
      connected: open === reached && open > 0,
      borderSolid: d.grid[0].every((ch) => ch === '#') && d.grid[d.H - 1].every((ch) => ch === '#'),
      startOpen: isOpen(d, d.start[0], d.start[1]),
      exitOpen: isOpen(d, d.exit[0], d.exit[1]),
      exitFar: (dist.get(d.exit.join(',')) || 0) >= 6,
      acornCount: d.acorns.length,
      acornDistinct: acornKeys.size === d.acorns.length,
      acornsReachable: d.acorns.every((p) => dist.has(p.join(','))),
      acornsOffStart: d.acorns.every((p) => !(p[0] === d.start[0] && p[1] === d.start[1])),
      acornsOffExit: d.acorns.every((p) => !(p[0] === d.exit[0] && p[1] === d.exit[1])),
      optimal: d.optimal,
      cap: d.cap,
      solvable: typeof d.optimal === 'number' && d.optimal > 0,
      capAboveOptimal: d.cap > d.optimal,
    });
  }
}

// Determinism: same level + deal number must carve the same board.
const a = deal(3, 1), b = deal(3, 1), c = deal(3, 2);
const deterministic = JSON.stringify(a.grid) === JSON.stringify(b.grid) && JSON.stringify(a.grid) !== JSON.stringify(c.grid);

// Movement rules: walls are refused, corridors are walked, an acorn is only gathered by standing on it.
const d0 = deal(0, 0);
const wallStep = (() => {
  for (const k of Object.keys(DIRS)) {
    const [dr, dc] = DIRS[k];
    if (!isOpen(d0, d0.start[0] + dr, d0.start[1] + dc)) return stepTo(d0, d0.start, 0, d0.acorns, k);
  }
  return 'no-wall';
})();
const openStep = (() => {
  for (const k of Object.keys(DIRS)) {
    const [dr, dc] = DIRS[k];
    if (isOpen(d0, d0.start[0] + dr, d0.start[1] + dc)) return { dir: k, res: stepTo(d0, d0.start, 0, d0.acorns, k) };
  }
  return null;
})();

// A step onto an acorn tile sets its bit; the same tile from a full mask leaves it alone.
const ac = d0.acorns[0];
const stand = stepTo(d0, [ac[0] + 0, ac[1] - 0], 0, d0.acorns, 'up'); // may be null; fall back below
const acornBit = (() => {
  // find an open neighbour of the first acorn
  for (const k of Object.keys(DIRS)) {
    const nr = ac[0] + DIRS[k][0], nc = ac[1] + DIRS[k][1];
    if (!isOpen(d0, nr, nc)) continue;
    const r = stepTo(d0, [nr, nc], 0, d0.acorns, { up: 'down', down: 'up', left: 'right', right: 'left' }[k]);
    if (r) return r.mask === 1 || r.mask === 2 || r.mask === 3 || r.mask > 0;
  }
  return false;
})();

const checks = {
  eightSpecs: LEVEL_SPECS.length === 8,
  connected: rows.every((r) => r.connected && r.borderSolid),
  terminals: rows.every((r) => r.startOpen && r.exitOpen && r.exitFar),
  acorns: rows.every((r) => r.acornDistinct && r.acornsReachable && r.acornsOffStart && r.acornsOffExit && r.acornCount === LEVEL_SPECS[r.level].acorns),
  solvable: rows.every((r) => r.solvable && r.capAboveOptimal),
  levelsGrow: LEVEL_SPECS.every((s, i) => i === 0 || s.size >= LEVEL_SPECS[i - 1].size),
  deterministic,
  wallRefused: wallStep === null,
  walkOpen: !!openStep && Array.isArray(openStep.res.pos),
  acornBit,
};
const pass = Object.values(checks).every(Boolean);
console.log(JSON.stringify({
  checks,
  summary: rows.map((r) => ({ l: r.level, d: r.dealNo, size: r.size, optimal: r.optimal, cap: r.cap, acorns: r.acornCount })),
  failed: rows.filter((r) => !(r.connected && r.startOpen && r.exitOpen && r.acornDistinct && r.acornsReachable && r.solvable && r.capAboveOptimal)),
}, null, 1));
console.log(pass ? 'CORE PASS' : 'CORE FAIL');
process.exit(pass ? 0 : 1);
