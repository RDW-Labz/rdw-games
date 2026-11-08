// ---- gatherable herbs / ore: 3 InstancedMeshes (herb fruit, herb leaves, ore) ----------------------------------------------------------------------------------------------------------------------
const FN = { built: false, herb: null, leaf: null, ore: null, cap: 48, dummy: new THREE.Object3D(), col: new THREE.Color() };
function fdBuildNodes() {
  if (FN.built) return; FN.built = true; const m4 = new THREE.Matrix4(), mk = (g, x, y, z, sx, sy, sz, ry) => { const c = g.clone(); m4.compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry || 0, 0)), new THREE.Vector3(sx, sy, sz)); c.applyMatrix4(m4); return c; };
  const sp = new THREE.SphereGeometry(1, 10, 8), ocm = new THREE.OctahedronGeometry(1, 0);
  const fruit = mergeGeometries([mk(sp, 0, 0.46, 0, 0.17, 0.17, 0.17), mk(sp, 0.13, 0.36, 0.05, 0.12, 0.12, 0.12), mk(sp, -0.11, 0.33, -0.07, 0.1, 0.1, 0.1)], false);
  const leaf = mergeGeometries([0, 1, 2, 3].map(i => mk(sp, Math.cos(i * 1.57) * 0.17, 0.12, Math.sin(i * 1.57) * 0.17, 0.2, 0.05, 0.1, -i * 1.57)).concat([mk(new THREE.CylinderGeometry(1, 1, 1, 6), 0, 0.22, 0, 0.025, 0.44, 0.025)]), false);
  const ore = mergeGeometries([mk(ocm, 0, 0.3, 0, 0.22, 0.34, 0.22), mk(ocm, 0.2, 0.15, 0.08, 0.13, 0.2, 0.13), mk(ocm, -0.17, 0.12, -0.1, 0.12, 0.17, 0.12)], false);
  const mat = () => new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x181818 });
  FN.herb = new THREE.InstancedMesh(fruit, mat(), FN.cap); FN.leaf = new THREE.InstancedMesh(leaf, new THREE.MeshLambertMaterial({ color: 0x4ec46a, emissive: 0x0a2010 }), FN.cap); FN.ore = new THREE.InstancedMesh(ore, new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x2a3a5a, emissiveIntensity: 0.9, roughness: 0.3, metalness: 0.4 }), FN.cap);
  for (const x of [FN.herb, FN.leaf, FN.ore]) { x.frustumCulled = false; x.count = 0; x.visible = false; scene.add(x); } FN.herb.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(FN.cap * 3), 3); FN.ore.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(FN.cap * 3), 3);
}
function fdClearNodes() { FD.nodes.length = 0; if (FN.built) { FN.herb.count = FN.leaf.count = FN.ore.count = 0; FN.herb.visible = FN.leaf.visible = FN.ore.visible = false; } }
function fdAddNode(kind, x, y, z, id, n) { if (FD.nodes.length >= FN.cap * 2) return null; fdBuildNodes(); const q = { kind, x, y, z, id, n, on: true, ph: Math.random() * 6, t: 0, near: 0 }; FD.nodes.push(q); return q; }
function fdNodesFrame(rdt) {
  if (!FN.built || !FD.nodes.length) return; const t = U.time.value, d = FN.dummy; let nh = 0, no = 0; FD.spk -= rdt; const spark = FD.spk <= 0; if (spark) FD.spk = 0.4;
  for (const q of FD.nodes) {
    let prog = 1, bedB = null; if (q.bed != null) { bedB = TOWN.garden[q.bed]; if (!bedB) continue; q.id = bedB.plant; prog = Math.min(1, bedB.t / suiGrowTime(bedB.plant)); } else if (!q.on) { if (q.t > 0) { q.t -= rdt; if (q.t <= 0) q.on = true; } continue; }
    const ripe = prog >= 1, dx = P.x - q.x, dz = P.z - q.z, dh = hyp2(dx, dz), near = dh < 3.2 && Math.abs(P.y - q.y) < 2.5; q.near += ((near ? 1 : 0) - q.near) * Math.min(1, rdt * 10);
    if (ripe && dh < 1.15 && Math.abs(P.y + 0.6 - q.y) < 2.2 && !P.dead && (q.bed == null || G.state === 'play')) { fdGather(q); continue; }
    const k = (1 + 0.07 * Math.sin(t * 2.2 + q.ph) + 0.25 * q.near) * (0.35 + 0.65 * prog); d.position.set(q.x, q.y, q.z); d.rotation.set(0, q.ph + t * 0.25, Math.sin(t * 1.5 + q.ph) * 0.05); d.scale.setScalar(k); d.updateMatrix();
    if (q.kind === 'herb') { FN.leaf.setMatrixAt(nh, d.matrix); if (ripe) FN.herb.setMatrixAt(nh, d.matrix); else { d.scale.setScalar(0.0001); d.updateMatrix(); FN.herb.setMatrixAt(nh, d.matrix); } FN.col.set(fdDef(q.id).col); FN.herb.setColorAt(nh, FN.col); nh++; } else { FN.ore.setMatrixAt(no, d.matrix); FN.col.set('#9fd0ff'); FN.ore.setColorAt(no, FN.col); no++; }
    if (spark && dh < 15 && Math.random() < 0.5) puff(q.x + (Math.random() - 0.5) * 0.4, q.y + 0.55, q.z + (Math.random() - 0.5) * 0.4, 1, 0.5, new THREE.Color(q.kind === 'ore' ? '#9fd0ff' : fdDef(q.id).col).getHex(), 0.4, 0.9, 1.0);
  }
  FN.herb.count = FN.leaf.count = nh; FN.ore.count = no; FN.herb.visible = FN.leaf.visible = nh > 0; FN.ore.visible = no > 0; if (nh) { FN.herb.instanceMatrix.needsUpdate = FN.leaf.instanceMatrix.needsUpdate = true; FN.herb.instanceColor.needsUpdate = true; } if (no) { FN.ore.instanceMatrix.needsUpdate = true; FN.ore.instanceColor.needsUpdate = true; }
}
function fdGather(q) {
  if (!q.on) return false; q.on = false; q.t = q.regrow || 0; const kind = fdKindOf(q.id), d = fdDef(q.id), put = fdGive(kind, q.id, q.n, true); RT.dirty = true; rsfx('pick1'); const col = new THREE.Color(q.kind === 'ore' ? '#9fd0ff' : d.col).getHex();
  floatText(q.x, q.y + 1.1, q.z, '+' + q.n + ' ' + d.name, 'xp'); sparkBurst(q.x, q.y + 0.5, q.z, 10, col, 4); fxRing(q.x, q.y, q.z, 0.2, 1.3, 0.4, col, 0.8); puff(q.x, q.y + 0.4, q.z, 5, 0.8, col, 1.6, 0.6, 0.7); rpgLogLine('Gathered ' + q.n + ' ' + d.name, d.col);
  if (put < q.n) { const g = Math.max(1, Math.round(d.sell * (q.n - put) * 0.5)); RP.gold += g; } if (fdSee(q.id)) fdDiscover(); townQuest('gather', { n: q.n }); TOWN.stats.gathered += q.n; if (G.state === 'play' && VR.presenting) vrHaptic(2, 0.25, 40); return true;
}
function fdSpawnNodes(rng, anchors, nHerb, nOre, act) {
  const used = ENEMIES.filter(e => e.alive).map(e => [e.x, e.y, e.z]); for (const q of FD.nodes) used.push([q.x, q.y, q.z]);
  for (let i = 0; i < nHerb + nOre; i++) { const s = rpgSpot(rng, anchors, used, { space: 5, minHero: 5 }); if (!s) continue; used.push(s); const kind = i < nHerb ? 'herb' : 'ore', g = gatherRoll(rng, kind, act); fdAddNode(kind, s[0], s[1], s[2], g.id, g.n); }
}
{ const _sa = rpgSpawnAct; rpgSpawnAct = function () {
  _sa(); try { fdClearNodes(); const act = G.act, rng = rpgRng(rpgHashSeed(RP.seed ^ 0x6A7E, act * 811 + 5)), anchors = []; for (const c of COINS) if (c.alive && !c.pop) anchors.push([c.x, c.y - 1, c.z]); rpgScatter(rng, anchors, act === 1 ? 140 : 200); if (!anchors.length) return; fdSpawnNodes(rng, anchors, act === 1 ? 16 : 11, act === 1 ? 5 : 5, act); } catch (err) { console.error('food nodes', err); } }; }
{ const _sr = rpgStartRift; rpgStartRift = function (tier, seed) { _sr(tier, seed); try { fdClearNodes(); if (!RIFT || !LV) return; const rng = rpgRng(rpgHashSeed(RIFT.seed ^ 0x6A7E, 3)), anchors = []; rpgScatter(rng, anchors, 120); fdSpawnNodes(rng, anchors, 5, 3, 3); } catch (err) { console.error('rift nodes', err); } }; }
{ const _ce = clearEntities; clearEntities = function () { fdClearNodes(); _ce(); }; }
