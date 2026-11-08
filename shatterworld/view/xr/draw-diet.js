// ---- draw-call diet: every joint's meshes (+ their toon outlines) become ONE vertex-coloured mesh while presenting (hero, twin, enemies) ------
function vrBake(list, withColor) {
  const geos = [];
  for (let i = 0; i < list.length; i++) {
    const it = list[i], g = it.geo.clone(); g.applyMatrix4(it.mat);
    if (withColor) { const n = g.attributes.position.count, c = new Float32Array(n * 3), col = it.col; for (let k = 0; k < n; k++) { c[k * 3] = col.r; c[k * 3 + 1] = col.g; c[k * 3 + 2] = col.b; } g.setAttribute('color', new THREE.BufferAttribute(c, 3)); }
    geos.push(g);
  }
  const m = mergeGeometries(geos, false); for (const g of geos) g.dispose(); return m;
}
let vrLitMat = null;
function vrBuildMerged(g) {
  const ud = g.userData, ps = ud.vrp; if (!ps || !ps.length || ud.vrM) return;
  if (!vrLitMat) vrLitMat = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x100e0c });
  const l1 = []; for (const m of ps) { m.updateMatrix(); l1.push({ geo: m.geometry, mat: m.matrix, col: m.material.color }); }
  const mesh = new THREE.Mesh(vrBake(l1, true), vrLitMat); mesh.castShadow = true; mesh.frustumCulled = false; mesh.visible = false; g.add(mesh); ud.vrM = mesh;
  if (ud.vro && ud.vro.length) { const l2 = []; for (const o of ud.vro) { o.updateMatrix(); l2.push({ geo: o.geometry, mat: o.matrix }); } const om = new THREE.Mesh(vrBake(l2, false), outlineMat); om.renderOrder = -1; om.frustumCulled = false; om.visible = false; g.add(om); ud.vrO = om; }
}
function vrMergeApply(root, on) {
  root.traverse(o => { const ud = o.userData; if (!ud || !ud.vrp) return; if (on) vrBuildMerged(o); for (const m of ud.vrp) m.visible = !on; if (ud.vro) for (const m of ud.vro) m.visible = !on; if (ud.vrM) ud.vrM.visible = on; if (ud.vrO) ud.vrO.visible = on; });
}
function vrMergeAll(on) { VR.merge = on; vrMergeApply(hero.root, on); vrMergeApply(twin.root, on); for (const e of ENEMIES) vrMergeApply(e.mesh, on); for (const k of CHESTS) vrMergeApply(k.g, on); }

