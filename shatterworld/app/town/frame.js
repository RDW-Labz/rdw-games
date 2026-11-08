// ---- per frame ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
function townFrame(rdt, sdt) {
  if (G.state === 'play' || G.state === 'sta') { for (const b of TOWN.garden) if (b) b.t += (G.state === 'play' ? sdt : 0); }
  if (!TW.on) return; TW.t += rdt; if (G.state === 'play' || G.state === 'sta') { TOWN.clock += rdt; if (TW.t - TW.lastBlink > 0.2) { TW.lastBlink = TW.t; twAtmos(false); } }
  const hx = P.x, hz = P.z; for (const n of TW.npcs) twAnimNpc(n, rdt, hx, hz); twWalkers(rdt, hx, hz); twVrLod(hx, hz); if (VR.presenting && G.state === 'play') { /* the diorama culls nothing here: the town is ~30 meshes */ }
  const O = TW.O, f = TW.fx; f.fount -= rdt; if (f.fount <= 0) { f.fount = 0.12; puff(O.x, O.y + 3.3, O.z, 1, 0.3, 0xbfeaff, 0.9, 3.4, 1.0); } f.smoke -= rdt; f.spark -= rdt;
  if (f.smoke <= 0) { f.smoke = 0.35; for (const c of TW.lv.chimneys) { if (c[4] === 'smoke' || c[4] === 'home') { if (c[4] === 'home' && Math.random() < 0.6) continue; puff(O.x + c[0] + 0.5, O.y + c[2], O.z + c[1] + 0.5, 1, 0.9, 0xdedee6, 0.4, 1.5, 2.2); } } }
  if (f.spark <= 0) { f.spark = 1.1; for (const c of TW.lv.chimneys) if (c[4] === 'spark') { sparkBurst(O.x + c[0] + 0.5, O.y + c[2] + 0.4, O.z + c[1] + 0.5, 3, 0xffa040, 3); } }
  f.portal -= rdt; if (f.portal <= 0) { f.portal = 0.08; const p = TW.pts.find(q => q.id === 'portal'); if (p) { const a = Math.random() * TAU, r = 1.6 + Math.random() * 1.2; puff(p.x + Math.cos(a) * r, O.y + 0.2, p.z + Math.sin(a) * r, 1, 0.35, 0x53e0d0, 0.2, 2.4, 1.6); } } f.ring -= rdt; if (f.ring <= 0) { f.ring = 2.6; const p = TW.pts.find(q => q.id === 'portal'); if (p) fxRing(p.x, O.y, p.z, 0.6, 3.4, 1.6, 0x53e0d0, 0.8); }
  if (TW.near && !TW.near.n && TW.near.id !== 'walker' && TW.near.id) { /* (rings under the targeted station are drawn by the prompt only) */ }
}
{ const _f = rpgFrame; rpgFrame = function (rdt, sdt) { _f(rdt, sdt); try { townFrame(rdt, sdt); } catch (err) { if (!TW.err) { TW.err = 1; console.error('town frame', err); } } }; }
// the garden node reads the bed's growth every frame: patch the food-game node loop through a small adapter
{ const _g = fdGather; fdGather = function (q) { if (q.bed != null) { const b = TOWN.garden[q.bed]; if (!b || b.t < suiGrowTime(b.plant)) return false; const put = suiHarvest(q.bed); rsfx('pick1'); sparkBurst(q.x, q.y + 0.6, q.z, 10, new THREE.Color(INGS[b.plant].col).getHex(), 4); floatText(q.x, q.y + 1.2, q.z, '+' + b.n + ' ' + INGS[b.plant].name, 'xp'); fdSee(b.plant); return !!put; } return _g(q); }; }
