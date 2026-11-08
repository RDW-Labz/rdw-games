// ==============================================================================================================================================================================================
// GEMS TAB (inventory tab 6): sockets of the core rig + gear with link bars, gem bag (30), shared stash (20), hotbar (4), detail with live numbers and a support COMPARE. Pad / keyboard / mouse.
//   A socket / unsocket / take from stash   X bind to hotbar (socketed skill) / stash <-> bag   Y lock   RT salvage gem or re-roll sockets (twice)   LT sort   LB RB tabs   B close
// ==============================================================================================================================================================================================
const GU = { zone: 'sock', row: 0, j: 0, i: 0, tgt: null, armed: null };
const guRowN = r => { const it = gemRowItem(GEM_ROWS[r]); return it ? gemSockets(it).n : 0; };
function guSel() {
  if (GU.zone === 'sock') { const k = GEM_ROWS[GU.row], it = gemRowItem(k), L = it ? gemSockets(it) : null, g = it && it.gems ? it.gems[GU.j] || null : null; return { zone: 'sock', gem: g, row: GU.row, key: k, j: GU.j, item: it, L }; }
  if (GU.zone === 'gem') return { zone: 'gem', gem: RP.gems[GU.i] || null, i: GU.i }; if (GU.zone === 'stash') return { zone: 'stash', gem: RP.stash[GU.i] || null, i: GU.i };
  const uid = RP.hot[GU.i], a = uid ? gemFindActive(uid) : null; return { zone: 'hot', gem: a ? a.gem : null, i: GU.i, uid, active: a };
}
function guGemAt(spec) { const q = spec.split(':'); if (q[0] === 'sock') { const it = gemRowItem(GEM_ROWS[+q[1]]); return it && it.gems ? it.gems[+q[2]] : null; } if (q[0] === 'gem') return RP.gems[+q[1]]; if (q[0] === 'stash') return RP.stash[+q[1]]; if (q[0] === 'hot') { const a = RP.hot[+q[1]] ? gemFindActive(RP.hot[+q[1]]) : null; return a ? a.gem : null; } return null; }
function guMove(dx, dy) {
  rsfx('ui'); GU.armed = null; const z = GU.zone;
  if (z === 'sock') { const n = guRowN(GU.row); if (dy) { GU.row = sat(GU.row + dy, 0, GEM_ROWS.length - 1); GU.j = sat(GU.j, 0, Math.max(0, guRowN(GU.row) - 1)); } else if (dx) { if (dx > 0 && GU.j >= n - 1) { GU.zone = 'gem'; GU.i = Math.min(4, GU.row) * 6; } else GU.j = sat(GU.j + dx, 0, Math.max(0, n - 1)); } }
  else if (z === 'gem') { const c = GU.i % 6, r = (GU.i / 6) | 0; if (dx) { if (dx < 0 && c === 0) { GU.zone = 'sock'; GU.row = Math.min(GEM_ROWS.length - 1, r + 1); GU.j = Math.max(0, guRowN(GU.row) - 1); } else GU.i = r * 6 + sat(c + dx, 0, 5); } else if (dy < 0 && r === 0) { GU.zone = 'hot'; GU.i = Math.min(3, c >> 1); } else if (dy > 0 && r === 4) { GU.zone = 'stash'; GU.i = Math.min(19, c + 2); } else GU.i = sat(r + dy, 0, 4) * 6 + c; }
  else if (z === 'hot') { if (dx) GU.i = sat(GU.i + dx, 0, 3); else if (dy > 0) { GU.zone = 'gem'; GU.i = Math.min(5, GU.i * 2); } }
  else { const c = GU.i % 10, r = (GU.i / 10) | 0; if (dx) { if (dx < 0 && c === 0) { GU.zone = 'sock'; GU.row = GEM_ROWS.length - 1; GU.j = 0; } else GU.i = r * 10 + sat(c + dx, 0, 9); } else if (dy < 0 && r === 0) { GU.zone = 'gem'; GU.i = 24 + Math.min(5, c >> 1); } else GU.i = sat(r + dy, 0, 1) * 10 + c; }
  rpgRenderInv();
}
function guNextSlot(uid) { const cur = RP.hot.indexOf(uid); if (cur < 0) { const e = RP.hot.findIndex(u => !u); return e >= 0 ? e : 0; } return (cur + 1) % 4; }
function guAct(kind) {
  const sel = guSel(), arm = (k, msg) => { if (GU.armed && GU.armed.k === k && RT.real - GU.armed.t < 2.6) { GU.armed = null; return true; } GU.armed = { k, t: RT.real }; toast(msg); rsfx('ui'); return false; };
  if (kind === 'A') {
    if (sel.zone === 'gem') { if (!sel.gem) { gsfx('gdeny'); return; } if (GU.tgt) { const t = GU.tgt; GU.tgt = null; gemOpSocket(sel.i, GEM_ROWS[t.row], t.j); } else gemOpAuto(sel.i); }
    else if (sel.zone === 'sock') { if (!sel.item || !sel.L || !sel.L.n) { gsfx('gdeny'); return; } if (sel.gem) gemOpUnsocket(sel.key, sel.j); else { GU.tgt = { row: sel.row, j: sel.j }; const f = RP.gems.findIndex(Boolean); GU.zone = 'gem'; GU.i = f < 0 ? 0 : f; toast('Choose a gem for this socket (' + padTxt('A') + ')'); rsfx('ui'); } }
    else if (sel.zone === 'stash') gemOpUnstash(sel.i); else if (sel.zone === 'hot') { const act = GM.active.filter(a => !RP.hot.includes(a.gem.u) || a.gem.u === sel.uid); if (!act.length) { gsfx('gdeny'); return; } const cur = act.findIndex(a => a.gem.u === sel.uid); gemBind(sel.i, act[(cur + 1) % act.length].gem.u); rsfx('ui'); }
  } else if (kind === 'X') {
    if (sel.zone === 'sock' && sel.gem && gemIsSkill(sel.gem.id)) { const s = guNextSlot(sel.gem.u); gemBind(s, sel.gem.u); toast(GEM_BY_ID[sel.gem.id].name + ' -> hotbar ' + (s + 1)); rsfx('ui'); } else if (sel.zone === 'gem') gemOpStash(sel.i); else if (sel.zone === 'stash') gemOpUnstash(sel.i); else if (sel.zone === 'hot') { RP.hot[sel.i] = 0; gemTouch(); rsfx('ui'); } else gsfx('gdeny');
  } else if (kind === 'Y') { if (sel.gem) gemOpLock(sel.gem); else gsfx('gdeny'); }
  else if (kind === 'RT') {
    if (sel.zone === 'gem' && sel.gem) { if (sel.gem.lk) { toast('Locked: press ' + padTxt('Y') + ' to unlock first'); gsfx('gdeny'); return; } if (GEM_BY_ID[sel.gem.id].tier === 0 && sel.gem.lv <= 2 || arm('s' + sel.i, 'Press ' + padTxt('RT') + ' again to salvage ' + GEM_BY_ID[sel.gem.id].name)) gemOpSalvage(sel.i); }
    else if (sel.zone === 'sock' && sel.item && sel.key !== 'core') { const c = gemResocketCost(sel.item); if (arm('r' + sel.key, 'Press ' + padTxt('RT') + ' again to re-roll sockets (' + c.dust + ' shards, ' + c.gold + ' gold)')) gemOpResocket(sel.key); } else gsfx('gdeny');
  } else if (kind === 'LT') gemOpSort();
  rpgRenderInv();
}
const _uiMove2 = uiMove; uiMove = function (dx, dy) { if (RUI.tab === 5) return guMove(dx, dy); _uiMove2(dx, dy); };
const _uiAct2 = uiAct; uiAct = function (kind) { if (RUI.tab === 5) return guAct(kind); _uiAct2(kind); };
const f1 = v => { const r = Math.round(v * 10) / 10; return Number.isInteger(r) ? String(r) : r.toFixed(1); }, pc = v => (Math.round(v * 1000) / 10) + '%';
function gemEffectRows(d, lv) { // numbers of one support gem at a level (from the scaling table)
  const r = gemRow(d, lv), o = []; if (Math.abs(r.more - 1) > 0.001) o.push(['Damage', 'x' + r.more.toFixed(2)]); if (Math.abs(r.costMul - 1) > 0.001) o.push(['Spark cost', 'x' + r.costMul.toFixed(2)]); if (r.chain) o.push(['Chains', '+' + r.chain]); if (r.fork) o.push(['Fork into', r.fork]); if (r.pierce) o.push(['Pierces', r.pierce + ' enemies']); if (Math.abs(r.area - 1) > 0.001) o.push(['Area', 'x' + r.area.toFixed(2)]); if (r.echo) o.push(['Repeats', r.echo + (r.echo > 1 ? ' times' : ' time')]); if (r.haste) o.push(['Cooldown / wind-up', '-' + pc(r.haste)]); if (r.leech) o.push(['Heals per hit', pc(r.leech) + ' max HP']); if (r.multi) o.push(['Extra copies', '+' + r.multi + ' (x' + r.multiMore.toFixed(2) + ' each)']); if (r.burn) o.push(['Burn', pc(r.burn) + ' of the hit']); if (r.slow) o.push(['Slow', pc(r.slow) + ' for 2 s']); if (r.pull) o.push(['Pull', 'wind pulls enemies']); if (r.critAdd) o.push(['Crit chance', '+' + pc(r.critAdd)]); return o;
}
function gemDetailLines(sel) { // shared by the DOM tab and the VR panel
  const L = [], S = RT.S, aff = classDef(RP.cls).aff, push = (k, t, c, x) => { L.push(Object.assign({ k, t, c: c || '' }, x || {})); };
  if (!sel.gem) {
    if (sel.zone === 'sock') { if (!sel.item) { push('h', 'EMPTY ' + GEM_ROW_LABEL[sel.key], '#8195a6'); push('p', 'Equip an item here to get its sockets.'); } else if (!sel.L.n) { push('h', 'NO SOCKETS', '#8195a6'); push('p', sel.key === 'core' ? '' : 'This item has none. ' + padTxt('RT') + ' twice re-rolls the layout (' + gemResocketCost(sel.item).dust + ' shards, ' + gemResocketCost(sel.item).gold + ' gold).'); } else { const c = sel.L.colors[sel.j], grp = sel.L.groups.find(q => q.includes(sel.j)); push('h', 'EMPTY ' + GEM_COLORS[c].name.toUpperCase() + ' SOCKET', GEM_COLORS[c].css); push('sub', 'LINKED TO ' + (grp.length - 1) + ' OTHER SOCKET' + (grp.length === 2 ? '' : 'S')); push('p', 'Press ' + padTxt('A') + ', then pick a gem from the bag. A gem in a socket of its own colour counts as +1 level. Support gems affect every skill in their link group.'); } }
    else if (sel.zone === 'hot') { push('h', 'HOTBAR SLOT ' + (sel.i + 1), '#a9bccb'); push('p', RP.hot[sel.i] ? 'The bound gem is not socketed right now.' : 'Empty. Socket a skill gem, then ' + padTxt('X') + ' on it binds it here. ' + padTxt('A') + ' on this slot cycles the socketed skills.'); push('sub', VR.presenting ? 'WRIST BAR  ·  slot ' + (sel.i + 1) + (sel.i < 2 ? '  ·  stick flick ' + (sel.i ? 'down' : 'up') : '  ·  left grip + flick') : 'KEYS  ' + (sel.i + 1) + '   ·   PAD  ' + padTxt('LB + ' + 'ABXY'[sel.i])); }
    else { push('h', 'EMPTY', '#8195a6'); push('p', 'Gems drop from enemies, chests, crates and Sun Shards. Skill gems level up as you use them.'); }
    return L;
  }
  const g = sel.gem, d = GEM_BY_ID[g.id], el = gemElemOf(d); push('h', d.name, RPG_RARITY_COL[d.tier]); push('sub', [d.kind === 'skill' ? 'SKILL GEM' : 'SUPPORT GEM', el ? el.name.toUpperCase() : '', GEM_COLORS[d.color].name.toUpperCase(), 'LEVEL ' + g.lv, g.lk ? 'LOCKED' : ''].filter(Boolean).join('  ·  '));
  push('bar', 'XP', '#53e0d0', { v: g.lv >= GEM_TUNING.maxLevel ? 1 : g.xp / gemXpNext(g.lv), txt: g.lv >= GEM_TUNING.maxLevel ? 'MAX LEVEL' : Math.floor(g.xp) + ' / ' + gemXpNext(g.lv) + ' XP' }); push('p', d.text);
  if (d.kind === 'skill') {
    const a = gemFindActive(g.u), ctx = { aff, skillCol: a ? a.skillCol : null }, R = a ? a.R : gemFinal(gemResolve(g, [], ctx), S); push('sep');
    push('row', 'Damage / hit', f1(R.hit) + (R.multi ? '  x' + (1 + R.multi) : '')); push('row', 'Spark cost', f1(R.cost)); push('row', 'Cooldown', R.cd.toFixed(2) + ' s'); push('row', 'Crit chance', pc(R.crit)); push('row', 'Damage / s (est.)', f1(R.dps));
    if (R.pierce) push('row', 'Pierces', R.pierce); if (R.chain) push('row', 'Chains', R.chain); if (R.fork) push('row', 'Forks', R.fork); if (R.echo) push('row', 'Repeats', R.echo); if (R.burn) push('row', 'Burn', pc(R.burn)); if (R.slow) push('row', 'Slow', pc(R.slow)); if (R.affDmg) push('row', 'Class affinity', '+' + pc(R.affDmg) + ' damage');
    if (a) { push('h2', 'LINKED SUPPORTS'); if (!a.R.sups.length) push('p', 'None. Socket supports in linked sockets (the bar between two sockets) to modify this skill.'); for (const q of a.R.sups) push('sup', q.name + '  Lv ' + q.lvl, q.ok ? '#9cf7ab' : '#ff9a8a', { ok: q.ok, note: q.ok ? '' : 'no effect on this skill' }); }
    else push('p', 'Not socketed: it does nothing until it sits in a socket (' + padTxt('A') + ' in the bag).');
  } else {
    push('sep'); for (const r of gemEffectRows(d, g.lv)) push('row', r[0], String(r[1])); push('h2', 'WORKS WITH'); const names = GEM_SKILLS.filter(s => gemSupportOk(g, s)).map(s => s.name); push('p', d.req.includes('any') ? 'Every skill.' : names.join(', ') || 'No skill.');
    const tgt = GM.active.find(a => gemSupportOk(g, a.gem) && !a.sups.some(q => q.gem.u === g.u)); if (tgt && sel.zone !== 'sock') { const ctx = { aff, skillCol: tgt.skillCol, supCols: tgt.supCols.concat([null]) }, cmp = gemCompareSupport(tgt.gem, tgt.sups.map(q => q.gem), g, S, ctx); push('h2', 'COMPARE  ·  ON ' + GEM_BY_ID[tgt.gem.id].name.toUpperCase());
      const row = (lab, a, b, fmt, lowerBetter) => { const up = lowerBetter ? b < a - 1e-6 : b > a + 1e-6, dn = lowerBetter ? b > a + 1e-6 : b < a - 1e-6; push('cmp', lab + '  ' + fmt(a) + '  →  ' + fmt(b), up ? '#7bf08a' : dn ? '#ff8f7a' : '#a9bccb', { up, dn }); };
      row('Damage / hit', cmp.hit[0], cmp.hit[1], f1, false); row('Damage / s', cmp.dps[0], cmp.dps[1], f1, false); row('Spark cost', cmp.cost[0], cmp.cost[1], f1, true); row('Cooldown', cmp.cd[0], cmp.cd[1], v => v.toFixed(2) + 's', true); } }
  return L;
}
function gemCellHTML(spec, g, focus, extra) { const d = g && GEM_BY_ID[g.id]; return `<div class="gc${focus ? ' focus' : ''}${g ? ' t' + d.tier : ''}${extra || ''}" data-gz="${spec}">${g ? `<canvas data-gu="${spec}"></canvas><span class="gl">${g.lv}</span>${g.lk ? '<span class="gk">&#9679;</span>' : ''}` : ''}</div>`; }
function gemActLabels(sel, tg) { // labels of the five actions for the current selection (shared by the DOM tab and the VR panel)
  const zone = sel.zone, hasG = !!sel.gem, skill = hasG && gemIsSkill(sel.gem.id);
  return {
    A: tg && zone === 'gem' ? 'PLACE HERE' : zone === 'gem' ? (hasG ? 'SOCKET' : '-') : zone === 'sock' ? (hasG ? 'TAKE OUT' : 'SOCKET A GEM') : zone === 'stash' ? (hasG ? 'TAKE' : '-') : 'CYCLE SKILL',
    X: zone === 'sock' ? (skill ? 'BIND HOTBAR' : '-') : zone === 'gem' ? (hasG ? 'TO STASH' : '-') : zone === 'stash' ? (hasG ? 'TO BAG' : '-') : 'CLEAR SLOT',
    Y: hasG ? (sel.gem.lk ? 'UNLOCK' : 'LOCK') : '-', RT: zone === 'gem' ? 'SALVAGE x2' : zone === 'sock' && sel.key !== 'core' ? 'RESOCKET x2' : '-', LT: 'SORT GEM BAG',
  };
}
function gemsHTML() {
  const sel = guSel(), tg = GU.tgt;
  const rows = GEM_ROWS.map((k, r) => {
    const it = gemRowItem(k), L = it ? gemSockets(it) : null; let cells = ''; if (L && L.n) for (let j = 0; j < L.n; j++) { const g = it.gems ? it.gems[j] : null, f = GU.zone === 'sock' && GU.row === r && GU.j === j; cells += `<div class="sk c${L.colors[j]}${f ? ' focus' : ''}${tg && tg.row === r && tg.j === j ? ' tgt' : ''}" data-gz="sock:${r}:${j}">${g ? `<canvas data-gu="sock:${r}:${j}"></canvas><span class="gl">${g.lv}</span>` : ''}</div>` + (j < L.n - 1 ? `<i class="lk${L.links[j] ? ' on' : ''}"></i>` : ''); }
    const nm = it && k !== 'core' ? `<small style="color:${RPG_RARITY_COL[RPG_RARITIES.indexOf(it.rarity)]}">${esc(rpgItemName(it))}</small>` : k === 'core' ? '<small>innate rig</small>' : '<small style="opacity:.5">empty</small>';
    return `<div class="skRow${GU.zone === 'sock' && GU.row === r ? ' cur' : ''}"><label>${GEM_ROW_LABEL[k]}${nm}</label><div class="skCells">${cells || `<span class="nosk">${it ? 'no sockets' : '-'}</span>`}</div></div>`;
  }).join('');
  const hot = [0, 1, 2, 3].map(i => { const uid = RP.hot[i], a = uid ? gemFindActive(uid) : null; return `<div class="hk"><b>${i + 1}</b>${gemCellHTML('hot:' + i, a ? a.gem : null, GU.zone === 'hot' && GU.i === i, uid && !a ? ' stale' : '')}<small>${padTxt('LB+' + 'ABXY'[i])}</small></div>`; }).join('');
  const bag = RP.gems.map((g, i) => gemCellHTML('gem:' + i, g, GU.zone === 'gem' && GU.i === i)).join(''), stash = RP.stash.map((g, i) => gemCellHTML('stash:' + i, g, GU.zone === 'stash' && GU.i === i, ' sm')).join('');
  const lines = gemDetailLines(sel), det = lines.map(l => { const c = l.c ? ` style="color:${l.c}"` : ''; switch (l.k) { case 'h': return `<div class="tipName"${c}>${esc(l.t)}</div>`; case 'sub': return `<div class="tipSub">${esc(l.t)}</div>`; case 'p': return l.t ? `<div class="gdP">${esc(l.t)}</div>` : ''; case 'sep': return '<div class="gdSep"></div>'; case 'h2': return `<h4 class="gdH">${esc(l.t)}</h4>`; case 'row': return `<div class="tipRow base"><b>${esc(l.t)}</b><span class="rg" style="color:#fff">${esc(l.c)}</span></div>`; case 'bar': return `<div class="gdBar"><i style="width:${Math.round(l.v * 100)}%"></i><span>${esc(l.txt)}</span></div>`; case 'sup': return `<div class="tipRow"${c}>${l.ok ? '&#10003;' : '&#10007;'} ${esc(l.t)}${l.note ? `<span class="rg">${esc(l.note)}</span>` : ''}</div>`; case 'cmp': return `<div class="cmp ${l.up ? 'up' : l.dn ? 'dn' : ''}">${l.up ? '&#9650;' : l.dn ? '&#9660;' : '&#9679;'} ${esc(l.t)}</div>`; default: return ''; } }).join('');
  const lead = tg ? `<div class="gdHint">CHOOSE A GEM FOR THE <b>${GEM_COLORS[gemSockets(gemRowItem(GEM_ROWS[tg.row])).colors[tg.j]].name.toUpperCase()}</b> SOCKET  &middot;  ${padTxt('B')} cancels</div>` : '';
  return `<div class="pnl colSk"><h3>SOCKETS &middot; LINKS</h3>${rows}<div class="gdFoot">Linked sockets (the bar between them) share supports. Matching gem and socket colour: +1 level.</div></div>
  <div class="pnl colGem"><h3>HOTBAR</h3><div class="hotRow">${hot}</div><h3>GEM BAG ${RP.gems.filter(Boolean).length} / ${GEM_TUNING.bagN}</h3><div class="gemGrid">${bag}</div><h3 style="margin-top:.5em">SHARED STASH ${RP.stash.filter(Boolean).length} / ${GEM_TUNING.stashN}</h3><div class="stashGrid">${stash}</div></div>
  <div class="pnl colTip" id="gemTip">${lead}${det}<div class="gdAct">${(() => { const L = gemActLabels(sel, tg); return ['A', 'X', 'Y', 'RT', 'LT'].map(k => `<button data-ga="${k}"${L[k] === '-' ? ' disabled' : ''}>${L[k]}</button>`).join(''); })()}</div></div>`;
}
function gemsPaint(body) { body.querySelectorAll('canvas[data-gu]').forEach(cv => { const g = guGemAt(cv.dataset.gu); if (g) gemDrawIcon(cv, g); }); }
const _rpgRenderInv3 = rpgRenderInv; rpgRenderInv = function () { _rpgRenderInv3(); if (RUI.open && RUI.tab === 5 && !VR.presenting) { gemsPaint($('invBody')); const K = (cls, t, lab) => `<span><i class="kk ${cls}">${padTxt(t)}</i>${lab}</span>`; $('invFoot').innerHTML = K('a', 'A', 'Socket / take') + K('x', 'X', 'Hotbar / stash') + K('y', 'Y', 'Lock') + K('t', 'RT', 'Salvage / resocket (x2)') + K('t', 'LT', 'Sort') + K('t', 'LB RB', 'Tabs') + K('b', 'B', 'Close'); } };
$('inv').addEventListener('click', e => {
  if (RUI.open && RUI.tab === 5) { const b = e.target.closest('[data-ga]'); if (b && !b.disabled) { guAct(b.dataset.ga); return; } }
  if (!RUI.open || RUI.tab !== 5) return; const el = e.target.closest('[data-gz]'); if (!el) return; const q = el.dataset.gz.split(':'), now = performance.now(), key = el.dataset.gz, dbl = GU.lastK === key && now - GU.lastT < 450; GU.lastK = key; GU.lastT = now;
  if (q[0] === 'sock') { GU.zone = 'sock'; GU.row = +q[1]; GU.j = +q[2]; } else { GU.zone = q[0]; GU.i = +q[1]; } if (dbl || (GU.tgt && q[0] === 'gem')) guAct('A'); else { rsfx('ui'); rpgRenderInv(); }
});
$('inv').addEventListener('contextmenu', e => { if (!RUI.open || RUI.tab !== 5) return; const el = e.target.closest('[data-gz]'); if (!el) return; e.preventDefault(); const q = el.dataset.gz.split(':'); if (q[0] === 'sock') { GU.zone = 'sock'; GU.row = +q[1]; GU.j = +q[2]; } else { GU.zone = q[0]; GU.i = +q[1]; } guAct('X'); });
