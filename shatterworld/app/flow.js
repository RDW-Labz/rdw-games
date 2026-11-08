// ============================================================================
// GAME FLOW: state machine, HUD, acts, checkpoints, shard collection, menu/pause/dead, main loop, debug hooks
// ============================================================================
const G = { state: 'menu', act: 1, shards: 0, shardsTotal: 5, totalShards: 0, coins: 0, runCoins: 0, score: 0, t: 0, best: 0, slow: 1, flash: 0, flashRed: 0, hitstop: 0, trans: null, cine: 0, cineLock: false, atmT: 0, coinCombo: 0, coinComboT: 0, deaths: 0, ck: null, flags: { 1: [], 2: [], 3: [] }, won: false, started: false, finale: null, nsd: -1, nextShard: null };
const ACT_NAMES = { 1: 'ACT I · GOLDEN VALLEY', 2: 'ACT II · SKY ARCHIPELAGO', 3: 'ACT III · NEON CANYON', 4: 'FINALE · BLOOM' };
const ACT_SHARDS = { 1: 5, 2: 4, 3: 3 };
try { G.best = +localStorage.getItem('swn_best') || 0; } catch (e) { }
let toastT = 0;
function toast(msg, ms = 2400) { G.toastMsg = msg; G.toastSeq = (G.toastSeq | 0) + 1; const el = $('toast'); el.textContent = msg; el.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('on'), ms); }
function fmtTime(s) { s = Math.floor(s); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
function buildPie() { const svg = $('hp'); let h = '<circle r="46" fill="rgba(8,14,22,.55)" stroke="rgba(255,230,160,.55)" stroke-width="2"/>'; for (let i = 0; i < 3; i++) { const a0 = -PI / 2 + i * TAU / 3 + 0.06, a1 = -PI / 2 + (i + 1) * TAU / 3 - 0.06, r = 40, x0 = Math.cos(a0) * r, y0 = Math.sin(a0) * r, x1 = Math.cos(a1) * r, y1 = Math.sin(a1) * r; h += `<path id="hpw${i}" d="M0 0 L${x0.toFixed(1)} ${y0.toFixed(1)} A${r} ${r} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)} Z" fill="#ff5a4a"/>`; } h += '<circle r="10" fill="#122" stroke="rgba(255,230,160,.6)" stroke-width="2"/>'; svg.innerHTML = h; }
buildPie();
function updateHUD() {
  $('actName').textContent = ACT_NAMES[G.act] || ''; $('coinN').textContent = G.coins; const sh = $('shards'); const n = ACT_SHARDS[G.act] || 0;
  if (sh.childElementCount !== n) { sh.innerHTML = ''; for (let i = 0; i < n; i++) { const d = document.createElement('div'); d.className = 'sh'; sh.appendChild(d); } }
  for (let i = 0; i < sh.childElementCount; i++) sh.children[i].classList.toggle('on', i < G.shards);
  for (let i = 0; i < 3; i++) { const w = $('hpw' + i); if (w) { w.setAttribute('fill', i < P.hp ? (P.big ? '#ffd24a' : '#ff5a4a') : 'rgba(255,255,255,.1)'); } }
}
function updateBestLine() { $('best').textContent = G.best ? 'BEST TIME  ' + fmtTime(G.best) : 'COLLECT THE SUN SHARDS · BEAT THE CLOCK'; }

