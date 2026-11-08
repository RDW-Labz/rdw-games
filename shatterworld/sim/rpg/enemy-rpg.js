// ---- per-enemy rpg block: level, hp, damage, tier, affixes, aura ------------------------------------------------------------------------------------------------
const AURA_GEO = new THREE.RingGeometry(0.72, 1, 40).rotateX(-PI / 2), ORB_GEO = new THREE.SphereGeometry(1, 8, 6), SHELL_GEO = new THREE.SphereGeometry(1, 16, 12), FROST_GEO = new THREE.RingGeometry(0.96, 1, 56).rotateX(-PI / 2);
const hexNum = c => parseInt(c.slice(1), 16);
function rpgDecorate(e, o = {}) {
  const diff = o.diff != null ? o.diff : rpgDiffIdx(), tier = o.tier || 'normal', mlvl = o.mlvl || rpgMonsterLevel({ act: G.act, diff, idx: o.idx || 0, rift: RIFT ? RIFT.tier : 0 });
  const st = rpgMonsterStats(e.type, mlvl, tier, diff), rng = rpgRng(o.seed != null ? o.seed : (dseed() ^ (o.idx || 0))), TR = RPG_TUNING.tiers[tier];
  const R = { lvl: mlvl, tier, hp: st.hp, maxhp: st.hp, dmg: st.dmg, aff: [], shield: 0, shieldMax: 0, shieldT: 0, spdMul: 1, size: TR.size, col: '#ffffff', name: RPG_TUNING.monster.name[e.type], showT: 0, minion: !!o.minion, xpMul: o.xpMul || 1, sumT: 3 + Math.random() * 3 };
  if (tier !== 'normal') { const n = o.aff ? o.aff.length : TR.aff[0] + ((rng() * (TR.aff[1] - TR.aff[0] + 1)) | 0); R.aff = o.aff || rpgPickMonsterAffixes(rng, n); }
  for (const id of R.aff) { const A = RPG_MAFFIX[id]; if (A.spd) R.spdMul *= A.spd; if (A.hp) { R.hp *= A.hp; R.maxhp *= A.hp; } if (A.size) R.size *= A.size; if (A.shield) { R.shieldMax = R.maxhp * A.shield; R.shield = R.shieldMax; } }
  if (e.type === 'spitter') R.spdMul = 0.0005; if (e.type === 'brute') R.spdMul *= 1.7; if (e.type === 'hopper') R.spdMul *= 1.1;
  if (RIFT && RIFT.mods.includes('haste')) R.spdMul *= 1.3;
  R.col = R.aff.length ? RPG_MAFFIX[R.aff[0]].col : '#ffffff'; R.name = tier === 'guardian' ? (R.aff.map(i => RPG_MAFFIX[i].adj).join(' ') + ' Guardian') : R.aff.length ? rpgEliteName(e.type, R.aff) : R.name;
  e.rpg = R; e.cd = {}; e.kbx = e.kbz = 0; e.ox = e.hx; e.oz = e.hz; e.or = e.r; e.aggro = false; e.hopCd = 1 + Math.random(); e.fireCd = 1.5 + Math.random() * 2; e.slamCd = 1.5;
  e.aggroR = o.aggroR != null ? o.aggroR : tier === 'normal' ? (e.type === 'walker' || e.type === 'shell' ? 0 : e.type === 'spitter' ? 14 : 10) : e.type === 'spitter' ? 16 : 11 + (tier === 'guardian' ? 6 : 0);
  if (R.size !== 1) { e.mesh.scale.multiplyScalar(R.size); e.h *= R.size; }
  if (tier !== 'normal') rpgAura(e);
  return e;
}
function rpgAura(e) {
  const R = e.rpg, c = R.aff.length ? hexNum(RPG_MAFFIX[R.aff[0]].col) : 0xffb15e, g = new THREE.Group(); e.aura = g; e.mesh.add(g); g.scale.setScalar(1 / (e.mesh.scale.x || 1));
  const ring = new THREE.Mesh(AURA_GEO, new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide, forceSinglePass: true })); ring.scale.setScalar(R.tier === 'guardian' ? 2.4 : 1.35); ring.position.y = 0.05; ring.renderOrder = 17; g.add(ring);
  g.userData.orbs = R.aff.map((id, i) => { const o = new THREE.Mesh(ORB_GEO, new THREE.MeshBasicMaterial({ color: hexNum(RPG_MAFFIX[id].col), fog: false })); o.scale.setScalar(0.1); g.add(o); return o; });
  if (R.aff.includes('shielded')) { const sh = new THREE.Mesh(SHELL_GEO, new THREE.MeshBasicMaterial({ color: 0x9fd0ff, transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })); sh.scale.set(0.95, 1.05, 0.95); sh.position.y = 0.55; g.add(sh); g.userData.shell = sh; }
  if (R.aff.includes('frozen')) { const fr = new THREE.Mesh(FROST_GEO, new THREE.MeshBasicMaterial({ color: 0x9cf3ff, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide, forceSinglePass: true })); fr.scale.setScalar(5.2); /* the aura group cancels the mesh scale, so this is metres */ fr.position.y = 0.08; fr.renderOrder = 16; g.add(fr); g.userData.frost = fr; }
  if (R.tier === 'guardian' || R.tier === 'elite') { const b = new THREE.Mesh(LOOT_GEO.beam, LOOT_BEAM[R.tier === 'guardian' ? 3 : 2]); b.scale.set(1.4, R.tier === 'guardian' ? 26 : 9, 1.4); b.position.y = 0.4; b.frustumCulled = false; g.add(b); g.userData.beam = b; g.userData.beamH = b.scale.y; }
}

