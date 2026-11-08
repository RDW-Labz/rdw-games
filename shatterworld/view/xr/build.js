// ---- build (lazy, once) -------------------------------------------------------------------------------------------------------------------
const vrBlink = new THREE.Mesh(new THREE.SphereGeometry(0.4, 12, 8), new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide, transparent: true, opacity: 0, depthTest: false, depthWrite: false, fog: false, toneMapped: false }));
vrBlink.renderOrder = 2000; vrBlink.frustumCulled = false; vrBlink.visible = false; camera.add(vrBlink);
const vrRing = new THREE.Mesh(new THREE.RingGeometry(1.46, 1.49, 96).rotateX(-PI / 2), new THREE.MeshBasicMaterial({ color: 0x9ff0e4, transparent: true, opacity: 0.30, depthTest: false, depthWrite: false, fog: false, toneMapped: false })); // fixed "rest frame": the table rim does not move while the world slides under it
vrRing.renderOrder = 50; vrRing.frustumCulled = false; vrRing.visible = false; rig.add(vrRing);
const vrArrow = new THREE.Mesh(new THREE.ConeGeometry(0.34, 1.15, 10).rotateX(PI / 2), new THREE.MeshBasicMaterial({ color: 0xffd060, transparent: true, opacity: 0.9, fog: false, toneMapped: false })); vrArrow.frustumCulled = false; vrArrow.visible = false; scene.add(vrArrow);
function vrBuild() {
  if (VR.built) return; VR.built = true;
  for (let i = 0; i < 2; i++) {
    const c = renderer.xr.getController(i); const model = vrBuildControllerModel(); c.add(model); c.userData = { hand: '', model, hasSrc: false };
    const laser = new THREE.Mesh(new THREE.CylinderGeometry(0.0022, 0.0022, 1, 6, 1, true).rotateX(PI / 2).translate(0, 0, -0.5), new THREE.MeshBasicMaterial({ color: 0x9ff0e4, transparent: true, opacity: 0.85, depthTest: false, toneMapped: false, fog: false })); laser.renderOrder = 1001; laser.frustumCulled = false; laser.visible = false; c.add(laser); c.userData.laser = laser;
    const ret = new THREE.Mesh(new THREE.CircleGeometry(0.012, 14), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthTest: false, toneMapped: false, fog: false })); ret.renderOrder = 1002; ret.frustumCulled = false; ret.visible = false; rig.add(ret); c.userData.ret = ret;
    c.addEventListener('connected', e => { const d = e.data; c.userData.hand = d.handedness || ''; c.userData.hasSrc = true; c.userData.model.visible = !d.hand; c.userData.isHand = !!d.hand; const left = c.userData.hand === 'left'; c.userData.model.userData.acc.color.setHex(left ? 0x53e0d0 : 0xff6fb1); vrAttachWrist(); });
    c.addEventListener('disconnected', () => { c.userData.hasSrc = false; c.userData.hand = ''; vrAttachWrist(); });
    rig.add(c); vrCtrl[i] = c;
  }
  UI.main = vrPanel(1.15, 1.123, 1024, 1000, true); UI.how = vrPanel(0.84, 0.771, 1024, 940, true); UI.capP = vrPanel(0.8, 0.25, 1024, 320, false); UI.wrP = vrPanel(0.26, 0.195, 1024, 768, false);
  rig.add(UI.main.mesh, UI.how.mesh, UI.capP.mesh); UI.wrP.mesh.rotation.x = -PI / 2 + 0.5; UI.wrP.mesh.position.set(0, 0.06, 0.07); rig.add(UI.wrP.mesh);
  UI.wrP.mat.opacity = 0; vrRpgBuild(); gvBuild(); vrDrawHow(); UI.built = true;
}
function vrAttachWrist() { // the wrist panel rides on the left controller; with no left controller it floats low in front (re-parented to the rig)
  UI.ch[0] = UI.ch[1] = null; for (let i = 0; i < 2; i++) { const c = vrCtrl[i]; if (c && c.userData.hasSrc) { if (c.userData.hand === 'left') UI.ch[0] = c; else if (c.userData.hand === 'right') UI.ch[1] = c; } }
  if (!UI.wrP) return; const tgt = UI.ch[0] && !UI.ch[0].userData.isHand ? UI.ch[0] : null;
  const m = UI.wrP.mesh; if (tgt) { if (m.parent !== tgt) { tgt.add(m); m.position.set(0, 0.06, 0.07); m.rotation.set(-PI / 2 + 0.5, 0, 0); } UI.wristFloat = false; } else { if (m.parent !== rig) rig.add(m); UI.wristFloat = true; }
}

