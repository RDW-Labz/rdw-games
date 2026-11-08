// ============================================================================
// SUN SHAFTS: soft additive light shafts slanting through the valley (axial billboards) - volumetric-looking god rays on top of the screen-space pass
// ============================================================================
const SHAFT_N = 9, shafts = [];
const shaftMat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
  uniforms: { uTime: U.time, uCol: { value: new THREE.Color(1, 0.8, 0.5) }, uAmt: { value: 1 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `uniform float uTime; uniform vec3 uCol; uniform float uAmt; varying vec2 vUv;
void main(){ float x = abs(vUv.x - 0.5) * 2.0; float edge = pow(max(1.0 - x, 0.0), 2.2); float along = smoothstep(0.0, 0.18, vUv.y) * (1.0 - smoothstep(0.55, 1.0, vUv.y));
  float streak = 0.65 + 0.35 * sin(vUv.x * 22.0 + uTime * 0.25) * sin(vUv.x * 9.0 - uTime * 0.17);
  gl_FragColor = vec4(uCol * 1.4, edge * along * streak * 0.16 * uAmt);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}` });
{ const r = mulberry(909); for (let i = 0; i < SHAFT_N; i++) { const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), shaftMat); m.frustumCulled = false; m.renderOrder = 8; m.userData = { ox: (r() - 0.5) * 70, oz: (r() - 0.2) * 70, w: 5 + r() * 7, ph: r() * 6 }; scene.add(m); shafts.push(m); } }
const _sa = new THREE.Vector3(), _sr = new THREE.Vector3(), _sn = new THREE.Vector3(), _sm = new THREE.Matrix4(), _sc = new THREE.Vector3();
function updateShafts() {
  const on = Q.god && G.state !== 'dead' && act1Visible && !(G.trans && G.trans.from === 1 && G.trans.t > 1.5); shaftMat.uniforms.uAmt.value = on ? 1 : 0; for (const m of shafts) m.visible = on; if (!on) return;
  shaftMat.uniforms.uCol.value.copy(ATM.sun);
  const d = U.sunDir.value, ax = Math.floor(P.x / 48) * 48 + 24, az = Math.floor(P.z / 48) * 48 + 24; _sa.copy(d); const len = 46;
  camera.getWorldDirection(_sc); const face = clamp(_sc.dot(d), 0, 1);
  for (const m of shafts) {
    const u = m.userData, bx = ax + u.ox, bz = az + u.oz, by = clamp(hfSample(bx, bz), -2, 40) - 4; m.position.set(bx + _sa.x * len * 0.5, by + _sa.y * len * 0.5, bz + _sa.z * len * 0.5);
    _sr.set(bx - CP.x, by - CP.y, bz - CP.z).normalize(); _sr.crossVectors(_sa, _sr).normalize(); _sn.crossVectors(_sr, _sa).normalize(); _sm.makeBasis(_sr, _sa, _sn); m.quaternion.setFromRotationMatrix(_sm); m.scale.set(u.w, len, 1);
    const dist = Math.hypot(bx - CP.x, bz - CP.z); m.material.uniforms; m.visible = dist < 90;
  }
  shaftMat.uniforms.uAmt.value = (0.35 + 0.9 * Math.pow(face, 1.5)) * (0.8 + 0.2 * Math.sin(U.time.value * 0.3));
}

