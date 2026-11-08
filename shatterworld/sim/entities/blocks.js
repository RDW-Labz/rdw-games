// ---- ? blocks, power-up mushrooms ----------------------------------------------------------------------------------------------
const BLOCKS = []; const blockGeo = new THREE.BoxGeometry(0.98, 0.98, 0.98);
function makeQTex(used) {
  const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d'); const base = used ? '#7a5a3a' : '#f6b82a'; g.fillStyle = base; g.fillRect(0, 0, 128, 128);
  g.strokeStyle = used ? '#4a3220' : '#b86a0a'; g.lineWidth = 8; g.strokeRect(6, 6, 116, 116); g.fillStyle = used ? '#4a3220' : '#8a4a06'; for (const [x, y] of [[16, 16], [112, 16], [16, 112], [112, 112]]) { g.beginPath(); g.arc(x, y, 5, 0, TAU); g.fill(); }
  if (!used) { g.fillStyle = '#fff4c0'; g.font = 'bold 84px "Trebuchet MS", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.strokeStyle = '#a05a00'; g.lineWidth = 8; g.strokeText('?', 64, 70); g.fillText('?', 64, 70); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}
const qMat = new THREE.MeshStandardMaterial({ map: makeQTex(false), roughness: 0.4, emissive: 0xffa020, emissiveIntensity: 0.35, emissiveMap: null }), usedMat = new THREE.MeshStandardMaterial({ map: makeQTex(true), roughness: 0.8 });
function addBlock(x, y, z, item) {
  const m = new THREE.Mesh(blockGeo, qMat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; scene.add(m);
  const b = { x, y, z, item, used: false, mesh: m, bump: 0, box: null }; b.box = addBoxCol(x - 0.5, y - 0.5, z - 0.5, x + 0.5, y + 0.5, z + 0.5, 'block', b); BLOCKS.push(b); return b;
}
function onHeadBump(box) { if (box.tag === 'block' && box.ref && !box.ref.used) bumpBlock(box.ref); else if (box.tag === 'block') { box.ref.bump = 0.2; sfx('bump'); } }
function onHeadBumpCell() { }
function bumpBlock(b) {
  b.used = true; b.bump = 0.25; b.mesh.material = usedMat; sfx('bump'); sparkBurst(b.x, b.y + 0.6, b.z, 8, 0xffe080, 3);
  if (b.item === 'mushroom') spawnPowerup(b.x, b.y + 1.0, b.z); else { const c = { x: b.x, y: b.y + 0.9, z: b.z, alive: true, ph: 0, vy: 11, pop: true, life: 0.62 }; COINS.push(c); G.coins++; G.runCoins++; sfx('coin', 2); updateHUD(); setTimeout(() => sparkBurst(c.x, c.y + 1, c.z, 6, 0xffd040, 3), 450); }
}
function updateBlocks(dt) { for (const b of BLOCKS) { if (b.bump > 0) { b.bump -= dt; const k = Math.sin(clamp(b.bump / 0.25, 0, 1) * PI); b.mesh.position.y = b.y + k * 0.28; } else b.mesh.position.y = b.y; if (!b.used) { qMat.emissiveIntensity = 0.3 + 0.15 * Math.sin(U.time.value * 3); } } }
const mushTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d'); g.fillStyle = '#d8302a'; g.fillRect(0, 0, 128, 128); g.fillStyle = '#fff'; for (const [x, y, r] of [[30, 34, 16], [90, 30, 14], [60, 78, 18], [14, 100, 12], [110, 96, 15], [64, 14, 10]]) { g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill(); } const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; })();
const POWERUPS = [];
function spawnPowerup(x, y, z) {
  const g = new THREE.Group(); const cap = new THREE.Mesh(HEMI, new THREE.MeshStandardMaterial({ map: mushTex, roughness: 0.5, emissive: 0x401010, emissiveIntensity: 0.5 })); cap.scale.set(0.42, 0.36, 0.42); cap.position.y = 0.22; g.add(cap);
  const stem = new THREE.Mesh(CYL, hv(0xfff0d0)); stem.scale.set(0.2, 0.24, 0.2); stem.position.y = 0.08; g.add(stem); for (const s of [-1, 1]) { const e = new THREE.Mesh(SPH, hv(0x201010)); e.scale.set(0.035, 0.06, 0.03); e.position.set(s * 0.07, 0.1, 0.19); g.add(e); }
  g.position.set(x, y, z); g.scale.setScalar(0.01); g.traverse(o => { if (o.isMesh) o.castShadow = true; }); scene.add(g);
  POWERUPS.push({ x, y, z, vx: 2.2 * (Math.random() < 0.5 ? 1 : -1), vz: 0, vy: 0, mesh: g, t: 0, alive: true }); sfx('powerup_spawn');
}
function updatePowerups(dt) {
  for (const p of POWERUPS) {
    if (!p.alive) continue; p.t += dt; p.mesh.scale.setScalar(Math.min(1, p.t * 3)); if (p.t < 0.35) { p.y += dt * 2.2; p.mesh.position.set(p.x, p.y, p.z); continue; }
    p.vy -= 30 * dt; p.x += p.vx * dt; p.z += p.vz * dt; p.y += p.vy * dt; const f = floorAt(p.x, p.z, p.y + 0.4); if (f > -1e8 && p.y < f) { p.y = f; p.vy = 0; } const ahead = floorAt(p.x + Math.sign(p.vx) * 0.4, p.z, p.y + 0.5); if (ahead > p.y + 0.5) p.vx = -p.vx; if (p.y < -60) p.alive = false;
    p.mesh.position.set(p.x, p.y, p.z); p.mesh.rotation.y += dt * 2;
    const dx = p.x - P.x, dz = p.z - P.z, dy = p.y - P.y; if (G.state === 'play' && dx * dx + dz * dz < 0.9 && dy > -0.5 && dy < 1.8) { p.alive = false; scene.remove(p.mesh); P.big = true; P.hp = Math.max(P.hp, TUNING.hp); sfx('powerup'); toast('Super growth!'); sparkBurst(P.x, P.y + 1, P.z, 18, 0xff5050, 6); heroKick(hero, 12); updateHUD(); }
  }
}

