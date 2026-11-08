// ---- procedural Touch-style controller (no asset download) ---------------------------------------------------------------------------
const UI = { mode: 'none', built: false, btns: [], hotKey: -1, laserLen: [1.2, 1.2], hit: [false, false], hot: [-1, -1], cap: { talk: '', talkOn: false, talkSeq: -1, toast: '', toastOn: false, toastSeq: -1, prompt: '', promptOn: false, who: '' }, capT: 0, wr: { sig: '' }, howShown: false, rp: null, hudP: null, chips: [], sumBottom: 0, contentH: 1000 };
const vrCtrl = [null, null]; // three controller groups (target-ray space); their hand is data.handedness
UI.ch = [null, null];        // controller group currently carrying the LEFT (0) / RIGHT (1) hand, or null
function vrBuildControllerModel() {
  const g = new THREE.Group(), list = []; const M = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  const add = (geo, x, y, z, rx, ry, rz, hex) => { e.set(rx, ry, rz); q.setFromEuler(e); M.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(1, 1, 1)); list.push({ geo, mat: M.clone(), col: new THREE.Color(hex) }); };
  add(new THREE.CylinderGeometry(0.017, 0.021, 0.12, 10), 0, -0.03, 0.06, 0.55, 0, 0, 0x2a2f3a);          // handle, angled back + down
  add(new THREE.TorusGeometry(0.043, 0.0075, 6, 20), 0, 0.012, -0.008, PI / 2 - 0.35, 0, 0, 0x8892a6);       // tracking ring
  add(new THREE.SphereGeometry(0.02, 10, 8), 0, 0.0, -0.016, 0, 0, 0, 0x3a4150);                              // nose
  add(new THREE.CylinderGeometry(0.014, 0.014, 0.006, 12), 0, 0.022, 0.04, 0, 0, 0, 0x151820);                // thumbstick well
  const body = new THREE.Mesh(vrBake(list, true), new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, fog: false })); body.frustumCulled = false; g.add(body);
  const acc = new THREE.MeshBasicMaterial({ color: 0x53e0d0, toneMapped: false, fog: false });
  const trig = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.03, 0.014), acc); trig.position.set(0, -0.036, 0.0); trig.frustumCulled = false; g.add(trig);
  const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.011, 0.012, 10), new THREE.MeshBasicMaterial({ color: 0xdfe7f5, toneMapped: false, fog: false })); stick.position.set(0, 0.03, 0.04); stick.frustumCulled = false; g.add(stick);
  const btnA = new THREE.Mesh(new THREE.SphereGeometry(0.0085, 8, 6), new THREE.MeshBasicMaterial({ color: 0x444b5c, toneMapped: false, fog: false })); btnA.position.set(0.02, 0.026, 0.07); btnA.frustumCulled = false; g.add(btnA);
  const btnB = btnA.clone(); btnB.material = btnA.material.clone(); btnB.position.set(0.02, 0.03, 0.052); g.add(btnB);
  g.userData = { body, trig, stick, btnA, btnB, acc };
  return g;
}

