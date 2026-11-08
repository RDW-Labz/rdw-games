// ---- pipes, pads, low-gravity pockets ---------------------------------------------------------------------------------------
const lowgMeshes = [];
const lowgMat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.BackSide, fog: false, uniforms: { uTime: U.time },
  vertexShader: `varying vec3 vN; varying vec3 vV; varying vec3 vP; void main(){ vP = position; vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `uniform float uTime; varying vec3 vN; varying vec3 vV; varying vec3 vP; void main(){ float f = pow(max(1.0 - abs(dot(vN, vV)), 0.0), 2.2); float s = 0.5 + 0.5 * sin(vP.y * 1.6 - uTime * 2.0); gl_FragColor = vec4(vec3(1.0, 0.55, 0.85) * (0.4 + s * 0.6) * 1.4, f * 0.35);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  }` });
let warpT = 0, warpTarget = null, PROMPT = '';
function updatePipesPads(dt) {
  P.inLowG = false;
  if (!LV) return; let msg = '';
  for (const lg of LV.lowg) { if (Math.hypot(P.x - lg.x, P.y - lg.y, P.z - lg.z) < lg.r) P.inLowG = true; }
  if (warpT > 0) { warpT -= dt; if (warpT <= 0.25 && warpTarget) { const w = warpTarget; warpTarget = null; setHeroPos(w.x, w.y, w.z); P.yaw = 0; CAM.yaw = P.yaw; camShake(0.4); sfx('pipe'); G.flash = 0.35; } if (warpT > 0.25) { P.vx = P.vz = 0; P.vy = 0; hero.root.scale.y *= 1; } }
  else for (const p of LV.pipes) { if (Math.hypot(P.x - p.x, P.z - p.z) < 1.9 && Math.abs(P.y - p.y) < 0.7 && P.grounded) { msg = 'Crouch (Z) to enter the pipe'; if (INP.crouch) { const to = LV.pipes.find(q => q.id === p.to); if (to) { warpT = 0.7; warpTarget = { x: to.x, y: to.y + 0.05, z: to.z }; sfx('pipe'); P.frozen = 0.7; } } } }
  for (const pd of LV.pads) { if (Math.hypot(P.x - pd.x, P.z - pd.z) < 1.7 && Math.abs((GF > 0 ? P.y : P.y) - pd.y) < 1.0 && P.grounded) { msg = 'Press E to flip gravity'; if (edge.e) { edge.e = false; flipGravity(); } } }
  if (msg) PROMPT = msg;
}
function flipGravity() {
  const h = heroH();
  if (GF > 0) { P.gy = -(P.y + h); GF = -1; P.y = -P.gy; } else { const wy = P.y - h; GF = 1; P.gy = wy; P.y = wy; }
  P.vy = 0; P.grounded = false; setAct('air'); P.airKind = 'flip'; P.flipKind = 'back'; P.flipT = 0; P.vx *= 0.3; P.vz *= 0.3; sfx('flip'); G.flash = 0.25; camShake(0.4); toast(GF < 0 ? 'Gravity flipped!' : 'Gravity restored');
}
function updateRotators(dt) {
  for (const d of DISCS) {
    const da = d.w * dt; d.ang += da; const R = d.ref; const ca = Math.cos(d.ang), sa = Math.sin(d.ang);
    for (const k of R.cubes) { const lx = C.hx[k], lz = C.hz[k]; C.x[k] = d.cx + lx * ca - lz * sa; C.z[k] = d.cz + lx * sa + lz * ca; C.y[k] = R.cyw + C.hy[k]; C.qx[k] = 0; C.qz[k] = 0; C.qy[k] = Math.sin(-d.ang / 2); C.qw[k] = Math.cos(-d.ang / 2); C.s[k] = C.ts[k]; C.vox[k] = Math.max(0, C.vox[k] - dt * 0.8); }
    if (P.grounded && Math.hypot(P.x - d.cx, P.z - d.cz) < d.R && Math.abs(P.y - d.y1) < 0.2) { const rx = P.x - d.cx, rz = P.z - d.cz; P.x = d.cx + rx * Math.cos(da) - rz * Math.sin(da); P.z = d.cz + rx * Math.sin(da) + rz * Math.cos(da); P.yaw -= da; }
  }
}

