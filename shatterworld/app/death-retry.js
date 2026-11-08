// ---- death / retry / victory -------------------------------------------------------------------------------------------------------
function killHero(reason) {
  if (P.dead || G.state !== 'play') return; P.dead = true; G.state = 'dead'; G.deaths++; sfx('die'); document.exitPointerLock && document.exitPointerLock();
  $('dead').className = 'ovl lose'; $('deadT').textContent = 'TRY AGAIN'; $('deadS').innerHTML = (reason === 'fall' ? 'You fell out of the world.' : 'Three hits and the plumber is down.') + '<br>Shards ' + G.totalShards + ' · Coins ' + G.coins + ' · ' + fmtTime(G.t); $('cta2').textContent = 'RETRY'; $('dead').classList.remove('hidden');
  saveRun(false);
}
function saveRun(win) {
  const prev = G.best; if (win && (!G.best || G.t < G.best)) { G.best = G.t; try { localStorage.setItem('swn_best', String(G.best)); } catch (e) { } }
  if (window.__save) window.__save({ best: G.best, score: G.score, time: Math.round(G.t), coins: G.coins, shards: G.totalShards, deaths: G.deaths, won: !!win, newBest: !!win && G.best !== prev });
}
function resetHero(pos, keepHp) {
  P.dead = false; P.hp = TUNING.hp; P.big = false; P.invuln = 1.2; P.hurtT = 0; P.frozen = 0; P.vx = P.vy = P.vz = 0; P.act = 'air'; P.size = 1; P.chainN = 0; P.victory = 0; P.talk = 0; GF = 1; CAM.roll = 0; P.crouch = false; warpT = 0; warpTarget = null;
  setHeroPos(pos.x, pos.y, pos.z); P.grounded = false; CAM.ty = pos.y + 1.2; CAM.dist = TUNING.cam.dist;
}
function startRun() {
  G.flags = { 1: [], 2: [], 3: [] }; G.totalShards = 0; G.coins = 0; G.runCoins = 0; G.score = 0; G.t = 0; G.deaths = 0; G.won = false; G.ck = { act: 1, O: null, pos: { x: SITES.spawn.x, y: SITE_H.spawn, z: SITES.spawn.z }, coins: 0, t: 0 }; G.finale = null; G.slow = 1;
  loadAct(1); resetHero(G.ck.pos); P.yaw = 0.55; CAM.yaw = 0.55; CAM.pitch = 0.27;
}
function retry() {
  const ck = G.ck; if (ck && ck.act === 4) { $('dead').classList.add('hidden'); victory(); return; } if (!ck) { startRun(); } else {
    SH = { on: false }; G.trans = null; WV.R1 = -1; WV.R2 = -1; syncWave(); G.slow = 1; G.cine = 0; CAM.cine = 0;
    if (ck.act === 1) { const keep = G.flags[1].slice(); loadAct(1); } else loadAct(ck.act);
    G.coins = ck.coins || 0; G.t = ck.t || G.t; G.flags[G.act].forEach((v, i) => { }); let pos = ck.pos; if (!pos) pos = LV ? { x: LV.O.x + LV.start.x, y: LV.O.y + LV.start.y, z: LV.O.z + LV.start.z } : { x: SITES.spawn.x, y: SITE_H.spawn, z: SITES.spawn.z };
    if (ck.shatterPending) { /* died during the transition: restart at the new act's beginning */ }
    resetHero(pos); updateHUD();
  }
  $('dead').classList.add('hidden'); G.state = 'play'; requestLock();
}
function victory() {
  G.won = true; G.state = 'dead'; saveRun(true); sfx('victory'); $('dead').className = 'ovl'; $('deadT').textContent = 'WORLD RESTORED'; $('deadS').innerHTML = 'All Sun Shards gathered.<br>Time ' + fmtTime(G.t) + ' · Coins ' + G.coins + ' · Shards ' + G.totalShards + (G.best && Math.abs(G.best - G.t) < 1 ? '<br>NEW BEST TIME' : '<br>Best ' + fmtTime(G.best)); $('cta2').textContent = 'PLAY AGAIN'; $('dead').classList.remove('hidden');
  document.exitPointerLock && document.exitPointerLock();
}
function restartAll() { $('dead').classList.add('hidden'); startRun(); G.state = 'play'; requestLock(); updateHUD(); }

