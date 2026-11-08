// <food-game> ===================================================================================================================
// SHATTERWORLD food + materials + the home-town save, part 2a: integration. The pure logic (food-core / craft-core / town-core) is wired into the running game here, additively: the existing functions are
// re-bound from the outside (spawnLoot, rpgPickupLoot, rpgDrops, rpgOnKilled, invSalvage, invBulk, rpgStatState, rpgSaveNow, rpgFrame, rpgSpawnAct, rpgStartRift, rpgRiftEnd, collectShard, rpgKeyDown).
//  * ingredient / material loot (monsters, crates, chests, shards) is a new loot kind that rides the existing loot physics + magnet; gatherable herb / ore nodes are 3 InstancedMeshes (3 draw calls however many)
//  * cooked dishes and potions are timed buffs that feed rpgComputeStats through the class-mods channel, so every cap and the character sheet already apply; heal-over-time is a per-frame tick
//  * the town + satchel live in ONE versioned state object saved under swn_town (and as the additive key `town` of the shelf save); old swn_rpg saves load untouched
// ==============================================================================================================================
const FD = { kill: null, n: ((Math.random() * 1e9) >>> 0), lastSrv: -99, err: 0, nodes: [], nodeT: 0, spk: 0, pill: '', hotAcc: 0, log: [] };
const TOWN_KEY = 'swn_town';
let TOWN = townDefault(((RP.seed >>> 0) ^ 0x70771) >>> 0);
function townLoad() {
  let raw = null; try { const v = localStorage.getItem(TOWN_KEY); if (v) raw = JSON.parse(v); } catch (e) { }
  if (!raw) try { const g = (JSON.parse(localStorage.getItem('ib_saves') || '{}') || {})['shatterworld-next']; if (g && g.town) raw = g.town; } catch (e) { }
  TOWN = raw ? townClean(raw, rpgCleanItem) : townDefault(((RP.seed >>> 0) ^ 0x70771) >>> 0); return !!raw;
}
function townTouch() { RT.dirty = true; }
function townSaveNow(light) {
  const snap = townSnapshot(TOWN); try { localStorage.setItem(TOWN_KEY, JSON.stringify(snap)); } catch (e) { }
  if (light && RT.real - FD.lastSrv < 20) return; FD.lastSrv = RT.real; try { if (window.__save) window.__save({ town: snap, townTier: townTier(TOWN, 'hall'), renown: TOWN.renown | 0 }); } catch (e) { }
}
{ const _s = rpgSaveNow; rpgSaveNow = function (light) { _s(light); try { townSaveNow(light); } catch (e) { console.error('town save', e); } }; }
{ const r0 = window.__rpg.reset; window.__rpg.reset = function () { r0(); try { localStorage.removeItem(TOWN_KEY); } catch (e) { } TOWN = townDefault(((RP.seed >>> 0) ^ 0x70771) >>> 0); rpgRecalc(); if (typeof townAfterReset === 'function') townAfterReset(); }; }
townLoad();
const LEDGER = { get gold() { return RP.gold; }, set gold(v) { RP.gold = v; RT.dirty = true; }, get dust() { return RP.dust; }, set dust(v) { RP.dust = v; RT.dirty = true; }, get sat() { return TOWN.sat; } };
const townCap = () => TOWN_STACK[townTier(TOWN, 'warehouse')] || 99;
const fdKindOf = id => MATS[id] ? 'mat' : 'ing';
const fdDef = id => INGS[id] || MATS[id];
