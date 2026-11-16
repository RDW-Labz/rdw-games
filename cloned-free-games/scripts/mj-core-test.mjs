// Slice the >>>CORE block out of the shipped page and check the riichi rules against
// the standard scoring table, then exercise settle()'s round rotation and bust path.
import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2];
const html = fs.readFileSync(file, 'utf8');
const a = html.indexOf('// >>>CORE');
const b = html.indexOf('// <<<CORE');
if (a < 0 || b < 0) { console.error('no CORE markers'); process.exit(1); }
const src = html.slice(a, b);
const tmp = path.join(process.env.TMPDIR || '/tmp', 'mj-core-' + process.pid + '.mjs');
fs.writeFileSync(tmp, src + '\nexport { FU_STEPS, HANDS, START_SCORE, basicPoints, handPoints, settle, blankState, standings, roundLabel, windOf };\n');
const m = await import('file://' + tmp);
fs.unlinkSync(tmp);

let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
  else console.log(`ok   ${name} = ${JSON.stringify(got)}`);
};
const ron = (h, f, d) => m.handPoints(h, f, false, d).total;
const ts = (h, f, d) => { const p = m.handPoints(h, f, true, d); return d ? p.each[0] : [p.fromOther, p.fromDealer]; };

// non-dealer ron
eq('1/30 ron', ron(1, 30, false), 1000);
eq('2/30 ron', ron(2, 30, false), 2000);
eq('3/30 ron', ron(3, 30, false), 3900);
eq('4/30 ron', ron(4, 30, false), 7700);
eq('1/20 ron', ron(1, 20, false), 700);
eq('2/25 ron', ron(2, 25, false), 1600);
eq('3/25 ron', ron(3, 25, false), 3200);
eq('4/25 ron', ron(4, 25, false), 6400);
eq('3/60 ron', ron(3, 60, false), 7700);
// dealer ron
eq('1/30 ron dealer', ron(1, 30, true), 1500);
eq('2/30 ron dealer', ron(2, 30, true), 2900);
eq('3/30 ron dealer', ron(3, 30, true), 5800);
eq('4/30 ron dealer', ron(4, 30, true), 11600);
// tsumo
eq('1/30 tsumo', ts(1, 30, false), [300, 500]);
eq('2/30 tsumo', ts(2, 30, false), [500, 1000]);
eq('3/30 tsumo', ts(3, 30, false), [1000, 2000]);
eq('1/30 tsumo dealer', ts(1, 30, true), 500);
eq('2/30 tsumo dealer', ts(2, 30, true), 1000);
eq('3/30 tsumo dealer', ts(3, 30, true), 2000);
eq('1/20 tsumo (pinfu)', ts(1, 20, false), [200, 400]);
// limits
eq('5 han = mangan', ron(5, 30, false), 8000);
eq('3/70 fu = mangan', ron(3, 70, false), 8000);
eq('4/40 fu = mangan', ron(4, 40, false), 8000);
eq('6 han haneman', ron(6, 30, false), 12000);
eq('8 han baiman', ron(8, 30, false), 16000);
eq('11 han sanbaiman', ron(11, 30, false), 24000);
eq('13 han yakuman', ron(13, 30, false), 32000);
eq('yakuman dealer', ron(13, 40, true), 48000);
eq('sanbaiman dealer', ron(12, 40, true), 36000);
eq('limitName 6', m.handPoints(6, 30, false, false).limit, 'haneman');

// ---- settle: rotation, honba, pot, bust
let st = m.blankState();
let r = m.settle(st, { winner: 0, discarder: 1, han: 3, fu: 30, tsumo: false });
eq('dealer ron 3/30 = 5800', r.points.total, 5800);
eq('dealer keeps deal (round same)', [r.state.round, r.state.dealer], [0, 0]);
eq('dealer win honba +1', r.state.honba, 1);
eq('scores after dealer ron', r.state.scores, [30800, 19200, 25000, 25000]);
eq('score sum conserved', r.state.scores.reduce((x, y) => x + y, 0), 100000);

st = { ...r.state, sticks: 2 };
r = m.settle(st, { winner: 2, discarder: 0, han: 2, fu: 30, tsumo: false });
eq('non-dealer ron 2/30 = 2000', r.points.total, 2000);
eq('honba 1 adds 300 to ron', r.gained, 2000 + 300 + 2000);
eq('riichi pot cleared', r.state.sticks, 0);
eq('deal rotates + round advances', [r.state.round, r.state.dealer], [1, 1]);
eq('honba reset on rotation', r.state.honba, 0);

// tsumo split
st = m.blankState();
r = m.settle(st, { winner: 1, discarder: -1, han: 3, fu: 30, tsumo: true });
eq('non-dealer tsumo 3/30 total', r.gained, 4000);
eq('tsumo deltas', r.delta, [-2000, 4000, -1000, -1000]);

// bust ends the game
st = { ...m.blankState(), scores: [25000, 25000, 500, 77000] };
r = m.settle(st, { winner: 0, discarder: 2, han: 4, fu: 30, tsumo: false });
eq('bust flagged', [r.state.over, r.state.reason], [true, 'bust']);

// final hand ends the game
st = { ...m.blankState(), round: 7, dealer: 3 };
r = m.settle(st, { winner: 0, discarder: 1, han: 1, fu: 30, tsumo: false });
eq('last hand flagged final', [r.state.over, r.state.reason], [true, 'final']);
eq('roundLabel 0/7', [m.roundLabel(0), m.roundLabel(7)], ['E1', 'S4']);
eq('windOf', [m.windOf(0, 0), m.windOf(3, 0), m.windOf(0, 1), m.windOf(1, 0)], ['E', 'N', 'N', 'S']);

console.log(fail ? `\n${fail} FAILURES` : '\nall CORE checks pass');
process.exit(fail ? 1 : 0);
