// ============================================================================
// SKY (gradient + sun + lit fbm clouds + stars + pixel-dissolve), LIGHTS, ENV, WATER
// ============================================================================
const PAL = { // per-act atmosphere (all sRGB hex); lerped at runtime so acts crossfade
  1: { zen: 0x1d56b8, mid: 0x7fb4e6, hor: 0xffc27a, gnd: 0xe0a86c, sun: 0xffc98a, sunI: 3.3, hemiS: 0x8fb8ff, hemiG: 0x8a6a3a, hemiI: 0.5, fog: 0xf3cf9c, fogD: 0.0038, cloud: 0.52, cloudLit: 0xfff1d6, cloudSh: 0x8aa0c8, stars: 0, exp: 1.0, env: 0.55, sunDir: [-0.74, 0.44, 0.38] },
  2: { zen: 0x3a2f9e, mid: 0xc08bd8, hor: 0xffa6b4, gnd: 0xffc9b0, sun: 0xffc4a0, sunI: 3.0, hemiS: 0xd8b0ff, hemiG: 0xffa0a8, hemiI: 0.6, fog: 0xffb9c8, fogD: 0.0034, cloud: 0.5, cloudLit: 0xffe6e8, cloudSh: 0xb88ad0, stars: 0.0, exp: 1.02, env: 0.55, sunDir: [0.55, 0.22, 0.72] },
  3: { zen: 0x0a0424, mid: 0x4a1a78, hor: 0xd23a9c, gnd: 0x2a0a40, sun: 0x7fe9ff, sunI: 1.6, hemiS: 0x58a8ff, hemiG: 0xd03aa0, hemiI: 0.85, fog: 0x4a1b5e, fogD: 0.0075, cloud: 0.22, cloudLit: 0xff9be3, cloudSh: 0x3a1a6a, stars: 1.0, exp: 1.12, env: 0.6, sunDir: [-0.3, 0.55, -0.6] },
};
const ATM = { zen: new THREE.Color(), mid: new THREE.Color(), hor: new THREE.Color(), gnd: new THREE.Color(), sun: new THREE.Color(), hemiS: new THREE.Color(), hemiG: new THREE.Color(), fog: new THREE.Color(), cloudLit: new THREE.Color(), cloudSh: new THREE.Color(),
  sunI: 3, hemiI: 0.5, fogD: 0.006, cloud: 0.5, stars: 0, exp: 1, env: 0.55 };
const _ca = new THREE.Color(), _cb = new THREE.Color();
function setAtmosphere(a, b, t) { // blend palette a->b by t (b may equal a)
  const A = PAL[a], B = PAL[b];
  for (const k of ['zen', 'mid', 'hor', 'gnd', 'sun', 'hemiS', 'hemiG', 'fog', 'cloudLit', 'cloudSh']) { _ca.set(A[k === 'cloudSh' ? 'cloudSh' : k]); _cb.set(B[k]); ATM[k].copy(_ca).lerp(_cb, t); }
  for (const k of ['sunI', 'hemiI', 'fogD', 'cloud', 'stars', 'exp', 'env']) ATM[k] = lerp(A[k], B[k], t);
  U.sunDir.value.set(lerp(A.sunDir[0], B.sunDir[0], t), lerp(A.sunDir[1], B.sunDir[1], t), lerp(A.sunDir[2], B.sunDir[2], t)).normalize();
}
GLSL.skyBase = `
uniform vec3 uZen; uniform vec3 uMid; uniform vec3 uHor; uniform vec3 uGnd; uniform vec3 uSunDir; uniform vec3 uSunCol;
vec3 skyBase(vec3 d){
  float h = d.y;
  float hh = clamp(h, 0.0, 1.0);
  vec3 c = hh < 0.3 ? mix(uHor, uMid, pow(hh / 0.3, 0.65)) : mix(uMid, uZen, pow((hh - 0.3) / 0.7, 0.75));
  c = mix(c, uGnd, smoothstep(0.0, -0.3, h));
  float sd = max(dot(d, uSunDir), 0.0);
  c += uSunCol * (pow(sd, 6.0) * 0.38 + pow(sd, 36.0) * 0.55 + pow(sd, 1800.0) * 18.0);
  c += uHor * exp(-max(h, 0.0) * 7.0) * 0.28;
  return c;
}`;
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false,
  uniforms: { uZen: { value: ATM.zen }, uMid: { value: ATM.mid }, uHor: { value: ATM.hor }, uGnd: { value: ATM.gnd }, uSunDir: U.sunDir, uSunCol: U.sunCol, uTime: U.time, uCloud: { value: 0.5 }, uCloudLit: { value: ATM.cloudLit }, uCloudSh: { value: ATM.cloudSh }, uStars: { value: 0 }, uSkyVox: { value: 0 }, uNoise: { value: NOISE }, uLite: U.lite, uNeb: { value: new THREE.Color(0xff3fb0) } },
  vertexShader: `varying vec3 vDir; void main(){ vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
  fragmentShader: `${GLSL.skyBase} ${GLSL.noiseFn} ${GLSL.vox}
uniform float uTime; uniform float uCloud; uniform vec3 uCloudLit; uniform vec3 uCloudSh; uniform float uStars; uniform float uSkyVox; uniform vec3 uNeb; uniform float uLite;
varying vec3 vDir;
float cl(vec2 p){ if (uLite > 0.5) return nz(p, 0) * 0.62 + nz(p * 2.6 + 3.7, 1) * 0.38; return nz(p, 0) * 0.5 + nz(p * 2.13 + 3.7, 1) * 0.27 + nz(p * 4.4 + 9.1, 2) * 0.15 + nz(p * 9.7 + 1.3, 3) * 0.08; }
void main(){
  vec3 d = normalize(vDir);
  if (uSkyVox > 0.001) { float n = mix(900.0, 36.0, pow(uSkyVox, 0.7)); d = normalize(floor(d * n + 0.5) / n); }
  vec3 col = skyBase(d);
  // stars + nebula (act 3)
  if (uStars > 0.01) { vec3 q = floor(d * 260.0); float hs = hash13(q); float tw = 0.6 + 0.4 * sin(uTime * 2.0 + hs * 40.0); col += vec3(1.0, 0.9, 1.0) * step(0.9972, hs) * tw * 2.2 * uStars * smoothstep(-0.05, 0.3, d.y);
    float nb = nz(d.xz / (d.y + 1.2) * 1.3 + 5.0, 1) * nz(d.xz * 0.7 + d.y, 2); col += uNeb * pow(nb, 2.2) * 1.1 * uStars; }
  // clouds
  if (d.y > 0.0) {
    vec2 uv = d.xz / (d.y + 0.16) * 0.42 + vec2(uTime * 0.006, uTime * 0.0025);
    float c = cl(uv); float cov = 1.0 - uCloud;
    float dens = smoothstep(cov, cov + 0.22, c);
    float c2 = uLite > 0.5 ? c - 0.04 : cl(uv + uSunDir.xz * 0.045 / (d.y + 0.3));
    float lit = clamp((c - c2) * 4.5 + 0.62, 0.0, 1.0);
    vec3 cc = mix(uCloudSh, uCloudLit, lit);
    float sd = max(dot(d, uSunDir), 0.0);
    cc += uSunCol * pow(sd, 5.0) * 0.55 * (1.0 - dens * 0.4) + uSunCol * pow(sd, 40.0) * 0.4 * smoothstep(cov + 0.3, cov, c);
    float fade = smoothstep(0.0, 0.22, d.y);
    col = mix(col, cc, dens * fade * 0.93);
  }
  if (uSkyVox > 0.01) { col = voxPost(col, uSkyVox, gl_FragCoord.xy); }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(900, 40, 24), skyMat); sky.frustumCulled = false; sky.renderOrder = -100; scene.add(sky);

// lights ---------------------------------------------------------------------------------------------------------------
const hemi = new THREE.HemisphereLight(0x9ec4ff, 0x6b5a3a, 0.55); scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffd29a, 3.1); sun.castShadow = true; scene.add(sun, sun.target);
sun.shadow.bias = -0.00045; sun.shadow.normalBias = 0.06;
function configureShadow() {
  const on = Q.shadow > 0; renderer.shadowMap.enabled = on; sun.castShadow = on; renderer.shadowMap.type = Q.vr ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
  if (on) { const s = sun.shadow; s.mapSize.set(Q.shadow, Q.shadow); if (s.map) { s.map.dispose(); s.map = null; } const R = Q.shadow >= 2048 ? 30 : 34; Object.assign(s.camera, { left: -R, right: R, top: R, bottom: -R, near: 1, far: 160 }); s.camera.updateProjectionMatrix(); }
  scene.traverse(o => { if (o.material) { const m = Array.isArray(o.material) ? o.material : [o.material]; m.forEach(x => x.needsUpdate = true); } });
}
const _sp = new THREE.Vector3();
function updateSun(cx, cy, cz) {
  const d = U.sunDir.value, R = Q.shadow >= 2048 ? 30 : 34, texel = (R * 2) / Math.max(Q.shadow, 512);
  const sx = Math.round(cx / texel) * texel, sy = Math.round(cy / texel) * texel, sz = Math.round(cz / texel) * texel; // snap -> no shimmer
  sun.position.set(sx + d.x * 70, sy + d.y * 70, sz + d.z * 70); sun.target.position.set(sx, sy, sz); sun.target.updateMatrixWorld();
}
// environment lighting from the sky itself
const pmrem = new THREE.PMREMGenerator(renderer); let envRT = null;
const envScene = new THREE.Scene(); const envSky = new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), skyMat); envScene.add(envSky);
function updateEnv() {
  const prev = skyMat.uniforms.uSkyVox.value; skyMat.uniforms.uSkyVox.value = 0;
  const rt = pmrem.fromScene(envScene, 0.02, 1, 500); if (envRT) envRT.dispose(); envRT = rt; scene.environment = Q.lite ? null : rt.texture; skyMat.uniforms.uSkyVox.value = prev; applyAtmosphere();
}
let beamMatRef = null;
function applyAtmosphere() {
  U.sunCol.value.copy(ATM.sun).multiplyScalar(1.0);
  sun.color.copy(ATM.sun); sun.intensity = ATM.sunI; hemi.color.copy(ATM.hemiS); hemi.groundColor.copy(ATM.hemiG); hemi.intensity = ATM.hemiI * (Q.lite ? 2.1 : 1); if (envRT) scene.environment = Q.lite ? null : envRT.texture;
  scene.fog.color.copy(ATM.fog); scene.fog.density = ATM.fogD; skyMat.uniforms.uCloud.value = ATM.cloud; skyMat.uniforms.uStars.value = ATM.stars;
  scene.environmentIntensity = ATM.env; renderer.toneMappingExposure = ATM.exp; if (beamMatRef) beamMatRef.uniforms.uCol.value.copy(ATM.sun);
}
setAtmosphere(1, 1, 0); applyAtmosphere();

// water -----------------------------------------------------------------------------------------------------------------
const waterMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, fog: true,
  uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uHW: { value: texHW }, uNoise: { value: NOISE }, uTime: U.time, uWY: { value: WATER_Y }, uWave: U.wave, uWaveB: U.waveB,
    uZen: { value: ATM.zen }, uMid: { value: ATM.mid }, uHor: { value: ATM.hor }, uGnd: { value: ATM.gnd }, uSunDir: U.sunDir, uSunCol: U.sunCol, uDeep: { value: new THREE.Color(0x0a3a46) }, uShallow: { value: new THREE.Color(0x4fb59a) }, uQ: { value: 2 }, uFade: { value: 1 } }]),
  vertexShader: `varying vec3 vWP;
#include <fog_pars_vertex>
void main(){ vWP = (modelMatrix * vec4(position, 1.0)).xyz; vec4 mvPosition = viewMatrix * vec4(vWP, 1.0); gl_Position = projectionMatrix * mvPosition;
#include <fog_vertex>
}`,
  fragmentShader: `${GLSL.skyBase} ${GLSL.noiseFn} ${GLSL.vox}
uniform sampler2D uHW; uniform float uTime; uniform float uWY; uniform vec3 uDeep; uniform vec3 uShallow; uniform float uQ; uniform float uFade;
varying vec3 vWP;
#include <fog_pars_fragment>
void main(){
  float hgt = texture(uHW, (vWP.xz + 64.5) / 129.0).r;
  float depth = uWY - hgt;
  if (depth < 0.0) discard;
  float vox = voxAt(vWP.xz); if (vox > 0.85) discard;
  vec2 p = vWP.xz; if (vox > 0.001) { float cs = mix(0.03, 1.0, pow(vox, 1.35)); p = (floor(p / cs) + 0.5) * cs; }
  float t = uTime; vec2 fl = vec2(0.0, 1.0);
  vec2 q1 = p * 0.11 + fl * t * 0.045, q2 = p * 0.27 + vec2(0.5, 1.0) * t * 0.07, q3 = p * vec2(0.9, 0.35) + fl * t * 0.16;
  float e = 0.004;
  float h0 = nz(q1, 0) + (uQ > 0.5 ? nz(q2, 1) * 0.6 : 0.0) + (uQ > 1.5 ? nz(q3, 2) * 0.35 : 0.0);
  float hx = nz(q1 + vec2(e, 0.), 0) + (uQ > 0.5 ? nz(q2 + vec2(e, 0.), 1) * 0.6 : 0.0) + (uQ > 1.5 ? nz(q3 + vec2(e, 0.), 2) * 0.35 : 0.0);
  float hz = nz(q1 + vec2(0., e), 0) + (uQ > 0.5 ? nz(q2 + vec2(0., e), 1) * 0.6 : 0.0) + (uQ > 1.5 ? nz(q3 + vec2(0., e), 2) * 0.35 : 0.0);
  vec3 N = normalize(vec3(-(hx - h0) / e * 0.012, 1.0, -(hz - h0) / e * 0.012));
  vec3 V = normalize(cameraPosition - vWP);
  vec3 R = reflect(-V, N); R.y = abs(R.y) + 0.02;
  float fr = 0.1 + 0.9 * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 4.0);
  vec3 body = mix(uShallow, uDeep, 1.0 - exp(-depth * 0.95));
  float bed = exp(-depth * 1.6);
  body = mix(body, body * 1.5 + vec3(0.03, 0.05, 0.03), bed * 0.4);
  vec3 sk = skyBase(normalize(R));
  vec3 col = mix(body, sk, fr);
  float sp = pow(max(dot(normalize(R), uSunDir), 0.0), 220.0) * 10.0 + pow(max(dot(normalize(R), uSunDir), 0.0), 18.0) * 0.5;
  col += uSunCol * sp * (0.5 + h0 * 0.5);
  float foam = smoothstep(0.42, 0.02, depth + (nz(p * 2.3 + t * 0.03, 2) - 0.5) * 0.3) + smoothstep(0.82, 0.95, nz(p * vec2(1.4, 0.5) + fl * t * 0.12, 3)) * 0.12 * smoothstep(0.2, 1.0, depth);
  col = mix(col, vec3(0.95, 0.97, 0.95), clamp(foam, 0.0, 1.0) * 0.85);
  float a = clamp((1.0 - exp(-depth * 2.0)) * 0.93 + foam * 0.5 + fr * 0.3, 0.0, 0.97) * uFade;
  if (vox > 0.001) { col = voxPost(col, vox, gl_FragCoord.xy); a *= 1.0 - smoothstep(0.5, 0.85, vox); col += vec3(1.0, 0.8, 0.42) * ringAt(vWP.xz) * 1.2; }
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`,
});
const water = new THREE.Mesh(new THREE.PlaneGeometry(130, 130, 1, 1).rotateX(-PI / 2).translate(0, WATER_Y, 0), waterMat);
water.frustumCulled = false; water.renderOrder = 5; scene.add(water);

