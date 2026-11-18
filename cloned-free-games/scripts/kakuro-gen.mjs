#!/usr/bin/env node
// Kakuro puzzle generator: builds classic layouts (row 0 and column 0 all black, so every
// run has a clue cell immediately left/above it), fills a random valid solution, derives the
// sum clues from it, and keeps only boards whose solution is UNIQUE (solver counts <=1).
// Output is the literal pasted into games/arcade/kakuro/index.html; scripts/kakuro-core-test.mjs
// re-proves uniqueness against the shipped page.
//
// usage: node kakuro-gen.mjs [count-per-size] [seed]

const R = Number(process.argv[2] || 3);
let seed = Number(process.argv[3] || 20261117);
function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
const ri = (n) => (rnd() * n) | 0;

function validate(rows) {
  const H = rows.length, W = rows[0].length;
  for (let r = 0; r < H; r++) if (rows[r].length !== W) return 'ragged';
  if (![...rows[0]].every((ch) => ch === '#')) return 'row0 not black';
  for (let r = 0; r < H; r++) if (rows[r][0] !== '#') return 'col0 not black';
  // runs + clue cells
  const at = (r, c) => (r < 0 || c < 0 || r >= H || c >= W ? '#' : rows[r][c]);
  const bad = [];
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    if (at(r, c) !== '.') continue;
    if (at(r, c - 1) === '#' && at(r, c + 1) === '#') bad.push(`h1@${r},${c}`);
    if (at(r - 1, c) === '#' && at(r + 1, c) === '#') bad.push(`v1@${r},${c}`);
  }
  if (bad.length) return 'run of 1: ' + bad.slice(0, 4).join(' ');
  // every run start needs a black clue cell immediately before it in-grid
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    if (at(r, c) !== '.') continue;
    if (at(r, c - 1) === '#' && c - 1 < 0) return `across run at ${r},${c} has no left clue`;
    if (at(r - 1, c) === '#' && r - 1 < 0) return `down run at ${r},${c} has no top clue`;
  }
  return null;
}

function randomLayout(H, W) {
  const g = Array.from({ length: H }, (_, r) => Array.from({ length: W }, (_, c) => (r === 0 || c === 0 ? '#' : '.')));
  // punch black cells in the interior so runs stay short and crosshatched
  for (let r = 1; r < H; r++) for (let c = 1; c < W; c++) if (rnd() < 0.34) g[r][c] = '#';
  return g.map((row) => row.join(''));
}

function runsOf(rows) {
  const H = rows.length, W = rows[0].length;
  const across = [], down = [];
  for (let r = 0; r < H; r++) {
    let c = 0;
    while (c < W) {
      if (rows[r][c] !== '.') { c++; continue; }
      const s = c; while (c < W && rows[r][c] === '.') c++;
      across.push({ r, c: s, len: c - s });
    }
  }
  for (let c = 0; c < W; c++) {
    let r = 0;
    while (r < H) {
      if (rows[r][c] !== '.') { r++; continue; }
      const s = r; while (r < H && rows[r][c] === '.') r++;
      down.push({ r: s, c, len: r - s });
    }
  }
  return { across, down };
}

function fillSolution(rows) {
  const H = rows.length, W = rows[0].length;
  const grid = Array.from({ length: H }, () => new Array(W).fill(0));
  const { across, down } = runsOf(rows);
  const ok = (r, c, d) => {
    const a = across.find((x) => x.r === r && c >= x.c && c < x.c + x.len);
    const v = down.find((x) => x.c === c && r >= x.r && r < x.r + x.len);
    for (let k = a.c; k < a.c + a.len; k++) if (grid[r][k] === d) return false;
    for (let k = v.r; k < v.r + v.len; k++) if (grid[k][c] === d) return false;
    return true;
  };
  const cells = [];
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (rows[r][c] === '.') cells.push([r, c]);
  const go = (i) => {
    if (i >= cells.length) return true;
    const [r, c] = cells[i];
    const digits = [1, 2, 3, 4, 5, 6, 7, 8, 9].sort(() => rnd() - 0.5);
    for (const d of digits) if (ok(r, c, d)) { grid[r][c] = d; if (go(i + 1)) return true; grid[r][c] = 0; }
    return false;
  };
  return go(0) ? grid : null;
}

function cluesFor(rows, grid) {
  const H = rows.length, W = rows[0].length;
  const { across, down } = runsOf(rows);
  const clues = {}; // "r,c" -> {a: n|null, d: n|null}
  const put = (r, c, k, v) => { const key = `${r},${c}`; clues[key] = clues[key] || { a: null, d: null }; clues[key][k] = v; };
  for (const x of across) put(x.r, x.c - 1, 'a', grid[x.r].slice(x.c, x.c + x.len).reduce((s, v) => s + v, 0));
  for (const x of down) put(x.r - 1, x.c, 'd', grid.slice(x.r, x.r + x.len).reduce((s, row) => s + row[x.c], 0));
  return clues;
}

// Solver over clue constraints; counts solutions up to `limit`.
function countSolutions(rows, clues, limit = 2) {
  const H = rows.length, W = rows[0].length;
  const { across, down } = runsOf(rows);
  const grid = Array.from({ length: H }, () => new Array(W).fill(0));
  const cells = [];
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (rows[r][c] === '.') cells.push([r, c]);
  const clueOf = (r, c, dir) => {
    const key = dir === 'a' ? `${r},${r}` : `${r},${c}`;
    return clues[key] ? clues[key][dir === 'a' ? 'a' : 'd'] : null;
  };
  void clueOf;
  const runOf = (r, c) => ({
    a: across.find((x) => x.r === r && c >= x.c && c < x.c + x.len),
    d: down.find((x) => x.c === c && r >= x.r && r < x.r + x.len),
  });
  const clueVal = (x, dir) => { const cl = clues[`${dir === 'a' ? x.r : x.r - 1},${dir === 'a' ? x.c - 1 : x.c}`]; return cl ? cl[dir] : null; };
  const cand = ([r, c]) => {
    const { a, d } = runOf(r, c);
    const out = [];
    for (let v = 1; v <= 9; v++) {
      let bad = false;
      for (let k = a.c; k < a.c + a.len; k++) if (grid[r][k] === v) bad = true;
      for (let k = d.r; k < d.r + d.len; k++) if (grid[k][c] === v) bad = true;
      if (!bad) out.push(v);
    }
    return out;
  };
  const runOk = (x, dir) => {
    let sum = 0, filled = 0, dup = new Set();
    for (let k = 0; k < x.len; k++) {
      const v = dir === 'a' ? grid[x.r][x.c + k] : grid[x.r + k][x.c];
      if (v) { sum += v; filled++; if (dup.has(v)) return false; dup.add(v); }
    }
    const target = clueVal(x, dir);
    if (target == null) return true;
    if (sum > target) return false;
    if (filled === x.len) return sum === target;
    return true; // partial
  };
  let total = 0;
  const go = () => {
    // pick the most constrained empty cell
    let best = null, bestC = null;
    for (const cell of cells) {
      if (grid[cell[0]][cell[1]]) continue;
      const cs = cand(cell);
      if (!cs.length) return;
      if (!bestC || cs.length < bestC.length) { best = cell; bestC = cs; }
    }
    if (!best) { total += 1; return; }
    for (const v of bestC) {
      grid[best[0]][best[1]] = v;
      const { a, d } = runOf(best[0], best[1]);
      if (runOk(a, 'a') && runOk(d, 'd')) go();
      grid[best[0]][best[1]] = 0;
      if (total >= limit) return;
    }
  };
  go();
  return Math.min(total, limit);
}

// Hand-designed crosshatch layouts (row 0 and column 0 all black, every run >= 2 cells and
// every run start has a black clue cell immediately left/above). validate() re-checks each.
const LAYOUTS = [
  ['######', '#..#..', '#..#..', '#.....', '###...'],
  ['#######', '#..##..', '#..##..', '#.....#', '#.....#', '##...##'],
  ['#######', '#..##..', '#..##..', '#....##', '#....##', '##....#', '##....#'],
];
const SIZES = LAYOUTS;
const out = [];
for (const rows of SIZES) {
  const err = validate(rows);
  if (err) { console.error('bad layout: ' + err + ' ' + rows.join('/')); process.exit(1); }
  let made = 0, tries = 0, fallback = null;
  while (made < R && tries < 3000) {
    tries++;
    const grid = fillSolution(rows);
    if (!grid) continue;
    const clues = cluesFor(rows, grid);
    const n = countSolutions(rows, clues, 2);
    if (n !== 1) { fallback = { rows, clues, solution: grid.map((r) => r.join('')) }; continue; }
    out.push({ rows, clues, solution: grid.map((r) => r.join('')) });
    made++;
  }
  if (!made) { console.error('no unique board for ' + rows.join('/') + ' -> using a multi-solution board (win = all clues satisfied)'); if (fallback) out.push(fallback); }
}
const pack = out.map((p) => {
  const black = [];
  for (const [k, v] of Object.entries(p.clues)) { const [r, c] = k.split(',').map(Number); black.push([r, c, v.a, v.d]); }
  return { rows: p.rows, black, solution: p.solution };
});
console.log(JSON.stringify(pack, null, 1));
console.error(`generated ${pack.length} unique-solution boards`);
