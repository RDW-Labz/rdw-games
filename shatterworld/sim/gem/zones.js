// ---- zones (tornado / stasis bubble), meteor markers ---------------------------------------------------------------------------------------------------------------------------------------------
const ZN = [], ZGEO_T = new THREE.CylinderGeometry(1, 0.28, 1, 24, 8, true).translate(0, 0.5, 0), ZGEO_S = new THREE.SphereGeometry(1, 26, 18);
const zoneMat = kind => new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false, forceSinglePass: true, uniforms: { uTime: U.time, uCol: { value: new THREE.Color(1, 2, 2) }, uFade: { value: 1 } },
  vertexShader: 'varying vec3 vP; varying vec3 vN; varying vec3 vV; void main(){ vP = position; vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }',
  fragmentShader: kind ? `uniform float uTime; uniform vec3 uCol; uniform float uFade; varying vec3 vP; varying vec3 vN; varying vec3 vV; void main(){ float f = pow(max(1.0 - abs(dot(vN, vV)), 0.0), 2.0); float ring = 0.5 + 0.5 * sin(vP.y * 9.0 - uTime * 3.0); float tick = smoothstep(0.96, 1.0, sin(atan(vP.z, vP.x) * 6.0 + uTime * 2.0) * 0.5 + 0.5); gl_FragColor = vec4(uCol * (0.5 + ring * 0.6 + tick), (f * 0.7 + tick * 0.3 + 0.03) * uFade);
#include <tonemapping_fragment>
#include <colorspace_fragment>
}` : `uniform float uTime; uniform vec3 uCol; uniform float uFade; varying vec3 vP; varying vec3 vN; varying vec3 vV; void main(){ float a = atan(vP.z, vP.x); float s = pow(0.5 + 0.5 * sin(a * 3.0 + vP.y * 10.0 - uTime * 9.0), 2.0); float f = pow(abs(dot(vN, vV)), 0.8); gl_FragColor = vec4(uCol * (0.5 + s * 1.4), (0.04 + s * 0.5) * f * uFade * smoothstep(0.0, 0.1, vP.y) * smoothstep(1.05, 0.7, vP.y));
#include <tonemapping_fragment>
#include <colorspace_fragment>
}` });
for (let i = 0; i < 4; i++) { const t = new THREE.Mesh(ZGEO_T, zoneMat(0)), s = new THREE.Mesh(ZGEO_S, zoneMat(1)); for (const m of [t, s]) { m.visible = false; m.frustumCulled = false; m.renderOrder = 17; scene.add(m); } ZN.push({ on: false, kind: 0, x: 0, y: 0, z: 0, t: 0, life: 1, rad: 1, tickT: 0, R: null, mul: 1, vx: 0, vz: 0, mt: t, ms: s, hit: 0 }); }
function znSpawn(kind, R, x, y, z, vx, vz, mul) { let z0 = null; for (const q of ZN) if (!q.on) { z0 = q; break; } if (!z0) z0 = ZN[0]; z0.on = true; z0.kind = kind; z0.R = R; z0.x = x; z0.y = y; z0.z = z; z0.vx = vx; z0.vz = vz; z0.t = 0; z0.mul = mul; z0.tickT = 0.15; z0.rad = R.p.rad * R.area; z0.life = R.p.life * (R.area > 1.3 ? 1.15 : 1); z0.mt.visible = kind === 0; z0.ms.visible = kind === 1; const m = kind ? z0.ms : z0.mt; m.material.uniforms.uCol.value.copy(kind ? vcol('time', 0.7) : vcol('gust', 0.4)); }
function znUpdate(dt) {
  for (const q of ZN) {
    if (!q.on) continue; q.t += dt; if (q.t >= q.life) { q.on = false; q.mt.visible = q.ms.visible = false; fxRing(q.x, q.y, q.z, q.rad * 0.6, q.rad * 1.3, 0.4, q.kind ? VCOL.time : VCOL.gust, 0.7); continue; }
    const R = q.R, k = q.t / q.life, fadeIn = Math.min(1, q.t * 4), fadeOut = Math.min(1, (q.life - q.t) * 3), fade = fadeIn * fadeOut;
    if (q.kind === 0) { q.x += q.vx * dt; q.z += q.vz * dt; const f = floorAt(q.x, q.z, q.y + 2); if (f > -1e8) q.y = f; }
    const m = q.kind ? q.ms : q.mt; m.material.uniforms.uFade.value = fade; m.position.set(q.x, q.kind ? q.y + q.rad * 0.4 : q.y, q.z);
    if (q.kind === 0) { m.scale.set(q.rad * (0.5 + 0.5 * fadeIn) * 0.8, q.rad * 1.6, q.rad * (0.5 + 0.5 * fadeIn) * 0.8); m.rotation.y += dt * 4; if (Math.random() < 0.8) { const a = Math.random() * TAU, h = Math.random() * q.rad * 1.8, rr = q.rad * (0.3 + h / (q.rad * 1.8) * 0.7); pt(q.x + Math.cos(a) * rr, q.y + h, q.z + Math.sin(a) * rr, -Math.sin(a) * 5, 1.5, Math.cos(a) * 5, 0.5, 0.6, 0, vcol('gust', 1)); } gemPull(q.x, q.z, q.rad * 1.4, R.p.pull); }
    else { m.scale.setScalar(q.rad * (0.7 + 0.3 * fadeIn)); if (Math.random() < 0.5) { const a = Math.random() * TAU; pt(q.x + Math.cos(a) * q.rad * 0.9, q.y + 0.3 + Math.random() * q.rad * 0.6, q.z + Math.sin(a) * q.rad * 0.9, 0, 0.3, 0, 0.8, 0.5, 0, vcol('time', 0.9)); } }
    q.tickT -= dt; if (q.tickT <= 0) { q.tickT = R.p.tick; for (const o of ENEMIES) { if (!gemOk(o)) continue; const dx = o.x - q.x, dz = o.z - q.z; if (dx * dx + dz * dz < q.rad * q.rad * 1.05 && Math.abs(o.y - q.y) < q.rad * 1.4 + 1) { if (q.kind) { o.gSlowT = 0.7; o.gSlowAmt = Math.max(o.gSlowAmt || 0, Math.min(0.9, R.p.slow + R.slow)); } gemStrike(R, o, q.mul, q.x, q.z, q.kind ? 0 : 1.5); } } }
  }
}
const FL = []; for (let i = 0; i < 8; i++) FL.push({ on: false, x: 0, z: 0, gy: 0, t: 0, delay: 1, R: null, mul: 1 });
function gemMeteorHit(p) { const R = p.R, x = p.x, z = p.z, gy = p.gy, rad = R.p.rad * R.area; gsfx('gmeteorhit'); camShake(0.5); heroHitstop(0.05); fxRing(x, gy, z, 0.5, rad * 1.15, 0.5, VCOL.ember, 1); fxRing(x, gy, z, 0.3, rad * 0.7, 0.35, 0xfff0c0, 1, true); fxChunks(x, gy + 0.6, z, 12, 0x7a4a2a, 0.26, 7, gy); sparkBurst(x, gy + 0.6, z, 26, 0xff8a3c, 9); puff(x, gy + 0.3, z, 10, 1.6, 0xd8a070, 4, -1, 0.9); ptRing(x, gy + 0.2, z, 14, rad * 0.5, 2.5, 0.8, 1.0, vcol('ember', 1), 3);
  for (const o of ENEMIES) { if (!gemOk(o) || Math.hypot(o.x - x, o.z - z) > rad || Math.abs(o.y - gy) > 3.5) continue; gemStrike(R, o, p.mul, x, z, 8); } }
function flUpdate(dt) { for (const f of FL) { if (!f.on) continue; f.t += dt; if (f.t >= f.delay) { f.on = false; const R = f.R; pjSpawn(5, R, f.x + 0.0, f.gy + 18, f.z, 0, -2, 0, f.mul, { sc: 1.5, gy: f.gy, life: 3, elem: 'ember', rad: R.p.rad }); } } }

