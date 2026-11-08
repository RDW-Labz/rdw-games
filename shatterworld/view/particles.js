// ============================================================================
// ENTITIES: particles, coins, Sun Shards, ? blocks, power-ups, walkers/shell enemies, the twin NPC, pipes, flip pads, low-g pockets
// ============================================================================
// ---- particles (dust, sparks, confetti) ----------------------------------------------------------------------------------
const NPART = 1100, PT = { x: new Float32Array(NPART), y: new Float32Array(NPART), z: new Float32Array(NPART), vx: new Float32Array(NPART), vy: new Float32Array(NPART), vz: new Float32Array(NPART), life: new Float32Array(NPART), max: new Float32Array(NPART), size: new Float32Array(NPART), grav: new Float32Array(NPART) };
const ptGeo = new THREE.BufferGeometry(); const ptPos = new Float32Array(NPART * 3), ptCol = new Float32Array(NPART * 4), ptSize = new Float32Array(NPART);
ptGeo.setAttribute('position', new THREE.BufferAttribute(ptPos, 3)); ptGeo.setAttribute('aCol', new THREE.BufferAttribute(ptCol, 4)); ptGeo.setAttribute('aSize', new THREE.BufferAttribute(ptSize, 1));
const ptMat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, fog: false, uniforms: { uPix: { value: 1 }, uWS: { value: 1 } },
  vertexShader: `attribute vec4 aCol; attribute float aSize; varying vec4 vC; uniform float uPix; uniform float uWS; void main(){ vC = aCol; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; gl_PointSize = aSize * uPix * 380.0 / max(0.5, -mv.z * uWS); }`,
  fragmentShader: `varying vec4 vC; void main(){ vec2 d = gl_PointCoord - 0.5; float r = length(d) * 2.0; if (r > 1.0) discard; float a = smoothstep(1.0, 0.2, r) * vC.a; gl_FragColor = vec4(vC.rgb, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  }` });
const ptMesh = new THREE.Points(ptGeo, ptMat); ptMesh.frustumCulled = false; ptMesh.renderOrder = 20; scene.add(ptMesh);
let ptN = 0; const _pc = new THREE.Color();
const PCOL = new Float32Array(NPART * 3);
function puff(x, y, z, n, size = 1, color = 0xd8c8a0, speed = 2.2, grav = -1.5, life = 0.7) {
  _pc.set(color); for (let k = 0; k < n; k++) { const i = ptN++ % NPART, a = Math.random() * TAU, s = speed * (0.4 + Math.random() * 0.8); PT.x[i] = x + (Math.random() - 0.5) * 0.3; PT.y[i] = y; PT.z[i] = z + (Math.random() - 0.5) * 0.3; PT.vx[i] = Math.cos(a) * s; PT.vz[i] = Math.sin(a) * s; PT.vy[i] = Math.random() * s * 0.8 + 0.2; PT.life[i] = PT.max[i] = life * (0.6 + Math.random() * 0.8); PT.size[i] = size * (0.5 + Math.random() * 0.6) * 0.5; PT.grav[i] = grav; PCOL[i * 3] = _pc.r; PCOL[i * 3 + 1] = _pc.g; PCOL[i * 3 + 2] = _pc.b; }
}
function sparkBurst(x, y, z, n, color = 0xffd060, speed = 5) { puff(x, y, z, n, 0.5, color, speed, -4, 0.6); for (let k = 0; k < n; k++) { const i = (ptN - 1 - k + NPART) % NPART; PCOL[i * 3] *= 3; PCOL[i * 3 + 1] *= 3; PCOL[i * 3 + 2] *= 3; } }
function updateParticles(dt) {
  for (let i = 0; i < NPART; i++) {
    if (PT.life[i] <= 0) { ptCol[i * 4 + 3] = 0; ptSize[i] = 0; continue; }
    PT.life[i] -= dt; PT.vy[i] += PT.grav[i] * dt; PT.x[i] += PT.vx[i] * dt; PT.y[i] += PT.vy[i] * dt; PT.z[i] += PT.vz[i] * dt; const k = 1 - Math.exp(-2 * dt); PT.vx[i] -= PT.vx[i] * k; PT.vz[i] -= PT.vz[i] * k;
    const t = PT.life[i] / PT.max[i]; ptPos[i * 3] = PT.x[i]; ptPos[i * 3 + 1] = PT.y[i]; ptPos[i * 3 + 2] = PT.z[i]; ptCol[i * 4] = PCOL[i * 3]; ptCol[i * 4 + 1] = PCOL[i * 3 + 1]; ptCol[i * 4 + 2] = PCOL[i * 3 + 2]; ptCol[i * 4 + 3] = Math.min(1, t * 2) * 0.85; ptSize[i] = PT.size[i] * (1.5 - t * 0.7);
  }
  ptGeo.attributes.position.needsUpdate = ptGeo.attributes.aCol.needsUpdate = ptGeo.attributes.aSize.needsUpdate = true; ptMat.uniforms.uPix.value = renderer.getPixelRatio() * H / 900;
}
// drifting ambient motes (pollen / sparkles) around the camera
const NMOTE = 380, moteGeo = new THREE.BufferGeometry(), motePos = new Float32Array(NMOTE * 3), moteSeed = new Float32Array(NMOTE * 3);
for (let i = 0; i < NMOTE * 3; i++) moteSeed[i] = Math.random();
moteGeo.setAttribute('position', new THREE.BufferAttribute(motePos, 3));
const moteMat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { uCol: { value: new THREE.Color(1.0, 0.82, 0.45) }, uPix: { value: 1 }, uTime: U.time, uWS: { value: 1 } },
  vertexShader: `uniform float uPix; uniform float uTime; uniform float uWS; varying float vA; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; float dz = -mv.z * uWS; float tw = 0.6 + 0.4 * sin(uTime * 2.0 + position.x * 3.0 + position.z * 2.0); vA = tw * smoothstep(40.0, 5.0, dz) * smoothstep(0.5, 3.0, dz); gl_PointSize = 5.5 * uPix * 22.0 / max(1.0, dz); }`,
  fragmentShader: `uniform vec3 uCol; varying float vA; void main(){ float r = length(gl_PointCoord - 0.5) * 2.0; if (r > 1.0) discard; gl_FragColor = vec4(uCol * 1.6, pow(1.0 - r, 2.0) * vA * 0.8);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  }` });
const motes = new THREE.Points(moteGeo, moteMat); motes.frustumCulled = false; motes.renderOrder = 19; scene.add(motes);
function updateMotes(t) {
  const cx = CP.x, cy = CP.y, cz = CP.z, S = 44;
  for (let i = 0; i < NMOTE; i++) {
    const sx = moteSeed[i * 3], sy = moteSeed[i * 3 + 1], sz = moteSeed[i * 3 + 2];
    let x = (sx * S + t * (0.25 + sy * 0.3) + Math.sin(t * 0.6 + sz * 20) * 0.7), y = (sy * 14 + t * 0.12 * (0.5 + sz) + Math.sin(t * 0.8 + sx * 20) * 0.5), z = (sz * S + t * 0.18);
    x = ((x - cx + S / 2) % S + S) % S - S / 2 + cx; z = ((z - cz + S / 2) % S + S) % S - S / 2 + cz; y = ((y - (cy - 3) + 7) % 14 + 14) % 14 - 7 + cy - 3 + 3;
    motePos[i * 3] = x; motePos[i * 3 + 1] = y; motePos[i * 3 + 2] = z;
  }
  moteGeo.attributes.position.needsUpdate = true; moteMat.uniforms.uPix.value = renderer.getPixelRatio() * H / 900;
}

