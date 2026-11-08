// ---- quests: one funnel for every kind of progress -----------------------------------------------------------------------------------------------------------------------------------------------------------------
function townQuest(ev, info) {
  let done; try { done = questEvent(TOWN, ev, info); } catch (e) { return []; } if (!done.length) return done; RT.dirty = true;
  for (const q of done) { rpgLogLine('Goal complete: ' + questText(q), '#8fd0ff'); } rsfx('pick1'); toast('GOAL COMPLETE - claim it at the Notice Board'); return done;
}
// ---- recipe discovery -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
function fdDiscover(quiet) {
  const ctx = { tiers: townTiers(TOWN), seen: TOWN.seen, known: TOWN.known, level: RP.level }, fresh = foodDiscoverNow(ctx);
  for (const id of fresh) { TOWN.known[id] = 1; if (!quiet) { rpgLogLine('New recipe: ' + FOOD_RECIPES[id].name, '#ffb15e'); rsfx('pick2'); } } if (fresh.length) RT.dirty = true; return fresh;
}
function fdSee(id) { if (!TOWN.seen[id]) { TOWN.seen[id] = 1; RT.dirty = true; return true; } return false; }
// ---- the satchel -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
function fdGive(kind, id, n, silent) { // -> what actually fit; the overflow is sold to the market stall's cart (never lost silently)
  const d = kind === 'dish' || kind === 'pot' ? null : fdDef(id); const put = satAdd(TOWN.sat, kind, id, n, townCap()), over = n - put;
  if (over > 0 && d) { const g = Math.max(1, Math.round(d.sell * over * 0.5)); RP.gold += g; RUN.gold += g; if (!silent) rpgLogLine(d.name + ' stack is full: sold ' + over + ' for ' + g + ' gold', '#9fb4c8'); }
  RT.dirty = true; if (d && fdSee(id) && !silent) fdDiscover(); return put;
}
function fdSellValue(kind, id) { const d = fdDef(id); return d ? d.sell : 12; }
// ---- stats: dishes / potions + town perks ride the class-mods channel ------------------------------------------------------------------------------------------------------------------------------------------
{ const _ss = rpgStatState; rpgStatState = function () { const s = _ss(); const fm = foodMods(TOWN.buffs), tm = townMods(TOWN); let any = false; for (const _k in fm) { any = true; break; } if (!any) for (const _k in tm) { any = true; break; } if (!any) return s; const c = Object.assign({}, s.cmods || {}); for (const k in fm) c[k] = (c[k] || 0) + fm[k]; for (const k in tm) c[k] = (c[k] || 0) + tm[k]; s.cmods = c; return s; }; }
const fdKitchenTier = () => townTier(TOWN, 'kitchen');
function fdBuffTime(t) { t = Math.max(0, Math.ceil(t)); return ((t / 60) | 0) + ':' + String(t % 60).padStart(2, '0'); }
function fdUse(kind, key, quiet) { // eat / drink one stack item
  if (!(kind === 'dish' || kind === 'pot') || satCount(TOWN.sat, kind, key) < 1) return { ok: false, why: 'none left' }; const [rid, q] = key.split(':'), r = FOOD_RECIPES[rid]; if (!r) return { ok: false, why: 'unknown' };
  if (G.state !== 'play' && G.state !== 'sta' && G.state !== 'inv') return { ok: false, why: 'not now' };
  const b = foodMakeBuff(rid, q | 0, fdKitchenTier()); if (!b) return { ok: false, why: 'bad item' }; satTake(TOWN.sat, kind, key, 1);
  if (b.heal > 0) { const v = RT.max * b.heal; RT.hp = Math.min(RT.max, RT.hp + v); rpgMirror(); if (!quiet) { floatText(P.x, P.y + 1.9, P.z, '+' + Math.round(v), 'heal'); sparkBurst(P.x, P.y + 1, P.z, 12, 0x8af7a0, 4); } }
  TOWN.buffs = foodApplyBuff(TOWN.buffs, b); rpgRecalc(); RT.dirty = true; rsfx(kind === 'pot' ? 'heal' : 'pick1'); rpgLogLine((kind === 'pot' ? 'Drank ' : 'Ate ') + b.name + '  (' + fdBuffTime(b.t) + ')', b.col);
  if (!quiet && G.state === 'play') { sparkBurst(P.x, P.y + 1.2, P.z, 14, new THREE.Color(b.col).getHex(), 5); fxRing(P.x, P.y, P.z, 0.4, 2.2, 0.6, new THREE.Color(b.col).getHex(), 0.9); } return { ok: true, buff: b };
}
function fdQuickPotion() { // H / LB + Y: the best healing potion first, else any potion, else a meal that isn't active
  const keys = Object.keys(TOWN.sat.pot); if (!keys.length) { toast('No potions. Brew some at the Apothecary.'); rsfx('deny'); return false; }
  keys.sort((a, b) => ((FOOD_RECIPES[b.split(':')[0]].out.heal || 0) - (FOOD_RECIPES[a.split(':')[0]].out.heal || 0)) || (b.split(':')[1] - a.split(':')[1])); const r = RT.hp < RT.max * 0.7 ? fdUse('pot', keys[0]) : fdUse('pot', keys[keys.length - 1]); if (!r.ok) { toast(r.why); rsfx('deny'); } return r.ok;
}
function fdBuffPills(buf) { for (const b of TOWN.buffs) buf.push(b.name + ' ' + fdBuffTime(b.t)); }
function fdVrChips(chip) { for (const b of TOWN.buffs) chip(b.name.split(' ').slice(-2).join(' ') + ' ' + fdBuffTime(b.t), b.col); }
// per-frame: buffs run down in play time only; heal-over-time
{ const _f = rpgFrame; rpgFrame = function (rdt, sdt) { _f(rdt, sdt); try { fdFrame(rdt, sdt); } catch (err) { if (!FD.err) { FD.err = 1; console.error('food frame', err); } } }; }
function fdFrame(rdt, sdt) {
  if (G.state !== 'play') { if (G.state === 'menu') FD.nodeT = 0; return; }
  if (TOWN.buffs.length && !P.dead) {
    const n0 = TOWN.buffs.length, hot = foodHot(TOWN.buffs); foodTick(TOWN.buffs, sdt); if (hot > 0 && RT.hp < RT.max && RT.hp > 0) { RT.hp = Math.min(RT.max, RT.hp + hot * RT.max * sdt); FD.hotAcc += sdt; if (FD.hotAcc > 0.5) { FD.hotAcc = 0; rpgMirror(); } }
    if (TOWN.buffs.length !== n0) { rpgRecalc(); RT.dirty = true; rpgLogLine('A food effect wore off', '#9fb4c8'); }
  }
  fdNodesFrame(rdt);
}
