// Balance sweep: careful pilot must win most seeds while a careless chaser must mostly
// die. Knobs: hunter count, sight range, cadence.
import fs from 'node:fs';

const file = process.env.HOME + '/kaos/work/site/games/arcade/hyperrogue/index.html';
const core = fs.readFileSync(file, 'utf8');
const src0 = core.slice(core.indexOf('// >>>CORE'), core.indexOf('// <<<CORE'));

function load(nEnemy, range, period) {
  const src = src0
    .replace(/const NTREASURE = 9, NENEMY = \d+;/, `const NTREASURE = 9, NENEMY = ${nEnemy};`)
    .replace(/const HUNT_RANGE = \d+;/, `const HUNT_RANGE = ${range};`)
    .replace(/const period = S\.heat >= 8 \? \d+ : S\.heat >= 5 \? \d+ : \d+;/,
      `const period = S.heat >= 8 ? ${Math.max(1, period - 1)} : S.heat >= 5 ? ${period} : ${period};`);
  return new Function(src + 'return { makeWorld, newGame, pilot, chaser, step, graphDist };')();
}

const rows = [];
for (const n of [3]) for (const rg of [3, 4]) for (const per of [2, 3]) {
  const api = load(n, rg, per);
  let pw = 0, cw = 0, open = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const P = api.pilot(api.newGame(seed));
    if (P.result === 'win') pw++; else if (!P.result) open++;
    const C = api.chaser(api.newGame(seed));
    if (C.result === 'win') cw++;
  }
  rows.push({ n, rg, per, pilot: pw, chaser: cw, open });
  console.log(`hunters ${n} range ${rg} period ${per}  pilot ${pw}/12  chaser ${cw}/12  open ${open}`);
}
console.log('\nwant: pilot high, chaser low');
rows.sort((a, b) => (b.pilot - b.chaser) - (a.pilot - a.chaser));
console.log('best:', JSON.stringify(rows[0]));
