// <town-game> ===================================================================================================================
// SHATTERWORLD home town, part 2b: the town as a PLACE. Enter from the main menu, the pause menu, the dead / win screens or the VR panels; the hero spawns at the plaza, walks between the buildings,
// presses E at a door / stall / board / gate / garden (Press E prompts, same as every other interaction) and a station screen opens (sui-model / sui-ui). Villagers walk the roads, chimneys smoke, the fountain sprays,
// windows and lamps light up at dusk, and an upgrade makes the new building FLY together out of cubes (the engine's own rebuild animation). Leaving: the gate = campaign / new run / Shatter Rift / menu.
// Everything saved lives in TOWN (food-game). The campaign checkpoint (G.ck) is untouched while you visit; "continue" is retry().
// ==============================================================================================================================
Object.assign(PAL, {
  4: { zen: 0x2d6fd6, mid: 0x8cc4f0, hor: 0xffe0b0, gnd: 0xdce8fa, sun: 0xffd9a0, sunI: 3.0, hemiS: 0x9cc4ff, hemiG: 0x9a8a6a, hemiI: 0.58, fog: 0xeee4d0, fogD: 0.0021, cloud: 0.55, cloudLit: 0xfff4de, cloudSh: 0x9ab0d8, stars: 0, exp: 1.0, env: 0.55, sunDir: [-0.6, 0.5, 0.45] },
  5: { zen: 0x3a2a8a, mid: 0xd07aa8, hor: 0xff9a5a, gnd: 0x9a6a94, sun: 0xff9a60, sunI: 2.3, hemiS: 0xc090e0, hemiG: 0x804050, hemiI: 0.52, fog: 0xd09a8c, fogD: 0.003, cloud: 0.5, cloudLit: 0xffc0a0, cloudSh: 0x7a5a9a, stars: 0.35, exp: 1.0, env: 0.5, sunDir: [-0.82, 0.14, 0.3] },
  6: { zen: 0x050a22, mid: 0x142a5e, hor: 0x3a4a9a, gnd: 0x141c48, sun: 0x9fb8ff, sunI: 1.0, hemiS: 0x4a6ac8, hemiG: 0x1a2040, hemiI: 0.62, fog: 0x1c2658, fogD: 0.0038, cloud: 0.2, cloudLit: 0x8aa0e0, cloudSh: 0x2a3060, stars: 1, exp: 1.12, env: 0.5, sunDir: [0.4, 0.5, -0.5] },
});
const TW = { on: false, lv: null, O: { x: 0, y: 24, z: 0 }, L: null, pts: [], npcs: [], walkers: [], grp: null, ret: null, near: null, t: 0, cubeAt: null, win: [], lamps: [], night: -1, envNight: -9, lastGlow: -9, ek: 0, pending: null, spawn: null, bedFx: [], fx: { smoke: 0, spark: 0, fount: 0, portal: 0, ring: 0 }, lastBlink: 0, upN: 0, err: 0, built: 0 };
const TW_KEY = { day: 4, dusk: 5, night: 6 };
const TW_FDIR = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const wp = (x, z) => ({ x: TW.O.x + x + 0.5, z: TW.O.z + z + 0.5 });
(() => { const st = document.createElement('style'); st.textContent = 'body.town #shards, body.town #shardDist { display:none !important; } body.town #hudR b#timeN { visibility:hidden; } #pauseTownBtn { font:inherit;letter-spacing:.2em;font-size:12px;color:#2a1400;background:linear-gradient(180deg,#9af0e0,#53e0d0 55%,#2aa89a);border:0;border-radius:999px;padding:.4em 1.4em;cursor:pointer;font-weight:800; } #pause #pauseBtns { flex-direction:row; flex-wrap:wrap; justify-content:center; gap:6px 10px; padding:0 4vw; } #pause #pauseBtns small { flex-basis:100%; text-align:center; }'; document.head.appendChild(st); /* the pause buttons wrap into rows: four stacked buttons would grow up into the middle of a small screen, where a click must always resume */ })();
// ---- town clock + atmosphere -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
function twAtmos(force) {
  const c = townClock(TOWN.clock); setAtmosphere(TW_KEY[c.a], TW_KEY[c.b], c.f); applyAtmosphere(); TW.night = c.night;
  if (force || Math.abs(c.night - TW.envNight) > 0.22) { TW.envNight = c.night; updateEnv(); }
  if (Math.abs(c.night - TW.lastGlow) > 0.03 || force) { TW.lastGlow = c.night; twApplyGlow(c.night); }
}
function twCollectGlow() { TW.win.length = 0; TW.lamps.length = 0; const wv = TW.lv.vb.palFx[TWP.win], lv = TW.lv.vb.palFx[TWP.lamp]; for (let k = 0; k < cubeHi; k++) { const st = C.st[k]; if (st === ST.FREE || C.tgl[k] <= 0) continue; if (Math.abs(C.tgl[k] - wv) < 2e-3) TW.win.push(k); else if (Math.abs(C.tgl[k] - lv) < 2e-3) TW.lamps.push(k); } TW.lastGlow = -9; }
function twApplyGlow(n) { const w = 0.12 + 1.25 * n, l = 0.234 + 1.5 * n; for (const k of TW.win) { if (C.st[k] === ST.FREE) continue; C.tgl[k] = w; if (C.st[k] === ST.SET) { C.glow[k] = w; writeCube(k); } } for (const k of TW.lamps) { if (C.st[k] === ST.FREE) continue; C.tgl[k] = l; if (C.st[k] === ST.SET) { C.glow[k] = l; writeCube(k); } } cubesDirty = true; }
// ---- NPCs / villagers ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const TW_PAL = { mayor: [0xe8b830, 0x2a4a8a, 0xfff0c0], vendor: [0xe84a4a, 0xf2c040, 0xffffff], cook: [0xf4f0e8, 0xe88a3a, 0xffffff], smith: [0x6a7080, 0x4a4f5a, 0xb04a2a], gemwright: [0x8a5acf, 0x5a3a9a, 0xd8c0ff], brewer: [0x3fa86a, 0x2a6a4a, 0x9af0b0], keeper: [0x8a6a42, 0x5a4a32, 0xe8d8b0] };
const TW_WALK = [[0xe8754a, 0x3a5aa0, 0xfff0d8], [0x4a9ad8, 0x6a4a8a, 0xe8f0ff], [0xd8c84a, 0x2f7a5a, 0xfff8e0], [0xb04a8a, 0x3a3a5a, 0xffe8f4], [0x6ac86a, 0x8a5a3a, 0xf4ffe8]];
function twMakeNpc(id, x, z, face, pal, walker) {
  const rig = buildPlumber({ cap: pal[0], overall: pal[1], shirt: pal[2], scale: walker ? 0.88 : 0.94 }); rig.root.traverse(m => { if (m.isMesh) m.frustumCulled = false; }); rig.root.position.set(x, TW.O.y, z); const d = TW_FDIR[face | 0]; rig.root.rotation.y = Math.atan2(d[0], d[1]); TW.grp.add(rig.root); vlBake(rig.root, true); if (VR.merge) vrMergeApply(rig.root, true);
  const n = { id, rig, x, z, y: TW.O.y, face, yaw: rig.root.rotation.y, t: Math.random() * 6, wave: 0, walker: !!walker, ph: Math.random() * 6, path: null, wpi: 0, pause: 0, spd: 1.0 + Math.random() * 0.4, look: 0 }; return n;
}
function twBuildPeople() {
  const L = TW.L, S = L.stand; for (const n of TW.npcs.concat(TW.walkers)) { TW.grp.remove(n.rig.root); n.rig.root.traverse(o => { if (o.isMesh && o.material && o.material.dispose && o.userData.vrM === undefined) { /* materials are per rig */ } }); } TW.npcs.length = 0; TW.walkers.length = 0; TW.pts.length = 0;
  for (const id in TOWN_NPCS) { const npc = TOWN_NPCS[id]; if (!npc.role || id === 'walker') continue; const role = npc.role; let s = S[role]; if (!s) continue; if (role === 'market') { const d = TW_FDIR[s.face]; s = { x: s.x + 0.5, z: s.z + 0.5, face: s.face }; } else if (townTier(TOWN, role) < 1 && (role === 'gems' || role === 'apothecary')) continue; const p = wp(s.x - 0.5, s.z - 0.5); const n = twMakeNpc(id, role === 'market' ? TW.O.x + s.x : TW.O.x + s.x, role === 'market' ? TW.O.z + s.z : TW.O.z + s.z, s.face, TW_PAL[id] || TW_WALK[0], false); void p; TW.npcs.push(n); const d = TW_FDIR[s.face]; TW.pts.push({ id: role, npc: id, x: n.x + (role === 'market' ? d[0] * 1.6 : 0), z: n.z + (role === 'market' ? d[1] * 1.6 : 0), r: role === 'market' ? 2.4 : 3.0, label: 'talk to ' + npc.name, open: npc.then || 'dlg', n }); }
  const bp = wp(L.board.x, L.board.z), bd = TW_FDIR[L.board.face]; TW.pts.push({ id: 'board', x: bp.x + bd[0] * 1.8, z: bp.z + bd[1] * 1.8, r: 2.8, label: 'read the notice board', open: 'board' });
  const pp = wp(L.portal.x - 0.5, L.portal.z - 0.5); TW.pts.push({ id: 'portal', x: pp.x, z: pp.z, r: 3.4, label: 'step through the gate', open: 'portal' });
  if (L.garden) { const g = L.garden, gc = wp((g.x0 + g.x1) / 2 - 0.5, (g.z0 + g.z1) / 2 - 0.5); TW.pts.push({ id: 'garden', x: gc.x, z: gc.z, r: Math.max(g.x1 - g.x0, g.z1 - g.z0) * 0.62, label: 'tend the garden', open: 'garden' }); }
  const rg = rpgRng(rpgHashSeed(TOWN.seed, 0xA11CE)), nw = Math.min(5, 3 + townTier(TOWN, 'hall')); for (let i = 0; i < nw; i++) { const path = L.paths[i % L.paths.length]; let w0 = path[(rg() * path.length) | 0]; for (let k = 0; k < path.length && hyp2(w0.x - L.spawn.x, w0.z - L.spawn.z) < 8; k++) w0 = path[(path.indexOf(w0) + 1) % path.length]; const q = wp(w0.x - 0.5, w0.z - 0.5), n = twMakeNpc('walker', q.x, q.z, 0, TW_WALK[i % TW_WALK.length], true); n.path = path; n.wpi = (rg() * path.length) | 0; n.spd = 1.0 + rg() * 0.5; TW.walkers.push(n); }
}
const TWP_A = { hy: 0, hx: 0, ra: 0, la: 0, lx: 0, rx: 0, bob: 0 }, TWP_P = { lx: 0, rx: 0, la: 0, ra: 0, bob: 0 }, TWP_W = { lx: 0, rx: 0, la: 0, ra: 0, bob: 0, hy: 0 }; // reused pose-target objects (poseTo only reads them): no per-frame allocation
function twAnimNpc(n, dt, hx, hz) {
  const r = n.rig, dx = hx - n.x, dz = hz - n.z, d = hyp2(dx, dz); n.t += dt; const want = Math.atan2(dx, dz);
  if (!n.walker) { const near = d < 6.5; n.look += ((near ? 1 : 0) - n.look) * Math.min(1, dt * 4); n.wave += ((d < 4.5 ? 1 : 0) - n.wave) * Math.min(1, dt * 5); let ay = Math.atan2(Math.sin(want - n.yaw), Math.cos(want - n.yaw)); ay = clamp(ay, -1.0, 1.0); const wv = n.wave * (Math.sin(n.t * 7) * 0.45 - 2.3);
    { const T = TWP_A; T.hy = ay * n.look * 0.8; T.hx = -0.04 * n.look; T.ra = wv; T.la = Math.sin(n.t * 1.4) * 0.06; T.bob = Math.abs(Math.sin(n.t * 1.6)) * 0.02; poseTo(r, T, dt, 8); } n.rig.root.rotation.y = n.yaw + clamp(ay * n.look * 0.35, -0.5, 0.5); }
  applyPose(r, dt);
}
// VR draw-call diet: people farther than TWV.near (hysteresis 1 m) are drawn as one baked body + outline instead of 6 limb groups x 2 (see vlBake)
const TWV = { near: 7 };
{ const _vma = vrMergeAll; vrMergeAll = function (on) { _vma(on); if (TW.npcs) for (const n of TW.npcs.concat(TW.walkers)) vrMergeApply(n.rig.root, on); }; } // people built in flat play are merged when a VR session starts (and restored when it ends)
function twVrLod(hx, hz) { for (let k = 0; k < 2; k++) { const L = k ? TW.walkers : TW.npcs; for (const n of L) { const d = hyp2(n.x - hx, n.z - hz); n.far = n.far ? d > TWV.near - 1 : d > TWV.near; vlApply(n.rig.root, n.far ? 2 : 0, true); } } }
function twWalkers(dt, hx, hz) {
  for (const n of TW.walkers) {
    if (n.pause > 0) { n.pause -= dt; poseTo(n.rig, TWP_P, dt, 8); applyPose(n.rig, dt); continue; }
    const p = n.path[n.wpi % n.path.length], tx = TW.O.x + p.x + 0.5, tz = TW.O.z + p.z + 0.5, dx = tx - n.x, dz = tz - n.z, d = hyp2(dx, dz);
    if (d < 0.5) { n.wpi++; if (Math.random() < 0.3) n.pause = 1.5 + Math.random() * 3; continue; }
    const sp = n.spd * (1 - 0.6 * Math.max(0, 1 - hyp2(hx - n.x, hz - n.z) / 2.4)), st = Math.min(d, sp * dt); n.x += dx / d * st; n.z += dz / d * st; n.yaw += Math.atan2(Math.sin(Math.atan2(dx, dz) - n.yaw), Math.cos(Math.atan2(dx, dz) - n.yaw)) * Math.min(1, dt * 7); n.rig.root.rotation.y = n.yaw; n.rig.root.position.set(n.x, TW.O.y, n.z);
    n.ph += sp * dt * 3.4; const s = Math.sin(n.ph); { const T = TWP_W; T.lx = s * 0.75; T.rx = -s * 0.75; T.la = -s * 0.6; T.ra = s * 0.6; T.bob = Math.abs(s) * 0.05; poseTo(n.rig, T, dt, 14); } applyPose(n.rig, dt);
  }
}
// ---- interaction -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
function twNearest() {
  let best = null, bd = 1e9; for (const p of TW.pts) { const d = hyp2(P.x - p.x, P.z - p.z); if (d < p.r && d < bd) { bd = d; best = p; } }
  if (!best) for (const n of TW.walkers) { const d = hyp2(P.x - n.x, P.z - n.z); if (d < 2.0 && d < bd) { bd = d; best = n.pt || (n.pt = { id: 'walker', npc: 'walker', open: 'dlg', label: 'chat with a villager', x: 0, z: 0, r: 2, n }); best.x = n.x; best.z = n.z; } } return best;
}
function townInteract() {
  const p = TW.near; if (!p || G.state !== 'play') return false; const n = p.n; if (n && p.npc) { SUI.npc = p.npc; return suiOpen('dlg', { npc: p.npc }); } return suiOpen(p.open, {});
}
{ const _un = updateNPC; updateNPC = function (dt, t) { _un(dt, t); if (TW.on && G.state === 'play') { TW.near = twNearest(); if (TW.near && !PROMPT) PROMPT = 'Press E: ' + TW.near.label; } }; }
{ const _k = rpgKeyDown; rpgKeyDown = function (k) {
  if (!SUI.open && !RUI.open && !PK.open && !CSU.open) {
    if (TW.on && G.state === 'play' && k === 'e' && TW.near) { townInteract(); return; }
    if (G.state === 'menu' && (k === 'q' || k === 't')) { townEnter(); return; }
    if (G.state === 'pause' && (k === 'q' || k === 't')) { if (TW.on) suiOpen('portal'); else townEnter(); return; }
    if (G.state === 'dead' && (k === 'q' || k === 't')) { townEnter(); return; }
  } _k(k); }; }
// ---- enter / leave ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
function townEnter(o = {}) {
  if (TW.on) return false; if (SUI.open || RUI.open || PK.open || CSU.open) return false; const st = G.state; if (G.trans || G.finale || SH.on) { toast('Not now'); return false; } if (!(st === 'menu' || st === 'pause' || st === 'dead' || st === 'play')) return false;
  TW.ret = { from: st, run: !!(G.started && !RIFT && G.ck && !G.won && st !== 'menu' && G.ck.act !== 4), act: G.ck ? G.ck.act : 1, ck: G.ck, wasRift: !!RIFT };
  if (!G.started) G.started = true; audioInit(); for (const id of ['menu', 'dead', 'pause']) $(id).classList.add('hidden'); $('hud').classList.remove('hidden');
  rpgVacuum(); RT_TIMERS.length = 0; for (const p of PROJ) { p.on = false; p.m.visible = false; } RIFT = null; clearEntities(); RT.pend = null; mobClearFx(); fdClearNodes();
  freeAllCubes(); HOMEG.clear(); DISCS.length = 0; SH = { on: false }; G.trans = null; G.finale = null; WV.R1 = -1; WV.R2 = -1; syncWave(); setAct1Visible(false); WC.hf = false; GF = 1; CAM.roll = 0; for (const b of BOXES) b.on = false; CS.ground = false; CS.grav = 5; CS.drag = 0.5; CS.floorY = -90;
  TW.grp = new THREE.Group(); scene.add(TW.grp); TW.L = null; TW.cubeAt = null; document.body.classList.add('town'); TOWN.visits = (TOWN.visits | 0) + 1;
  const lv = twBuildAll(TW.O, TOWN, TOWN.seed); TW.lv = lv; TW.L = lv.layout; LV = lv; instantBuild(lv); G.act = 2; G.shards = 0; G.shardsTotal = 0; G.ck = TW.ret.ck; G.won = TW.ret.run ? G.won : false; G.t = 0; G.slow = 1; G.cine = 0; CAM.cine = 0;
  twIndexCubes(); twCollectGlow(); TW.on = true; TW.t = 0; twBuildPeople(); twGardenNodes();
  const sp = lv.layout.spawn, pos = wp(sp.x - 0.5, sp.z - 0.5); G.state = 'play'; resetHero({ x: pos.x, y: TW.O.y, z: pos.z }); P.yaw = Math.atan2(-pos.x, -pos.z); CAM.yaw = P.yaw; CAM.pitch = 0.3; TW.spawn = { x: pos.x, y: TW.O.y, z: pos.z, yaw: P.yaw };
  twAtmos(true); updateHUD(); rpgRecalc(); rpgHealFull(); G.flash = 0.5; rsfx('uiopen'); sparkBurst(P.x, P.y + 1, P.z, 24, 0xffe27a, 7); fxRing(P.x, P.y, P.z, 0.5, 8, 1.0, 0xffe27a, 1); rpgBanner('HOME TOWN', (TOWN_ROLES.hall.name + ' · ' + suiTierName(townTier(TOWN, 'hall')).toUpperCase())); questRefresh(TOWN, Date.now(), RP.level, RP.riftUnlocked, RP.bestRift);
  fdDiscover(true); requestLock(); RT.dirty = true; rpgSaveNow(); TW.built++; return true;
}
function townTeardown() {
  if (!TW.on) return; TW.on = false; document.body.classList.remove('town'); if (TW.grp) { TW.grp.traverse(o => { if (o.isMesh && o.material && o.material.dispose && !o.material.userData.shared) o.material.dispose(); }); scene.remove(TW.grp); } TW.grp = null; TW.npcs.length = 0; TW.walkers.length = 0; TW.pts.length = 0; TW.near = null; TW.win.length = 0; TW.lamps.length = 0; TW.cubeAt = null; TW.pending = null; fdClearNodes(); PROMPT = '';
}
function townLeave(dest, o) {
  if (!TW.on) return false; if (SUI.open) { SUI.from = 'play'; suiClose(); } const ret = TW.ret || {}; townTeardown(); rpgSaveNow();
  if (dest === 'rift') { rpgStartRift(o && o.tier ? o.tier : RP.riftTier, o && o.seed ? o.seed : null); return true; }
  if (dest === 'menu') { toMenu(); return true; }
  if (dest === 'campaign' && ret.run) { G.ck = ret.ck; retry(); return true; }
  startRun(); $('menu').classList.add('hidden'); $('dead').classList.add('hidden'); G.state = 'play'; G.started = true; requestLock(); updateHUD(); return true;
}
function townRespawn() { const s = TW.spawn; if (!s) return; resetHero({ x: s.x, y: s.y, z: s.z }); P.yaw = s.yaw; CAM.yaw = s.yaw; toast('Back at the plaza'); rsfx('deny'); }
{ const _pm = padMenu; padMenu = function () { if (SUI.open) { suiClose(); return; } _pm(); }; }
{ const _kh = killHero; killHero = function (reason) { if (TW.on) { townRespawn(); return; } _kh(reason); }; }
{ const _uh = updateHUD; updateHUD = function () { _uh(); if (TW.on) { $('actName').textContent = 'HOME TOWN'; $('shards').innerHTML = ''; $('shardDist').textContent = ''; } }; }
{ const _rc = clearEntities; clearEntities = function () { if (TW.on) { TW.on = false; document.body.classList.remove('town'); if (TW.grp) { scene.remove(TW.grp); TW.grp = null; } TW.npcs.length = 0; TW.walkers.length = 0; TW.pts.length = 0; TW.near = null; } _rc(); }; }
