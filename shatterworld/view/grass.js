// ---- grass ------------------------------------------------------------------------------------------------------------
const GRASS_MAX = 120000, FIELD = 64;
const grassUniforms = { uHW: { value: texHW }, uCol: { value: texCol }, uNm: { value: texNm }, uNoise: { value: NOISE }, uHero: U.hero, uFieldC: { value: new THREE.Vector2() }, uTime: U.time, uBladeScale: { value: 1 }, uWave: U.wave, uWaveB: U.waveB, uSunDir: U.sunDir, uSunCol: U.sunCol, uGrassOn: { value: 1 }, uLite: U.lite };
function makeGrassGeo() {
  const g = new THREE.InstancedBufferGeometry();
  const P = [-1, 0, 1, 0, -0.86, 0.34, 0.86, 0.34, -0.58, 0.67, 0.58, 0.67, 0, 1], pos = new Float32Array(7 * 3);
  for (let i = 0; i < 7; i++) { pos[i * 3] = P[i * 2]; pos[i * 3 + 1] = P[i * 2 + 1]; }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex([0, 1, 2, 2, 1, 3, 2, 3, 4, 4, 3, 5, 4, 5, 6]);
  const off = new Float32Array(GRASS_MAX * 4), r = mulberry(555);
  for (let i = 0; i < GRASS_MAX; i++) { off[i * 4] = r() * FIELD; off[i * 4 + 1] = r() * FIELD; off[i * 4 + 2] = r(); off[i * 4 + 3] = r(); }
  g.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 4)); g.instanceCount = GRASS_MAX; g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  return g;
}
const grassMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88, metalness: 0, side: THREE.DoubleSide });
const grassMatLite = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
grassMat.customProgramCacheKey = () => 'grass1'; grassMatLite.customProgramCacheKey = () => 'grass1L';
const grassPatch = sh => {
  Object.assign(sh.uniforms, grassUniforms);
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', `#include <common>
attribute vec4 aOff; uniform sampler2D uHW; uniform sampler2D uCol; uniform sampler2D uNm; uniform vec3 uHero; uniform vec2 uFieldC; uniform float uTime; uniform float uBladeScale; uniform float uGrassOn; uniform float uLite;
${GLSL.noiseFn} ${GLSL.vox}
varying vec3 vWP; varying float vT; varying vec3 vGC;`)
    .replace('#include <beginnormal_vertex>', `vec3 objectNormal = vec3(0.0, 1.0, 0.0);`)
    .replace('#include <begin_vertex>', `
vec2 gp = aOff.xy + 64.0 * floor((uFieldC - aOff.xy) / 64.0 + 0.5);
float vox = voxAt(gp);
if (vox > 0.001) { float cs = mix(0.03, 1.0, pow(vox, 1.35)); gp = mix(gp, (floor(gp / cs) + 0.5) * cs, smoothstep(0.05, 0.6, vox)); }
float dist = length(gp - uHero.xz);
vec2 uvw = (gp + 64.0) / 128.0;
float gmask = textureLod(uNm, uvw, 0.0).b;
float dens = gmask * (1.0 - smoothstep(14.0, 31.0, dist) * 0.97) * mix(1.0, 0.0, smoothstep(0.1, 0.55, vox)) * uGrassOn;
float keep = step(aOff.w, dens + 0.02) * step(0.02, dens);
float gh = textureLod(uHW, (gp + 64.5) / 129.0, 0.0).r;
float clump = uLite > 0.5 ? 1.0 : 0.7 + 0.7 * nz(gp * 0.09, 0);
float hgt = (0.16 + 0.27 * fract(aOff.z * 7.13)) * clump * keep * mix(1.0, 1.25, uBladeScale - 1.0);
float ang = aOff.z * 6.2831;
vec2 dv = vec2(cos(ang), sin(ang));
float bw = 0.034 * (0.8 + 0.5 * fract(aOff.z * 13.7)) * uBladeScale * keep;
float t = position.y;
vec3 lp = vec3(position.x * bw * dv.x, t * hgt, position.x * bw * dv.y);
float ph = uTime * 1.7 + gp.x * 0.55 + gp.y * 0.4;
float wind = (sin(ph) * 0.6 + sin(ph * 2.3 + 1.7) * 0.3 + 0.25) * 0.15;
lp.xz += vec2(0.82, 0.57) * wind * t * t * hgt * 1.6;
vec2 away = gp - uHero.xz; float al = length(away); float push = smoothstep(1.3, 0.0, al);
lp.xz += away / (al + 0.001) * push * 0.55 * t * t * hgt; lp.y *= 1.0 - push * 0.35 * t;
vec3 transformed = vec3(gp.x, gh - 0.05, gp.y) + lp;
vWP = transformed; vT = t;
vGC = textureLod(uCol, uvw, 1.0).rgb * (0.82 + 0.36 * fract(aOff.z * 91.7));`);
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', `#include <common>
varying vec3 vWP; varying float vT; varying vec3 vGC; uniform vec3 uSunDir; uniform vec3 uSunCol;`)
    .replace('#include <color_fragment>', `#include <color_fragment>
diffuseColor.rgb *= vGC * mix(0.28, 1.0, pow(max(vT, 0.0), 0.75)) * (0.9 + 0.55 * vT * vT) * vec3(1.0, 1.04, 0.92);`)
    .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
normal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);`)
    .replace('#include <opaque_fragment>', `{ vec3 vd = normalize(cameraPosition - vWP); float bl = pow(max(dot(vd, -uSunDir), 0.0), 2.2); outgoingLight += diffuseColor.rgb * uSunCol * bl * 1.1 * (0.2 + vT); }
#include <opaque_fragment>`);
};
grassMat.onBeforeCompile = grassPatch; grassMatLite.onBeforeCompile = grassPatch;
const grass = new THREE.Mesh(makeGrassGeo(), grassMat); grass.frustumCulled = false; grass.receiveShadow = true; scene.add(grass);

