// ============================================================================
// THE CUBE POOL - one InstancedMesh; every cube is a pooled slot with ballistic / spring / settled / ambient / rewind states.
// ============================================================================
const MAXC = 48000;
const C = { // struct-of-arrays
  x: new Float32Array(MAXC), y: new Float32Array(MAXC), z: new Float32Array(MAXC), vx: new Float32Array(MAXC), vy: new Float32Array(MAXC), vz: new Float32Array(MAXC),
  qx: new Float32Array(MAXC), qy: new Float32Array(MAXC), qz: new Float32Array(MAXC), qw: new Float32Array(MAXC), wx: new Float32Array(MAXC), wy: new Float32Array(MAXC), wz: new Float32Array(MAXC),
  s: new Float32Array(MAXC), ts: new Float32Array(MAXC), r: new Float32Array(MAXC), g: new Float32Array(MAXC), b: new Float32Array(MAXC),
  r0: new Float32Array(MAXC), g0: new Float32Array(MAXC), b0: new Float32Array(MAXC), tr: new Float32Array(MAXC), tg: new Float32Array(MAXC), tb: new Float32Array(MAXC),
  tx: new Float32Array(MAXC), ty: new Float32Array(MAXC), tz: new Float32Array(MAXC), hx: new Float32Array(MAXC), hy: new Float32Array(MAXC), hz: new Float32Array(MAXC),
  delay: new Float32Array(MAXC), age: new Float32Array(MAXC), d0: new Float32Array(MAXC), vox: new Float32Array(MAXC), glow: new Float32Array(MAXC), pop: new Float32Array(MAXC), tgl: new Float32Array(MAXC),
  st: new Uint8Array(MAXC), rew: new Uint8Array(MAXC), owner: new Int32Array(MAXC), aoA: new Float32Array(MAXC), aoB: new Float32Array(MAXC), grp: new Int32Array(MAXC),
};
const ST = { FREE: 0, BALL: 1, REST: 2, FLY: 3, SET: 4, AMB: 5, POP: 6, REW: 7, DIE: 8, HOMED: 9, STRM: 10, ROT: 11 };
let cubeHi = 0, cubeLive = 0; const freeStack = new Int32Array(MAXC); let freeN = 0;
const cubeGeo = (() => {
  const g = new THREE.BoxGeometry(1, 1, 1); const n = g.attributes.position.count, corner = new Float32Array(n); for (let i = 0; i < n; i++) corner[i] = i; g.setAttribute('aCorner', new THREE.BufferAttribute(corner, 1)); return g;
})();
// per-vertex AO lookup tables derived from the box geometry itself
const AOT = (() => { const p = cubeGeo.attributes.position, nrm = cubeGeo.attributes.normal, out = []; for (let k = 0; k < 24; k++) { const n = [Math.round(nrm.getX(k)), Math.round(nrm.getY(k)), Math.round(nrm.getZ(k))], o = [p.getX(k) > 0 ? 1 : -1, p.getY(k) > 0 ? 1 : -1, p.getZ(k) > 0 ? 1 : -1]; const na = n[0] ? 0 : n[1] ? 1 : 2, ta = (na + 1) % 3, tb = (na + 2) % 3; out.push({ n, na, ta, tb, sa: o[ta], sb: o[tb] }); } return out; })();
const cubeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.72, metalness: 0.0 });
cubeMat.customProgramCacheKey = () => 'cubes1';
cubeMat.onBeforeCompile = sh => {
  Object.assign(sh.uniforms, { uWave: U.wave, uWaveB: U.waveB, uTime: U.time });
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', `#include <common>
${GLSL.vox}
attribute float aCorner; attribute vec2 aAO; attribute vec2 aFx; uniform float uTime;
varying float vAO; varying vec2 vFx; varying vec2 vFUv; varying vec3 vCC; varying vec3 vWP; varying float vFace; varying float vVoxW;`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>
{ vec3 ccw = instanceMatrix[3].xyz; float cdist = length(ccw - cameraPosition); float shr = smoothstep(0.9, 3.4, cdist); transformed *= shr; }`)
    .replace('#include <project_vertex>', `#include <project_vertex>
{ int k = int(aCorner + 0.5); int face = k / 4; int cor = k - face * 4;
  int packed = face < 3 ? int(aAO.x + 0.5) : int(aAO.y + 0.5); int sh = (face - (face < 3 ? 0 : 3)) * 8 + cor * 2; int lvl = (packed >> sh) & 3;
  vAO = 1.0 - float(lvl) * 0.2; vFx = aFx; vFUv = uv; vFace = float(face); vCC = instanceMatrix[3].xyz; vWP = (instanceMatrix * vec4(transformed, 1.0)).xyz; vVoxW = voxAt(vCC.xz); }`)
  ;
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', `#include <common>
${GLSL.vox}
uniform float uTime; varying float vAO; varying vec2 vFx; varying vec2 vFUv; varying vec3 vCC; varying vec3 vWP; varying float vFace; varying float vVoxW;`)
    .replace('#include <color_fragment>', `#include <color_fragment>
float vxK = max(vFx.x, vVoxW);
{ vec2 pxi = floor(vFUv * 8.0); float ph = hash13(vec3(pxi, dot(vCC, vec3(1.0, 7.0, 13.0)) + vFace * 3.7));
  float ps = 0.06 + 0.1 * vxK; diffuseColor.rgb *= 1.0 - ps + 2.0 * ps * ph;
  vec2 e = min(vFUv, 1.0 - vFUv); float ed = min(e.x, e.y);
  float bevel = mix(0.8, 1.0, smoothstep(0.0, 0.055, ed)); diffuseColor.rgb *= mix(1.0, bevel, 0.6 + 0.4 * vxK);
  diffuseColor.rgb *= vAO; }`)
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{ float gl = vFx.y; if (gl > 0.001) { float an = gl >= 10.0 ? 0.55 + 0.45 * sin(uTime * 2.4 + vCC.x * 0.6 + vCC.z * 0.45 + vCC.y * 0.3) : 1.0; gl = gl >= 10.0 ? gl - 10.0 : gl; totalEmissiveRadiance += diffuseColor.rgb * gl * an * 1.45; } }`)
    .replace('#include <opaque_fragment>', `outgoingLight = voxPost(outgoingLight, vxK, gl_FragCoord.xy); outgoingLight += vec3(1.0, 0.8, 0.42) * ringAt(vCC.xz) * 0.6;
#include <opaque_fragment>`);
};
const cubeMesh = new THREE.InstancedMesh(cubeGeo, cubeMat, MAXC); cubeMesh.count = 0; cubeMesh.frustumCulled = false; cubeMesh.castShadow = true; cubeMesh.receiveShadow = true;
cubeMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAXC * 3), 3);
const aoAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAXC * 2), 2), fxAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAXC * 2), 2);
cubeGeo.setAttribute('aAO', aoAttr); cubeGeo.setAttribute('aFx', fxAttr);
scene.add(cubeMesh);
const IM = cubeMesh.instanceMatrix.array, IC = cubeMesh.instanceColor.array, IAO = aoAttr.array, IFX = fxAttr.array;
let cubesDirty = false, cubesStatic = false;

function allocCube() {
  if (cubeLive >= Q.cap) return -1; let i; if (freeN > 0) i = freeStack[--freeN]; else if (cubeHi < MAXC) i = cubeHi++; else return -1;
  cubeLive++; if (i >= cubeMesh.count) cubeMesh.count = i + 1; C.st[i] = ST.BALL; C.rew[i] = 0; C.tgl[i] = 0; C.owner[i] = -1; C.grp[i] = -1; C.qx[i] = C.qy[i] = C.qz[i] = 0; C.qw[i] = 1; C.wx[i] = C.wy[i] = C.wz[i] = 0; C.s[i] = C.ts[i] = 1; C.vox[i] = 0; C.glow[i] = 0; C.pop[i] = 0; C.aoA[i] = C.aoB[i] = 0; C.delay[i] = 0; C.age[i] = 0; return i;
}
function freeCube(i) {
  if (C.st[i] === ST.FREE) return; C.st[i] = ST.FREE; cubeLive--; freeStack[freeN++] = i; const o = i * 16; IM[o] = IM[o + 5] = IM[o + 10] = 0; IM[o + 15] = 1; IM[o + 12] = 0; IM[o + 13] = -9999; IM[o + 14] = 0; cubesDirty = true;
}
function freeAllCubes() { for (let i = 0; i < cubeHi; i++) if (C.st[i] !== ST.FREE) freeCube(i); cubeHi = 0; freeN = 0; cubeLive = 0; cubeMesh.count = 0; cubesDirty = true; }
function writeCube(i) {
  const o = i * 16, s = C.s[i] * (1 + C.pop[i]), x = C.qx[i], y = C.qy[i], z = C.qz[i], w = C.qw[i];
  const x2 = x + x, y2 = y + y, z2 = z + z, xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  IM[o] = (1 - (yy + zz)) * s; IM[o + 1] = (xy + wz) * s; IM[o + 2] = (xz - wy) * s; IM[o + 3] = 0; IM[o + 4] = (xy - wz) * s; IM[o + 5] = (1 - (xx + zz)) * s; IM[o + 6] = (yz + wx) * s; IM[o + 7] = 0;
  IM[o + 8] = (xz + wy) * s; IM[o + 9] = (yz - wx) * s; IM[o + 10] = (1 - (xx + yy)) * s; IM[o + 11] = 0; IM[o + 12] = C.x[i]; IM[o + 13] = C.y[i]; IM[o + 14] = C.z[i]; IM[o + 15] = 1;
  IC[i * 3] = C.r[i]; IC[i * 3 + 1] = C.g[i]; IC[i * 3 + 2] = C.b[i]; IFX[i * 2] = C.vox[i]; IFX[i * 2 + 1] = C.glow[i];
}
function setCubeAO(i, a, b) { C.aoA[i] = a; C.aoB[i] = b; IAO[i * 2] = a; IAO[i * 2 + 1] = b; aoAttr.needsUpdate = true; }
function setCubeTransform(i, x, y, z, s, r, g, b) { C.x[i] = x; C.y[i] = y; C.z[i] = z; C.s[i] = C.ts[i] = s; C.r[i] = r; C.g[i] = g; C.b[i] = b; }

