// ==============================================================================================================================================================================================
// CHARACTER SELECT (flat): grid of portraits with LIVE 3D turntables (the previews are drawn straight onto the canvas behind transparent windows with scissor rects), stat bars, passive / signature /
// Star text, lock icons. Keyboard, pad, phone pad and mouse. In VR the same data drives a world-space panel with 3D figurines.
// ==============================================================================================================================================================================================
const CSU = { open: false, i: 0, from: 'menu', hid: [], built: false, t: 0, animKind: 0, animT: 0 };
const PV = { scene: null, cam: null, rigs: {}, built: false, ped: null, anim: ['IDLE', 'RUN', 'JUMP', 'ATTACK', 'VICTORY'] };
function pvBuild() {
  if (PV.built) return; PV.built = true; PV.scene = new THREE.Scene(); PV.cam = new THREE.PerspectiveCamera(30, 0.8, 0.1, 60); PV.cam.position.set(0, 1.25, 5.6); PV.cam.lookAt(0, 0.98, 0);
  PV.scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x6a5a40, 1.05)); const key = new THREE.DirectionalLight(0xffe4b8, 2.2); key.position.set(3, 5, 4); PV.scene.add(key); const rim = new THREE.DirectionalLight(0x88aaff, 1.0); rim.position.set(-4, 2, -3); PV.scene.add(rim);
  const ped = new THREE.Group(), disc = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.1, 0.14, 40), new THREE.MeshStandardMaterial({ color: 0x1d2c3d, roughness: 0.5, metalness: 0.5 })); disc.position.y = -0.07; ped.add(disc);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.86, 0.98, 48).rotateX(-PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.3, 0.6), toneMapped: false })); ring.position.y = 0.005; ped.add(ring); PV.ring = ring; PV.scene.add(ped); PV.ped = ped;
  for (const id of CLASS_ORDER) pvAddRig(id);
}
function pvAddRig(id) { if (PV.rigs[id]) return; const r = buildClassRig(id); r.root.scale.setScalar(1); r.root.updateMatrixWorld(true); const bb = new THREE.Box3().setFromObject(r.root), h = Math.max(0.5, bb.max.y - bb.min.y), k = 1.95 / h; r.root.scale.setScalar(r.S * k); r.root.position.y = 0; r.root.visible = false; PV.rigs[id] = r; PV.scene.add(r.root); }
const _pvPose = { lx: 0, rx: 0, la: 0, ra: 0, lean: 0, side: 0, pitch: 0, hx: 0, hy: 0, bob: 0, roll: 0 };
function pvPose(r, kind, t, dt, A) { // idle / run / jump / attack / victory with the same formulas as the hero animation, per-class tweaks from class.anim
  const p = _pvPose; for (const k in p) p[k] = 0; let k = 14;
  if (kind === 0) { const br = Math.sin(t * 2.1); p.bob = br * 0.01; p.la = br * 0.05; p.ra = -br * 0.05; if (A.idle === 'sway') { p.side = Math.sin(t * 1.5) * 0.35; p.hy = Math.sin(t * 0.9) * 0.3; } else if (A.idle === 'staff') { p.ra = -0.55; p.hy = Math.sin(t * 0.7) * 0.35; } else if (A.idle === 'flex') { const f = Math.max(0, Math.sin(t * 0.9)); p.la = p.ra = -1.1 * f; p.side = 0.9 * f; } else if (A.idle === 'bounce') { p.bob = Math.abs(Math.sin(t * 6)) * 0.06; p.lx = Math.sin(t * 6) * 0.25; p.rx = -p.lx; p.la = -p.lx * 0.8; p.ra = -p.rx * 0.8; } }
  else if (kind === 1) { r.ph += 10 * dt * 0.95 * A.run; const s = Math.sin(r.ph), c = Math.cos(r.ph), sw = A.swing; p.lx = s * 0.95 * sw; p.rx = -s * 0.95 * sw; p.la = -s * sw; p.ra = s * sw; p.lean = 0.35; p.bob = Math.abs(c) * 0.07; p.hx = -0.1; }
  else if (kind === 2) { const u = (t % 1.4) / 1.4, up = u < 0.5; if (A.jump === 'glide' && !up) { p.side = 1.9; p.la = p.ra = -0.5; p.lean = 0.25; } else if (A.jump === 'float' && !up) { p.lx = 0.45; p.rx = -0.2; p.la = -2.2; p.ra = -2.0; p.side = 0.8; } else if (A.jump === 'tuck') { p.lx = -1.5; p.rx = -1.3; p.la = p.ra = -0.4; p.lean = 0.45; } else if (up) { p.la = p.ra = -2.7; p.lx = -0.9; p.rx = 0.5; p.side = 0.3; } else { p.la = p.ra = -0.7; p.lx = 0.35; p.rx = -0.25; p.side = 1; } p.bob = Math.sin(u * PI) * 0.6; }
  else if (kind === 3) { const f = (t % 1.2) / 1.2, pk = Math.sin(Math.min(1, f * 2.2) * PI); p.lean = 0.2 + 0.2 * pk; p.ra = -2.6 * pk; p.la = 0.5; p.hx = -0.1; k = 28; }
  else { p.la = -3.0 + Math.sin(t * 9) * 0.3; p.ra = -3.0 - Math.sin(t * 9) * 0.3; p.bob = Math.abs(Math.sin(t * 5)) * 0.35; p.hx = -0.25; if (A.win === 'spin') r.pose.spin = (t * 6) % TAU; else r.pose.spin *= 0.8; }
  if (kind !== 4 && r.pose.spin) r.pose.spin = 0; poseTo(r, p, dt, k); applyPose(r, dt);
}
function pvDraw(id, rect, t, dt, i, sel) { // one card: select the rig, turntable + animation, camera aspect, scissor render
  const r = PV.rigs[id]; if (!r) return; for (const k in PV.rigs) PV.rigs[k].root.visible = k === id; const d = classDef(id), A = d.anim, kind = sel ? CSU.animKind : 0, fit = rect.width / Math.max(1, rect.height);
  r.root.rotation.y = t * (sel ? 0.9 : 0.5) + i * 1.3; pvPose(r, kind, t, dt, A); rigTick(r, t, kind === 1 ? 10 : 0, kind === 2 && A.jump === 'glide');
  const locked = !classUnlocked(d, RP.unlocked); r.root.traverse(o => { if (o.isMesh && o.material && o.material.emissive && o.material !== outlineMat) { /* locked silhouettes are dimmed in the DOM overlay */ } });
  const c = STAR_TINT[d.star.col] || STAR_TINT.gold; PV.scene.background = _hc.setRGB(c[0] * 0.014 + 0.008, c[1] * 0.014 + 0.012, c[2] * 0.02 + 0.03); PV.ring.material.color.setRGB(c[0] * 0.6, c[1] * 0.6, c[2] * 0.6); PV.cam.aspect = fit; PV.cam.fov = fit < 0.8 ? 34 : 30; PV.cam.updateProjectionMatrix();
  const x = rect.left, y = H - rect.bottom, w = rect.width, h = rect.height; renderer.setViewport(x, y, w, h); renderer.setScissor(x, y, w, h); renderer.render(PV.scene, PV.cam);
}
const _cc = new THREE.Color();
function clsRender() { // replaces the normal frame render while the select screen is open (flat only)
  const t = performance.now() / 1000, dt = Math.min(0.05, t - (CSU.last || t)); CSU.last = t; CSU.t = t; CSU.animT += dt; if (CSU.animT > (CSU.animKind === 2 ? 1.5 : CSU.animKind === 3 ? 1.3 : 3.4)) { CSU.animT = 0; CSU.animKind = (CSU.animKind + 1) % 5; $('chAnim') && ($('chAnim').textContent = PV.anim[CSU.animKind]); }
  renderer.getClearColor(_cc); const ca = renderer.getClearAlpha(); renderer.setClearColor(0x0a1420, 1); renderer.setScissorTest(true); renderer.setViewport(0, 0, W, H); renderer.setScissor(0, 0, W, H); renderer.clear();
  const cells = document.querySelectorAll('#chGrid .cPort'); cells.forEach((el, i) => { const rc = el.getBoundingClientRect(); if (rc.width < 4 || rc.bottom < 0 || rc.top > H) return; pvDraw(CLASS_ORDER[i], rc, t, dt, i, i === CSU.i); });
  renderer.setScissorTest(false); renderer.setViewport(0, 0, W, H); renderer.setClearColor(_cc, ca);
}
function clsDetailHTML(id) {
  const d = classDef(id), b = classBars(d), un = classUnlocked(d, RP.unlocked), sig = GEM_BY_ID[d.sig], st = d.star, slot = id === RP.cls ? { level: RP.level, xp: RP.xp } : RP.slots[id], bars = [['HEALTH', b.hp], ['SPEED', b.speed], ['JUMP', b.jump], ['WEIGHT', b.weight], ['POWER', b.power]];
  const w = d.weights, aff = d.aff ? GEM_ELEMS[d.aff.elem] : null; const gems = ((d.start && d.start.core && d.start.core.gems) || []).filter(Boolean);
  return `<div class="cdName">${esc(d.name.toUpperCase())}<small>${esc(d.role)}${un ? '' : ' &middot; LOCKED'}</small></div><div class="cdBlurb">${esc(d.blurb)}</div>
  <div class="cdBars">${bars.map(([n, v]) => `<div class="cdBar"><span>${n}</span><i style="--v:${v * 10}%"></i><b>${v}</b></div>`).join('')}</div>
  <div class="cdSec"><h4>PASSIVE &middot; ${esc(d.passive.name)}</h4><p>${esc(d.passive.text)}</p></div>
  <div class="cdSec"><h4>SIGNATURE SKILL &middot; <span style="color:${GEM_ELEMS[sig.elem].css}">${esc(sig.name)}</span></h4><p>${esc(sig.text)}</p></div>
  <div class="cdSec"><h4>STAR POWER &middot; ${esc(st.name)}</h4><p>${esc(st.text)}</p></div>
  <div class="cdSec"><h4>CLASS</h4><p>Per level: Power x${w.power}, Agility x${w.agility}, Resolve x${w.resolve}.${aff ? ` Gem affinity: <span style="color:${aff.css}">${aff.name}</span> gems +${d.aff.lv} level, +${Math.round(d.aff.dmg * 100)}% damage.` : ''} Drops lean toward this class. Starts with ${gems.map(g => GEM_BY_ID[g].name).join(', ')}.</p></div>
  <div class="cdSec"><h4>PROGRESS</h4><p>${slot ? 'Level ' + slot.level + (id === RP.cls ? ' (playing)' : '') : un ? 'Not played yet (level 1)' : esc(d.unlock.text)}</p></div>`;
}
function clsRenderUI() {
  if (!CSU.open) return; const grid = $('chGrid');
  grid.innerHTML = CLASS_ORDER.map((id, i) => { const d = classDef(id), un = classUnlocked(d, RP.unlocked), sl = id === RP.cls ? { level: RP.level } : RP.slots[id]; return `<div class="chCard${i === CSU.i ? ' focus' : ''}${un ? '' : ' lock'}${id === RP.cls ? ' cur' : ''}" data-i="${i}"><div class="cPort"></div><div class="cName">${esc(d.name.toUpperCase())}</div><div class="cRole">${esc(d.role)}</div>${un ? (sl ? `<div class="cLv">LV ${sl.level}</div>` : '') : `<div class="cLock"><b>&#128274;</b><small>${esc(d.unlock.text)}</small></div>`}${id === RP.cls ? '<div class="cCur">PLAYING</div>' : ''}</div>`; }).join('');
  $('chDetail').innerHTML = clsDetailHTML(CLASS_ORDER[CSU.i]); const d = classDef(CLASS_ORDER[CSU.i]), un = classUnlocked(d, RP.unlocked); const bt = $('chGo'); bt.textContent = id2label(); bt.disabled = !un; bt.className = 'btn go';
  function id2label() { return CLASS_ORDER[CSU.i] === RP.cls ? 'KEEP ' + d.name.toUpperCase() : un ? 'SWITCH TO ' + d.name.toUpperCase() : 'LOCKED'; }
}
function openChars(from) {
  if (CSU.open || RUI.open || PK.open) return false; const st = G.state; if (!(st === 'menu' || st === 'pause' || st === 'dead')) return false; if (RIFT && st !== 'menu') { toast('Leave the rift to change character'); return false; }
  CSU.from = st; CSU.open = true; G.state = 'cls'; CSU.i = Math.max(0, CLASS_ORDER.indexOf(RP.cls)); CSU.hid = []; keys.clear(); mouseFire = mousePlace = padFireDown = padPlaceDown = false; for (const id of ['menu', 'dead', 'pause']) { const el = $(id); if (el && !el.classList.contains('hidden')) { el.classList.add('hidden'); CSU.hid.push(id); } }
  document.exitPointerLock && document.exitPointerLock(); if (!VR.presenting) { pvBuild(); $('chars').classList.remove('hidden'); clsRenderUI(); } else { vrClsOpen(); } gsfx('gcls'); return true;
}
function closeChars() {
  if (!CSU.open) return; CSU.open = false; $('chars').classList.add('hidden'); for (const id of CSU.hid) $(id).classList.remove('hidden'); CSU.hid = []; G.state = CSU.from; if (VR.presenting) vrClsClose(); gsfx('gcls'); if (CSU.from === 'menu') { rpgRenderMenu(); updateBestLine(); }
}
function clsConfirm() {
  const id = CLASS_ORDER[CSU.i], d = classDef(id); if (!classUnlocked(d, RP.unlocked)) { toast('Locked: ' + d.unlock.text); gsfx('gdeny'); return false; }
  if (id !== RP.cls) { clsSwitch(id); } closeChars(); return true;
}
function clsMove(dx, dy) { const n = CLASS_ORDER.length, cols = 3; let i = CSU.i, c = i % cols, r = (i / cols) | 0; if (dx) c = Math.max(0, Math.min(cols - 1, c + dx)); if (dy) r = Math.max(0, Math.min(Math.ceil(n / cols) - 1, r + dy)); const j = Math.min(n - 1, r * cols + c); if (j !== i) { CSU.i = j; gsfx('gcls'); CSU.animKind = 0; CSU.animT = 0; if (!VR.presenting) clsRenderUI(); else vrClsDirty(); } }
function clsKey(k) {
  if (k === 'arrowleft' || k === 'a') clsMove(-1, 0); else if (k === 'arrowright' || k === 'd') clsMove(1, 0); else if (k === 'arrowup' || k === 'w') clsMove(0, -1); else if (k === 'arrowdown' || k === 's') clsMove(0, 1);
  else if (k === ' ' || k === 'enter') clsConfirm(); else if (k === 'z' || k === 'escape' || k === 'c') closeChars(); else if (k >= '1' && k <= '9' && +k <= CLASS_ORDER.length) { CSU.i = +k - 1; clsRenderUI(); gsfx('gcls'); }
}
$('chars') && $('chars').addEventListener('click', e => { if (!CSU.open) return; const card = e.target.closest('.chCard'); if (card) { const i = +card.dataset.i; if (i === CSU.i && e.detail >= 2) { clsConfirm(); return; } CSU.i = i; gsfx('gcls'); clsRenderUI(); return; } if (e.target.id === 'chGo') clsConfirm(); else if (e.target.id === 'chBack') closeChars(); });

