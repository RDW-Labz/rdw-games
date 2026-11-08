// ---- loot: ingredient / material pickups ride the existing loot physics ---------------------------------------------------------------------------------------------------------------------------------
const FD_GEO = { sph: new THREE.SphereGeometry(0.2, 10, 8), cone: new THREE.ConeGeometry(0.17, 0.4, 8), box: new THREE.BoxGeometry(0.3, 0.3, 0.3), oct: new THREE.OctahedronGeometry(0.24, 0) }, FD_MATS = {};
const FD_SHAPE = { berry: 'sph', melon: 'sph', bulb: 'sph', egg: 'sph', roe: 'sph', pod: 'sph', drop: 'sph', honey: 'sph', corn: 'sph', bean: 'sph', root: 'cone', pepper: 'cone', leg: 'cone', chop: 'cone', haunch: 'cone', gland: 'cone', grain: 'box', salt: 'box', powder: 'box', scrap: 'box', timber: 'box', bone: 'box', ash: 'box' };
function fdLootMesh(id) { const d = fdDef(id), m = FD_MATS[id] || (FD_MATS[id] = new THREE.MeshStandardMaterial({ color: d.col, emissive: d.col, emissiveIntensity: 0.55, roughness: 0.4, metalness: 0.1 })); const mesh = new THREE.Mesh(FD_GEO[FD_SHAPE[d.glyph] || 'oct'], m); mesh.scale.setScalar(d.kind === 'mat' ? 1.15 : 1); mesh.castShadow = false; return mesh; }
{ const _sl = spawnLoot; spawnLoot = function (kind, x, y, z, payload) {
  if (kind !== 'ing' && kind !== 'mat') return _sl(kind, x, y, z, payload);
  const L = _sl('dust', x, y, z, 0); L.g.remove(L.gem); L.kind = kind; L.id = payload.id; L.n = payload.n | 0 || 1; L.gem = fdLootMesh(payload.id); L.g.add(L.gem); L.val = L.n; return L; }; }
function fdPickupFood(L, force) {
  const d = fdDef(L.id), put = fdGive(L.kind, L.id, L.n, true); rpgFree(L); RT.dirty = true; rsfx('pick0');
  floatText(L.x, L.y + 0.6, L.z, '+' + L.n + ' ' + d.name, 'xp'); sparkBurst(L.x, L.y, L.z, 4, new THREE.Color(d.col).getHex(), 3); rpgLogLine('+' + L.n + ' ' + d.name, d.col);
  if (put < L.n) { const g = Math.max(1, Math.round(d.sell * (L.n - put) * 0.5)); RP.gold += g; floatText(L.x, L.y + 1.0, L.z, 'full: +' + g + 'g', 'gold'); } if (fdSee(L.id)) fdDiscover(); return true;
}
{ const _pl = rpgPickupLoot; rpgPickupLoot = function (L, force) {
  if (L.kind === 'ing' || L.kind === 'mat') return fdPickupFood(L, force);
  const gold = L.kind === 'gold' ? Math.round(L.val) : 0, it = L.kind === 'item' ? L.item : null, ok = _pl(L, force);
  if (ok) { if (gold) townQuest('gold', { n: gold }); else if (it) townQuest('loot', { rarity: it.rarity }); } return ok; }; }
{ const _rd = rpgDrops; rpgDrops = function (srcKey, x, y, z, mlvl, extra) {
  _rd(srcKey, x, y, z, mlvl, extra);
  try { const e = FD.kill, r = rpgRng(rpgHashSeed(TOWN.seed ^ 0xF00D, (FD.n++) >>> 0)); for (const d of foodRollDrops(r, srcKey, e ? e.type : null, e && e.rpg ? e.rpg.tier : 'normal', RT.S ? RT.S.magicFind : 0)) spawnLoot(fdKindOf(d.id), x, y, z, { id: d.id, n: d.n }); } catch (err) { if (!FD.err) { FD.err = 1; console.error('food drops', err); } } }; }
{ const _ok = rpgOnKilled; rpgOnKilled = function (e, ak, sx, sz) {
  FD.kill = e; try { _ok(e, ak, sx, sz); } finally { FD.kill = null; }
  if (e.rpg && !e.rpg.minion) { townQuest('kill', { type: e.type, tier: e.rpg.tier }); if (e.rpg.actGuardian || e.rpg.guardian) townQuest('boss', {}); } }; }
// ---- salvage also yields materials ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
function fdSalvageGive(it) { const m = foodSalvageMats(it), parts = []; for (const id in m) { const put = fdGive('mat', id, m[id], true); if (put) parts.push(put + ' ' + MATS[id].name); } if (parts.length) rpgLogLine('Salvage: ' + parts.join(', '), '#9fb4c8'); }
{ const _is = invSalvage; invSalvage = function (i) { const it = RP.bag[i], ok = _is(i); if (ok && it) fdSalvageGive(it); return ok; };
  const _ib = invBulk; invBulk = function (maxR) { const before = RP.bag.slice(); _ib(maxR); for (let i = 0; i < BAG_N; i++) if (before[i] && !RP.bag[i]) fdSalvageGive(before[i]); }; }
