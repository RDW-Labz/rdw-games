// ---- wrappers: world / run / screens -----------------------------------------------------------------------------------------------------------------------------------------
const _setupAct1Entities = setupAct1Entities; setupAct1Entities = function () { _setupAct1Entities(); RT.pend = { act: 1 }; };
const _setupLevelEntities = setupLevelEntities; setupLevelEntities = function (L) { _setupLevelEntities(L); RT.pend = { act: L.act }; };
const _clearEntities = clearEntities; clearEntities = function () { if (RT.S && !RIFT) rpgVacuum(); rpgClearProps(); for (const e of ENEMIES) rpgDisposeEnemy(e); for (const p of PROJ) { p.on = false; p.m.visible = false; } RT_TIMERS.length = 0; _clearEntities(); };
const _resetHero = resetHero; resetHero = function (pos, keepHp) { _resetHero(pos, keepHp); rpgHealFull(); RT.shield = 0; RT.chill = 0; RT.combo = 0; RT.goldStack = 0; RT.surgeT = 0; rpgSetBuffs(); };
const _startRun = startRun;
startRun = function () { RIFT = null; RT.runFlags = {}; RT.runDiff = RP.diff; Object.assign(RUN, { xp: 0, kills: 0, elites: 0, loot: [0, 0, 0, 0], gold: 0, dust: 0, lvStart: RP.level, levels: 0, legends: [], salv: 0, shards: 0 }); document.body.classList.remove('rift'); _startRun(); RT.hp = RT.max; rpgMirror(); };
const _killHero = killHero; killHero = function (reason) {
  if (P.dead || G.state !== 'play') return; _killHero(reason); RT.hp = 0; rpgMirror(); rpgVacuum(); rpgSaveNow();
  if (RIFT) { RIFT.done = false; rpgRiftEnd(false, 'dead'); } else { rpgDeadExtras(); }
};
const _victory = victory; victory = function () {
  _victory(); rpgVacuum(); const lines = [], diff = RT.runDiff, mlvl = rpgMonsterLevel({ act: 3, diff, idx: 3 }); rpgGainXp(rpgObjectiveXp('act', mlvl, diff, RP.level) * 2, 'finale');
  if (!RP.riftUnlocked) { RP.riftUnlocked = true; lines.push('SHATTER RIFTS UNLOCKED'); } if (RT.runDiff >= RP.diffUnlocked && RP.diffUnlocked < 2) { RP.diffUnlocked = RT.runDiff + 1; lines.push(RPG_TUNING.difficulty[RP.diffUnlocked].name + ' DIFFICULTY UNLOCKED'); }
  if (RT.runDiff < RP.diffUnlocked && RP.diff === RT.runDiff) RP.diff = RT.runDiff + 1 <= RP.diffUnlocked ? RT.runDiff + 1 : RP.diff;
  RP.totals.runs++; rpgSaveNow(); $('deadS').innerHTML += '<br>' + RPG_TUNING.difficulty[RT.runDiff].name + ' cleared' + (lines.length ? '<br><b style="color:#8af7e6">' + lines.join(' &middot; ') + '</b>' : ''); rpgDeadExtras(); rpgRenderMenu();
};
const _beginGame = beginGame; beginGame = function () { _beginGame(); if (!RP.intro && G.state === 'play') { RP.intro = true; RT.dirty = true; setTimeout(() => { if (G.state === 'play') toast('Defeat enemies, break crates, open chests. Walk over loot to collect it. ' + (VR.presenting ? 'Hold Y (left) for your inventory.' : 'Press I / Tab / ' + padTxt('Y') + ' for your inventory.'), 7000); }, 3600); } };
const _retry = retry; retry = function () { if (RIFT) { if (RIFT.done) rpgRiftRestart(!RIFT.won, RIFT.won); else rpgRiftRestart(true, false); return; } _retry(); };
const _toMenu = toMenu; toMenu = function () { RIFT = null; _toMenu(); rpgRenderMenu(); };
const _updateHUD = updateHUD; updateHUD = function () { _updateHUD(); if (RT.S) $('coinN').textContent = rfmt(RP.gold); if (RIFT) $('actName').textContent = 'SHATTER RIFT · TIER ' + RIFT.tier; document.body.classList.toggle('rift', !!RIFT); };
const _updateBestLine = updateBestLine; updateBestLine = function () { _updateBestLine(); const b = $('best'); b.textContent += '  ·  LV ' + RP.level + (RP.diff ? '  ·  ' + RPG_TUNING.difficulty[RP.diff].name : ''); };
const _padMenu = padMenu; padMenu = function () { if (PK.open) return; if (RUI.open) { if (RUI.rr) { RUI.rr = null; rpgRenderInv(); } else closeInv(); return; } _padMenu(); };
const _padFire = padFire; padFire = function (down) { if (RUI.open) { if (down === true || down === undefined) uiAct('RT'); else _padFire(false); return; } if (PK.open) { if (down === true || down === undefined) perkPick(PK.i); else _padFire(false); return; } _padFire(down); };
const _padPlace = padPlace; padPlace = function (down) { if (RUI.open) { if (down === true || down === undefined) uiAct('LT'); else _padPlace(false); return; } if (PK.open) { if (down === false) _padPlace(false); return; } _padPlace(down); };

