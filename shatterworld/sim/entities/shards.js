// ---- Sun Shards ------------------------------------------------------------------------------------------------------------
const SHARDS = [];
const shardCoreMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 2.4, 0.9) }), shardRingMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 1.7, 0.7) });
const beamMat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false, uniforms: { uTime: U.time, uCol: { value: new THREE.Color(1.0, 0.72, 0.3) } },
  vertexShader: `varying vec2 vUv; varying vec3 vN; varying vec3 vV; void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `uniform float uTime; uniform vec3 uCol; varying vec2 vUv; varying vec3 vN; varying vec3 vV; void main(){ float f = pow(abs(dot(vN, vV)), 1.6); float h = vUv.y; float a = f * (1.0 - h) * (0.55 + 0.25 * sin(uTime * 3.0 + h * 14.0)) * smoothstep(0.0, 0.04, h); gl_FragColor = vec4(uCol * 2.0, a * 0.4);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  }` });
beamMatRef = beamMat; const SHARD_GEO = new THREE.OctahedronGeometry(1, 0);
function makeShardMesh() {
  const g = new THREE.Group(); const core = new THREE.Mesh(SHARD_GEO, shardCoreMat); core.scale.set(0.55, 0.95, 0.55); g.add(core);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.035, 8, 40), shardRingMat); ring.rotation.x = PI / 2; g.add(ring); const ring2 = ring.clone(); ring2.rotation.set(PI / 2.6, 0.4, 0); ring2.scale.setScalar(1.2); g.add(ring2);
  const bits = []; for (let i = 0; i < 4; i++) { const b = new THREE.Mesh(SHARD_GEO, shardCoreMat); b.scale.set(0.12, 0.2, 0.12); g.add(b); bits.push(b); }
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.7, 90, 20, 1, true), beamMat); beam.position.y = 45; g.add(beam);
  g.userData = { core, ring, ring2, bits, beam }; g.traverse(o => o.frustumCulled = false); return g;
}
function addShard(x, y, z, final, extra) { const m = makeShardMesh(); m.position.set(x, y, z); scene.add(m); const s = { x, y, z, final, got: false, mesh: m, ph: Math.random() * 6, ...extra }; SHARDS.push(s); return s; }
function updateShards(dt, t) {
  for (const s of SHARDS) {
    if (s.got) continue; const u = s.mesh.userData, bob = Math.sin(t * 1.8 + s.ph) * 0.18;
    s.mesh.position.y = s.y + bob; u.core.rotation.y = t * 1.4; u.ring.rotation.z = t * 0.9; u.ring2.rotation.z = -t * 0.7; u.beam.visible = !s.noBeam; u.beam.scale.y = VR.beamK; u.beam.position.y = 45 * VR.beamK; s.mesh.rotation.z = s.flip ? PI : 0;
    if (VR.presenting) { const dx = s.x - P.x, dz = s.z - P.z; s.mesh.visible = dx * dx + dz * dz < TUNING.vr.shardVis * TUNING.vr.shardVis || s === G.nextShard; }
    for (let i = 0; i < 4; i++) { const a = t * 1.6 + i * PI / 2; u.bits[i].position.set(Math.cos(a) * 1.2, Math.sin(a * 1.3) * 0.5, Math.sin(a) * 1.2); u.bits[i].rotation.y = a * 2; }
    if (G.state === 'play' && !G.trans && (!SH.on || SH.kind === 'world' && false)) { const dx = s.x - P.x, dz = s.z - P.z, dy = s.y - (P.y + 0.9 * (GF > 0 ? 1 : -1)); if (dx * dx + dz * dz + dy * dy * 0.6 < 3.4) collectShard(s); }
    if (Math.random() < 0.12) puff(s.x + (Math.random() - 0.5) * 1.6, s.y + (Math.random() - 0.5) * 1.6, s.z + (Math.random() - 0.5) * 1.6, 1, 0.35, 0xffd060, 0.5, 0.8, 1.1);
  }
}

