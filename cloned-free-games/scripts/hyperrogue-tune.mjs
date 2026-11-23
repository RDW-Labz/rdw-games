// Tuner: slices the CORE block and sweeps hunter cadence / world depth / counts so the
// greedy pilot is a fair yardstick (wins most seeds, but not every one, and a dithering
// player still gets caught).
import fs from 'node:fs';

const file = process.env.HOME + '/kaos/work/site/games/arcade/hyperrogue/index.html';
const html = fs.readFileSync(file, 'utf8');
const core = html.slice(html.indexOf('// >>>CORE'), html.indexOf('// <<<CORE'));

function load(depth, nEnemy, periods, minT, maxT, minE) {
  let src = core
    .replace(/const NTREASURE = 9, NENEMY = \d+;/, `const NTREASURE = 9, NENEMY = ${nEnemy};`)
    .replace(/const DEPTH = \d+;/, `const DEPTH = ${depth};`)
    .replace(/const period = S\.heat >= 8 \? 2 : S\.heat >= 5 \? 3 : 4;/,
      `const period = S.heat >= ${periods[2]} ? ${periods[3]} : S.heat >= ${periods[0]} ? ${periods[1]} : ${periods[4]};`)
    .replace(/dist\[i\] >= 2 && dist\[i\] <= \d+/, `dist[i] >= ${minT} && dist[i] <= ${maxT}`)
    .replace(/dist\[i\] >= 5 && !treasure/, `dist[i] >= ${minE} && !treasure`);
  return new Function(src + `
    return { makeWorld, newGame, pilot, step, graphDist, DEPTH };`)();
}

function dither(api, S, turns) {
  // a player who never chases treasure: always step to the neighbour furthest from
  // the nearest hunter — if hunters are really chasing, this must end in a catch
  for (let i = 0; i < turns && !S.over; i++) {
    const safest = (id) => Math.min(...S.enemies.map((e) => api.graphDist(S.cells, e)[id] ?? 99));
    let best = -1, bs = -1;
    for (const nb of S.cells[S.pos].nb) {
      if (nb < 0) continue;
      const s = safest(nb);
      if (s > bs) { bs = s; best = nb; }
    }
    if (best < 0) break;
    api.step(S, best);
  }
  return S;
}

const combos = [
  [6, 3, [5, 3, 8, 2, 4], 2, 4, 5],
  [6, 4, [5, 3, 8, 2, 4], 2, 4, 5],
  [6, 4, [4, 2, 7, 1, 3], 2, 4, 5],
  [6, 5, [5, 3, 8, 1, 4], 2, 4, 5],
  [5, 3, [5, 3, 8, 2, 4], 2, 4, 4],
  [6, 4, [6, 3, 9, 2, 4], 2, 5, 5],
];
for (const c of combos) {
  let api;
  try { api = load(...c); } catch (e) { console.log('combo', c, 'ERR', e.message); continue; }
  const cells = api.makeWorld(api.DEPTH).cells;
  let wins = 0, cap = 0, tot = 0, moves = 0, caught = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const S = api.newGame(seed);
    const enemies = S.enemies.length;
    api.pilot(S);
    if (S.result === 'win') { wins++; moves += S.moves; }
    else if (S.result === 'lose') caught++;
    else cap++;
    tot += enemies;
  }
  const D = dither(api, api.newGame(1), 300);
  console.log(JSON.stringify(c), 'cells', cells.length,
    'hunters', (tot / 20).toFixed(1),
    'pilot', wins + 'W/' + caught + 'L/' + cap + 'open',
    'avgMoves', (moves / Math.max(1, wins)).toFixed(0),
    'dither', D.result || 'open', D.moves);
}
