// ---- geometry: per column = top quad + two skirt quads (+x edge, +z edge) --------------------------------------------
function buildTerrainGeo() {
  const nC = GRID * GRID, pos = new Float32Array(nC * 12 * 3), nor = new Float32Array(nC * 12 * 3), cel = new Float32Array(nC * 12 * 2), av = new Float32Array(nC * 12 * 4), idx = new Uint32Array(nC * 18);
  let v = 0, ii = 0;
  const put = (i, j, cx, cz, kind, bot) => { const o = v * 3; pos[o] = i + cx - HALF; pos[o + 1] = 0; pos[o + 2] = j + cz - HALF; nor[o + 1] = 1; cel[v * 2] = i; cel[v * 2 + 1] = j; av[v * 4] = cx; av[v * 4 + 1] = cz; av[v * 4 + 2] = kind; av[v * 4 + 3] = bot; v++; };
  for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) {
    let b = v; put(i, j, 0, 0, 0, 0); put(i, j, 1, 0, 0, 0); put(i, j, 0, 1, 0, 0); put(i, j, 1, 1, 0, 0);
    idx.set([b, b + 1, b + 2, b + 2, b + 1, b + 3], ii); ii += 6;
    b = v; put(i, j, 1, 0, 1, 0); put(i, j, 1, 1, 1, 0); put(i, j, 1, 0, 1, 1); put(i, j, 1, 1, 1, 1);
    idx.set([b, b + 2, b + 1, b + 1, b + 2, b + 3], ii); ii += 6;
    b = v; put(i, j, 0, 1, 2, 0); put(i, j, 1, 1, 2, 0); put(i, j, 0, 1, 2, 1); put(i, j, 1, 1, 2, 1);
    idx.set([b, b + 2, b + 1, b + 1, b + 2, b + 3], ii); ii += 6;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('aCell', new THREE.BufferAttribute(cel, 2)); g.setAttribute('aV', new THREE.BufferAttribute(av, 4)); g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 20, 0), 200); g.boundingBox = new THREE.Box3(new THREE.Vector3(-70, -80, -70), new THREE.Vector3(70, 60, 70));
  return g;
}
const terrMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.94, metalness: 0, side: THREE.DoubleSide });
terrMat.customProgramCacheKey = () => 'terr1';
terrMat.onBeforeCompile = sh => {
  Object.assign(sh.uniforms, { uHS: { value: texHS }, uQH: { value: texQH }, uDrop: { value: texDrop }, uCol: { value: texCol }, uNm: { value: texNm }, uNoise: { value: NOISE }, uWave: U.wave, uWaveB: U.waveB, uLite: U.liteT });
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', `#include <common>
uniform sampler2D uHS; uniform sampler2D uQH; uniform sampler2D uDrop; ${GLSL.vox}
attribute vec2 aCell; attribute vec4 aV;
varying vec3 vWP; varying float vVoxT; varying float vDr; varying float vWallT; varying float vWallB;
flat varying float vKind; flat varying vec2 vOwner; flat varying vec3 vWN;`)
    .replace('#include <begin_vertex>', `
vec3 transformed;
{
  ivec2 ic = ivec2(aCell); ivec2 cor = ivec2(aV.xy); float kind = aV.z; float isBot = aV.w;
  float hs = texelFetch(uHS, ic + cor, 0).r;
  float vxA = voxAt(aCell - 64.0 + 0.5);
  float drA = texelFetch(uDrop, ic, 0).r;
  float hqA = texelFetch(uQH, ic, 0).r - drA;
  float yA = mix(hs, hqA, vxA); float y = yA;
  vWallT = yA; vWallB = yA; vKind = kind; vOwner = aCell; vWN = vec3(0., 1., 0.); vVoxT = vxA; vDr = drA;
  if (kind > 0.5) {
    ivec2 nb = min(ic + (kind < 1.5 ? ivec2(1, 0) : ivec2(0, 1)), ivec2(127));
    float vxB = voxAt(vec2(nb) - 64.0 + 0.5);
    float hqB = texelFetch(uQH, nb, 0).r - texelFetch(uDrop, nb, 0).r;
    float yB = mix(hs, hqB, vxB);
    float yT = max(yA, yB), yL = min(yA, yB);
    y = isBot > 0.5 ? yL : yT; vWallT = yT; vWallB = yL;
    bool aHigh = yA >= yB; vOwner = aHigh ? aCell : vec2(nb);
    vec3 sd = kind < 1.5 ? vec3(1., 0., 0.) : vec3(0., 0., 1.); vWN = aHigh ? sd : -sd; vVoxT = max(vxA, vxB);
  }
  transformed = vec3(position.x, y, position.z); vWP = transformed;
}`);
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', `#include <common>
uniform sampler2D uCol; uniform sampler2D uNm; uniform float uLite; ${GLSL.noiseFn} ${GLSL.vox}
varying vec3 vWP; varying float vVoxT; varying float vDr; varying float vWallT; varying float vWallB;
flat varying float vKind; flat varying vec2 vOwner; flat varying vec3 vWN;`)
    .replace('#include <map_fragment>', `
float vox = clamp(vVoxT, 0.0, 1.0);
bool isWall = vKind > 0.5;
vec2 uvw = (vWP.xz + 64.0) / 128.0;
vec4 nmS = texture(uNm, uvw);
vec2 nxz = nmS.rg * 2.0 - 1.0;
vec3 nSm = normalize(vec3(nxz.x, sqrt(max(1.0 - dot(nxz, nxz), 0.0001)), nxz.y));
float d1 = 0.5, d2 = nz(vWP.xz * 1.31, 1), d3 = 0.5;
if (uLite < 0.5) { d1 = nz(vWP.xz * 0.23, 0); d3 = nz(vWP.xz * 5.7, 2); }
vec3 aSm = texture(uCol, uvw).rgb * (0.80 + 0.46 * (d1 * 0.4 + d2 * 0.35 + d3 * 0.25));
// fine micro-normal from the detail noise (grass tufts / pebbles read as relief even when blurry)
if (uLite < 0.25) { float e = 0.012; float gx = nz(vWP.xz * 1.31 + vec2(e, 0.), 1) - nz(vWP.xz * 1.31 - vec2(e, 0.), 1); float gz = nz(vWP.xz * 1.31 + vec2(0., e), 1) - nz(vWP.xz * 1.31 - vec2(0., e), 1);
  float gx2 = nz(vWP.xz * 5.7 + vec2(e, 0.), 2) - nz(vWP.xz * 5.7 - vec2(e, 0.), 2); float gz2 = nz(vWP.xz * 5.7 + vec2(0., e), 2) - nz(vWP.xz * 5.7 - vec2(0., e), 2);
  nSm = normalize(nSm + vec3(-(gx * 1.4 + gx2 * 1.1), 0.0, -(gz * 1.4 + gz2 * 1.1)) * 1.6); }
vec3 colT = aSm;
if (vox > 0.001 || isWall) {
  float cs = mix(0.03, 1.0, pow(vox, 1.35));
  vec2 pq = (floor(vWP.xz / cs) + 0.5) * cs;
  vec3 aV = textureLod(uCol, (pq + 64.0) / 128.0, log2(max(cs * 8.0, 1.0))).rgb;
  float ph = hash13(vec3(floor(vWP.xz * 8.0), 3.0));
  float cv = hash13(vec3(floor(vWP.xz), 9.0));
  vec2 fq = fract(vWP.xz); float ed = min(min(fq.x, 1.0 - fq.x), min(fq.y, 1.0 - fq.y));
  aV *= (0.92 + 0.16 * cv) * (0.95 + 0.1 * ph) * mix(0.74, 1.0, smoothstep(0.0, 0.07, ed)) * mix(1.0, 0.66, nmS.b);
  colT = mix(aSm, aV, smoothstep(0.02, 0.6, vox));
  if (vDr > 0.5 && !isWall) { vec3 dirtT = vec3(0.5, 0.31, 0.17) * (0.8 + 0.4 * ph); colT = mix(colT, dirtT, smoothstep(0.5, 0.9, vDr)); }
}
if (isWall) {
  vec3 topC = textureLod(uCol, (vOwner + 0.5) / 128.0, 3.0).rgb;
  float dep = vWallT - vWP.y;
  float tang = vKind < 1.5 ? vWP.z : vWP.x;
  float pxh = hash13(vec3(floor(tang * 8.0), floor(vWP.y * 8.0), dot(vOwner, vec2(7., 13.))));
  vec3 dirt = vec3(0.20, 0.115, 0.06), rock = vec3(0.13, 0.115, 0.105);
  vec3 side = mix(dirt, rock, smoothstep(0.9, 5.0, dep)) * (0.82 + 0.34 * pxh);
  float gf = 1.0 - smoothstep(0.16, 0.4, dep + (pxh - 0.5) * 0.2);
  colT = mix(side, topC * (0.8 + 0.2 * pxh), gf);
  colT *= mix(0.5, 1.0, smoothstep(0.0, 1.2, vWP.y - vWallB));
}
diffuseColor.rgb *= colT;`)
    .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{ vec3 nw = isWall ? vWN : normalize(mix(nSm, vec3(0., 1., 0.), smoothstep(0.05, 0.7, vox)));
  normal = normalize((viewMatrix * vec4(nw, 0.0)).xyz); }`)
    .replace('#include <opaque_fragment>', `outgoingLight = voxPost(outgoingLight, vox, gl_FragCoord.xy); outgoingLight += vec3(1.0, 0.8, 0.42) * ringAt(vWP.xz) * 0.3;
#include <opaque_fragment>`);
};
const geoFull = buildTerrainGeo();
const geoTop = (() => { const g = new THREE.BufferGeometry(); for (const n of ['position', 'normal', 'aCell', 'aV']) g.setAttribute(n, geoFull.getAttribute(n)); const idx = new Uint32Array(GRID * GRID * 6); let k = 0; for (let c = 0; c < GRID * GRID; c++) { const b = c * 12; idx[k++] = b; idx[k++] = b + 1; idx[k++] = b + 2; idx[k++] = b + 2; idx[k++] = b + 1; idx[k++] = b + 3; } g.setIndex(new THREE.BufferAttribute(idx, 1)); g.boundingSphere = geoFull.boundingSphere; g.boundingBox = geoFull.boundingBox; return g; })();
const terrain = new THREE.Mesh(geoTop, terrMat); // skirts only exist (and are only drawn) while the voxel morph is active
function updateTerrainGeo() { const want = (WV.R1 >= 0 || dropActive || collapsing || (typeof SH !== 'undefined' && SH.on)) ? geoFull : geoTop; if (terrain.geometry !== want) terrain.geometry = want; }
terrain.frustumCulled = false; terrain.receiveShadow = true; terrain.castShadow = false;
scene.add(terrain);

