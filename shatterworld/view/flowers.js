// ---- flowers (billboard heads on stems), patchy clusters --------------------------------------------------------------
const FLOWER_MAX = 20000;
function makeFlowerGeo() {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, 0, 0, 0.5, 0, 0, -0.5, 1, 0, 0.5, 1, 0]), 3)); g.setIndex([0, 1, 2, 2, 1, 3]);
  const off = new Float32Array(FLOWER_MAX * 4), r = mulberry(777);
  for (let i = 0; i < FLOWER_MAX; i++) { off[i * 4] = r() * FIELD; off[i * 4 + 1] = r() * FIELD; off[i * 4 + 2] = r(); off[i * 4 + 3] = r(); }
  g.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 4)); g.instanceCount = FLOWER_MAX; g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  return g;
}
const flowerMat = new THREE.ShaderMaterial({
  fog: true, side: THREE.DoubleSide,
  uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uHW: { value: texHW }, uNm: { value: texNm }, uNoise: { value: NOISE }, uHero: U.hero, uFieldC: grassUniforms.uFieldC, uTime: U.time, uWave: U.wave, uWaveB: U.waveB, uSunDir: U.sunDir, uSunCol: U.sunCol, uAmb: { value: new THREE.Color(0.5, 0.55, 0.65) } }]),
  vertexShader: `attribute vec4 aOff; uniform sampler2D uHW; uniform sampler2D uNm; uniform vec3 uHero; uniform vec2 uFieldC; uniform float uTime; ${GLSL.noiseFn} ${GLSL.vox}
varying vec2 vUv; varying vec3 vCol; varying float vShow;
#include <fog_pars_vertex>
void main(){
  vec2 gp = aOff.xy + 64.0 * floor((uFieldC - aOff.xy) / 64.0 + 0.5);
  float vox = voxAt(gp);
  float dist = length(gp - uHero.xz); vec2 uvw = (gp + 64.0) / 128.0;
  float gmask = textureLod(uNm, uvw, 0.0).b;
  float pat = smoothstep(0.52, 0.72, nz(gp * 0.085 + 3.0, 2));
  float keep = step(aOff.w, pat * gmask * 0.9) * (1.0 - smoothstep(12.0, 26.0, dist)) * (1.0 - smoothstep(0.05, 0.4, vox));
  float gh = textureLod(uHW, (gp + 64.5) / 129.0, 0.0).r;
  float hgt = (0.32 + 0.3 * fract(aOff.z * 5.7)) * keep;
  float ph = uTime * 1.7 + gp.x * 0.55 + gp.y * 0.4; float sway = sin(ph) * 0.06 * hgt;
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  float sz = (0.13 + 0.07 * fract(aOff.z * 3.3)) * keep;
  vec3 wp = vec3(gp.x + sway, gh - 0.02, gp.y) + right * position.x * sz * 1.0 + vec3(0.0, position.y * (hgt + sz), 0.0);
  vUv = vec2(position.x + 0.5, position.y); vShow = (hgt + sz) > 0.0 ? sz / (hgt + sz) : 0.5;
  float c = fract(aOff.z * 11.3);
  vCol = c < 0.28 ? vec3(1.0, 0.95, 0.82) : c < 0.5 ? vec3(1.0, 0.82, 0.18) : c < 0.72 ? vec3(0.96, 0.38, 0.55) : c < 0.88 ? vec3(0.55, 0.45, 0.95) : vec3(1.0, 0.5, 0.2);
  vec4 mvPosition = viewMatrix * vec4(wp, 1.0); gl_Position = projectionMatrix * mvPosition;
#include <fog_vertex>
}`,
  fragmentShader: `varying vec2 vUv; varying vec3 vCol; varying float vShow; uniform vec3 uSunCol; uniform vec3 uAmb;
#include <fog_pars_fragment>
void main(){
  float headY = 1.0 - vShow * 0.5;  // head centre as a fraction of the quad height
  vec2 q = vec2(vUv.x - 0.5, (vUv.y - headY) * (1.0 / max(vShow, 0.05)) * 0.5);
  float r = length(q) * 2.0, a = atan(q.y, q.x);
  float petal = 0.55 + 0.45 * cos(a * 5.0);
  float head = step(r, 0.45 + 0.4 * petal * 0.6) * step(0.0, vUv.y - (1.0 - vShow));
  float core = step(r, 0.2);
  float stem = step(abs(vUv.x - 0.5), 0.035) * step(vUv.y, 1.0 - vShow * 0.9);
  if (head + stem < 0.5) discard;
  vec3 col = head > 0.5 ? mix(vCol, vec3(1.0, 0.8, 0.2), core) : vec3(0.18, 0.4, 0.1);
  col *= 0.42 + 0.4 * uSunCol + uAmb * 0.2; col *= 0.85 + 0.3 * (1.0 - r * 0.6) * step(0.5, head);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`,
});
const flowers = new THREE.Mesh(makeFlowerGeo(), flowerMat); flowers.frustumCulled = false; scene.add(flowers);
function onGrassQuality() { grass.material = Q.lite ? grassMatLite : grassMat; grass.geometry.instanceCount = Q.grass; flowers.geometry.instanceCount = Math.round(Q.grass * 0.16); grassUniforms.uBladeScale.value = Q.grass < 30000 ? 1.5 : Q.grass < 70000 ? 1.18 : 1; }

