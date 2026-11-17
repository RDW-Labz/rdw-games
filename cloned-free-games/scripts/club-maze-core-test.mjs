#!/usr/bin/env node
// Proves the shipped Club Maze page's own rules block: every level's declared par equals the BFS
// minimum computed from the page's slide()/advance(), every level is solvable, and a slide stops
// only at a wall or the board edge.
// usage: node club-maze-core-test.mjs [path-to-index.html]
import { readFile } from 'node:fs/promises';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/club-maze/index.html';
const html = await readFile(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.log('NO CORE BLOCK'); process.exit(1); }
const src = m[1] + '\nexport { R, C, DIRS, LEVELS_CORE, isWall, slide, advance, par };';
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { R, C, DIRS, LEVELS_CORE, isWall, slide, advance, par } = mod;

const per = LEVELS_CORE.map((lv) => {
  const grid = lv.grid.split('\n').map((r) => r.split(''));
  const rows = lv.grid.split('\n');
  let start = null;
  for (let r = 0; r < R; r++) { const c = rows[r].indexOf('S'); if (c >= 0) start = [r, c]; }
  const bfs = par(grid, start, lv.targets);
  const tCells = lv.grid.split('').filter((ch) => ch === 'T').length;
  return {
    name: lv.name,
    square: rows.length === R && rows.every((row) => row.length === C),
    hasStart: !!start,
    startOpen: !!start && grid[start[0]][start[1]] !== '#',
    targetCount: lv.targets.length,
    targetsMatchGrid: tCells === lv.targets.length,
    targetsOpen: lv.targets.every(([r, c]) => grid[r][c] === 'T'),
    declaredPar: lv.par,
    bfsPar: bfs,
    parMatches: bfs === lv.par,
    solvable: bfs !== null && bfs > 0,
  };
});

// A slide must stop at the wall: from a corner-ish open cell it travels until blocked.
const g1 = LEVELS_CORE[0].grid.split('\n').map((r) => r.split(''));
const lv1 = LEVELS_CORE[0];
const walk = [];
for (const d of Object.keys(DIRS)) {
  const p = slide(g1, lv1.targets[0], d);
  const next = [p[0] + DIRS[d][0], p[1] + DIRS[d][1]];
  walk.push({ dir: d, end: p, blockedAhead: isWall(g1, next[0], next[1]) || next[0] < 0 || next[1] < 0 });
}
const checks = {
  fourLevels: LEVELS_CORE.length === 4,
  parsIncreasing: LEVELS_CORE.every((lv, i) => i === 0 || lv.par > LEVELS_CORE[i - 1].par),
  levels: per.every((p) => p.square && p.hasStart && p.startOpen && p.targetsMatchGrid && p.targetsOpen),
  parsProven: per.every((p) => p.parMatches && p.solvable),
  slideStopsAtWall: walk.every((w) => w.blockedAhead),
  advanceOrdersRings: advance([[1, 3]], 0, [1, 3]) === 1 && advance([[1, 3]], 0, [0, 0]) === 0 && advance([[1, 3]], 1, [1, 3]) === 1,
};
const pass = Object.values(checks).every(Boolean);
console.log(JSON.stringify({ checks, per, walk }, null, 1));
console.log(pass ? 'CORE PASS' : 'CORE FAIL');
process.exit(pass ? 0 : 1);
