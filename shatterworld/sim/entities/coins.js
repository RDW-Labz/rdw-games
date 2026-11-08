// ---- coins ----------------------------------------------------------------------------------------------------------------
const COINS = []; const coinMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.3, 0.3, 0.07, 18).rotateZ(PI / 2), new THREE.MeshStandardMaterial({ color: 0xffc830, metalness: 0.85, roughness: 0.28, emissive: 0xffa000, emissiveIntensity: 0.55 }), 220);
coinMesh.frustumCulled = false; coinMesh.count = 0; coinMesh.castShadow = true; scene.add(coinMesh);
function addCoin(x, y, z) { COINS.push({ x, y, z, alive: true, ph: Math.random() * 6, vy: 0, pop: false }); }
const _cd = new THREE.Object3D();
function updateCoins(dt, t) {
  coinMesh.count = COINS.length; let nearest = -1;
  for (let i = 0; i < COINS.length; i++) {
    const c = COINS[i]; if (!c.alive) { _cd.scale.set(0, 0, 0); _cd.updateMatrix(); coinMesh.setMatrixAt(i, _cd.matrix); continue; }
    if (c.pop) { c.vy -= 30 * dt; c.y += c.vy * dt; c.life -= dt; if (c.life < 0) { c.alive = false; continue; } }
    _cd.position.set(c.x, c.y + (c.pop ? 0 : Math.sin(t * 2.4 + c.ph) * 0.1), c.z); _cd.rotation.set(0, t * 3.2 + c.ph, 0); _cd.scale.setScalar(c.pop ? 1.1 : 1); _cd.updateMatrix(); coinMesh.setMatrixAt(i, _cd.matrix);
    if (!c.pop && G.state === 'play') { const dx = c.x - P.x, dz = c.z - P.z, dy = c.y - (P.y + 0.9 * P.size * (GF > 0 ? 1 : -1)); if (dx * dx + dz * dz < 1.0 && dy * dy < 1.5) collectCoin(c); }
  }
  coinMesh.instanceMatrix.needsUpdate = true;
}
function collectCoin(c) { c.alive = false; G.coins++; G.runCoins++; sfx('coin', Math.min(8, G.coinCombo++)); G.coinComboT = 0.8; sparkBurst(c.x, c.y, c.z, 6, 0xffd040, 3); if (G.coins % TUNING.coinHeal === 0) { P.hp = TUNING.hp; toast('100 coins! Health restored'); sfx('powerup'); } updateHUD(); }

