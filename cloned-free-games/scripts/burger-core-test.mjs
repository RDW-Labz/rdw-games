#!/usr/bin/env node
// Proves the Burger Party port's rules with the exact code the browser runs: the
// // >>>CORE ... // <<<CORE block is sliced out of games/arcade/burger-party/index.html.
//
// Checks order generation (deterministic, legal fillings, no triple run), the stack
// rules (right filling stacks, wrong one scraps, overflow scraps), serve payout and
// mismatch, the walkout ladder, that an empty stack is never "served", and replays a
// whole perfect shift through the shipped rules to a win.
//
// usage: node burger-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/burger-party/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + `
export { ING, ING_COLOR, ING_LABEL, MAX_WALKOUTS, LEVELS, mulberry32, makeOrder,
  addIngredient, verdict, serveBurger, walkOut };`;
const C = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

let fails = 0;
const ok = (cond, msg, extra) => {
  if (cond) return true;
  fails++;
  console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  return false;
};

const mk = (over = {}) => Object.assign({
  target: 6, patience: 15000, maxLen: 2, served: 0, walkouts: 0, coins: 0, mistakes: 0,
  order: ['patty', 'cheese'], stack: [], patienceLeft: 15000, over: false, result: '',
}, over);

// ---------- 1) tables ----------
ok(C.ING.length === 4 && C.ING.every((k) => C.ING_COLOR[k] && C.ING_LABEL[k]), 'four fillings, each with a colour and a label', C.ING);
ok(C.LEVELS.length === 3, 'three restaurants ship');
ok(C.LEVELS.every((l, i) => i === 0 || (l.target > C.LEVELS[i - 1].target && l.patience < C.LEVELS[i - 1].patience && l.maxLen >= C.LEVELS[i - 1].maxLen)),
  'each restaurant asks for more orders in less time', C.LEVELS.map((l) => [l.target, l.patience, l.maxLen]));
ok(C.MAX_WALKOUTS === 3, 'three walkouts ends the shift');

// ---------- 2) order generation ----------
const a = C.mulberry32(1234);
const o1 = C.makeOrder(a, 2);
const b = C.mulberry32(1234);
const o2 = C.makeOrder(b, 2);
ok(JSON.stringify(o1) === JSON.stringify(o2), 'a seed reproduces the same ticket', [o1, o2]);
ok(o1.length === 2 && o1.every((k) => C.ING.includes(k)), 'ticket length and fillings are legal', o1);
const rnd = C.mulberry32(77);
let triples = 0, lens = new Set();
for (let i = 0; i < 400; i++) {
  const o = C.makeOrder(rnd, 4);
  lens.add(o.length);
  for (let j = 2; j < o.length; j++) if (o[j] === o[j - 1] && o[j] === o[j - 2]) triples++;
  if (!o.every((k) => C.ING.includes(k))) ok(false, 'generated an unknown filling', o);
}
ok(triples === 0, 'no ticket carries three of one filling in a row', triples);
ok(lens.size === 1 && lens.has(4), 'every level-length ticket is the full length asked for', [...lens]);
// clamp: a huge len must still terminate and stay legal
const big = C.makeOrder(C.mulberry32(9), 99);
ok(big.length === C.ING.length * 2, 'len is clamped to a sane maximum', big.length);

// ---------- 3) stacking ----------
const S = mk();
let r = C.addIngredient(S, 'patty');
ok(r.ok === true && JSON.stringify(S.stack) === '["patty"]', 'the next filling on the ticket stacks', S.stack);
r = C.addIngredient(S, 'lettuce');
ok(r.ok === false && r.mistake === true && S.stack.length === 0 && S.mistakes === 1, 'a wrong filling scraps the burger and counts a mistake', { stack: S.stack, mistakes: S.mistakes });
r = C.addIngredient(S, 'nope');
ok(r.ok === false && !r.mistake && S.mistakes === 1, 'an unknown filling is refused without a mistake', S.mistakes);
const S2 = mk();
C.addIngredient(S2, 'patty');
r = C.addIngredient(S2, 'cheese');
ok(r.ok === true && r.complete === true && S2.stack.length === 2, 'the last filling completes the ticket', S2.stack);
r = C.addIngredient(S2, 'patty');
ok(r.ok === false && r.reason === 'overflow' && S2.mistakes === 1 && S2.stack.length === 0, 'an extra filling on a full burger scraps it', { reason: r.reason, stack: S2.stack });

// ---------- 4) serving ----------
const S3 = mk({ served: 0, coins: 0, patienceLeft: 15000, patience: 15000 });
let s = C.serveBurger(S3);
ok(s.ok === false && s.mistake === true && S3.mistakes === 1 && S3.served === 0, 'serving an empty tray is a mismatch, never a free order', { s, served: S3.served });
const S4 = mk({ stack: ['patty'], coins: 0, served: 0, patienceLeft: 15000, patience: 15000 });
s = C.serveBurger(S4);
ok(s.ok === false && S4.mistakes === 1 && S4.coins === 0, 'an incomplete stack pays nothing', S4.mistakes);
const S5 = mk({ stack: ['patty', 'cheese'], coins: 0, served: 0, patienceLeft: 15000, patience: 15000 });
s = C.serveBurger(S5);
ok(s.ok === true && s.paid === 10 * 2 + 20, 'a full-speed exact ticket pays length*10 + 20', s.paid);
ok(S5.served === 1 && S5.coins === 40 && S5.stack.length === 0, 'the order is counted, paid and the tray cleared', S5);
const S6 = mk({ stack: ['patty', 'cheese'], patienceLeft: 1500 });
s = C.serveBurger(S6);
ok(s.ok === true && s.paid < 40 && s.paid >= 20, 'a slow serve pays less than a fast one', s.paid);
const S7 = mk({ stack: ['cheese', 'patty'] });
ok(C.serveBurger(S7).ok === false && S7.mistakes === 1, 'the fillings must match the ticket in order', S7.mistakes);

// ---------- 5) terminals ----------
const S8 = mk({ served: 5, target: 6, stack: ['patty', 'cheese'] });
C.serveBurger(S8);
ok(S8.served === 6 && S8.over === true && S8.result === 'win', 'the last ticket of the shift wins it', { served: S8.served, result: S8.result });
const S9 = mk({ served: 6, target: 6, over: true, result: 'win' });
ok(C.addIngredient(S9, 'patty').ok === false && C.serveBurger(S9).ok === false, 'a finished shift accepts no more taps');
ok(C.walkOut(S9).over === false && S9.walkouts === 0, 'a finished shift cannot walk out');
const S10 = mk({ walkouts: 1 });
ok(C.walkOut(S10).over === false && S10.walkouts === 2, 'a walkout alone does not end the shift', S10.walkouts);
ok(C.walkOut(S10).over === true && S10.result === 'lose' && S10.walkouts === 3, 'the third walkout ends the shift as a loss', S10);
ok(C.verdict(mk({ served: 0, walkouts: 0 })) === '', 'a fresh shift has no verdict');

// ---------- 6) a whole perfect shift through the shipped rules ----------
const run = (level, skip) => {
  const g = C.mulberry32(0x9e3779b9 + level * 7919);
  const S = mk({ target: C.LEVELS[level].target, patience: C.LEVELS[level].patience, maxLen: C.LEVELS[level].maxLen, served: 0, walkouts: 0, coins: 0, patienceLeft: C.LEVELS[level].patience });
  const queue = [C.makeOrder(g, S.maxLen), C.makeOrder(g, S.maxLen), C.makeOrder(g, S.maxLen)];
  let served = 0;
  const guard = 400;
  for (let i = 0; i < guard && !S.over; i++) {
    S.order = queue.shift();
    queue.push(C.makeOrder(g, S.maxLen));
    S.stack = [];
    if (i < skip) {                       // these customers are ignored -> they walk out
      if (C.walkOut(S).over) break;
      continue;
    }
    for (const kind of S.order) C.addIngredient(S, kind);
    const res = C.serveBurger(S);
    if (!res.ok) { ok(false, 'a perfect ticket was refused', S.order); break; }
    served++;
  }
  return { S, served };
};
for (let lv = 0; lv < C.LEVELS.length; lv++) {
  const { S, served } = run(lv, 0);
  ok(S.over === true && S.result === 'win' && S.served === C.LEVELS[lv].target && served === C.LEVELS[lv].target,
    'restaurant ' + (lv + 1) + ' is winnable by serving every ticket', { result: S.result, served: S.served, target: S.target });
  ok(S.mistakes === 0 && S.coins === C.LEVELS[lv].target * (10 * C.LEVELS[lv].maxLen + 20),
    'a perfect restaurant ' + (lv + 1) + ' banks the full payout', { coins: S.coins, want: C.LEVELS[lv].target * (10 * C.LEVELS[lv].maxLen + 20) });
}
// two walkouts then clean play: still a win, proves walkouts are a budget not a dead end
const { S: S11 } = run(0, 100);
ok(S11.result === 'lose' && S11.walkouts === 3, 'ignoring every customer loses the shift', { result: S11.result, walkouts: S11.walkouts });
const { S: S12 } = run(1, 2);
ok(S12.result === 'win' && S12.walkouts === 2, 'two walkouts still leaves room for a win', { result: S12.result, walkouts: S12.walkouts });

console.log(JSON.stringify({ fails, file, tickets: o1, levels: C.LEVELS.length }, null, 0));
console.log(fails ? 'CORE FAIL' : 'CORE PASS');
process.exit(fails ? 1 : 0);
