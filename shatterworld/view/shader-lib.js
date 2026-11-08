// ---------------------------------------------------------------------------
// shared shader uniforms + GLSL library: the voxel-morph field uVox(x) is a function of distance to the shockwave wavefront
// ---------------------------------------------------------------------------
const U = {
  lite: { value: 0 },
  liteT: { value: 0 },  // terrain detail level: = lite in flat play; 0.4 in VR (detail colour on, 8-fetch micro-normal off)
  time: { value: 0 },
  wave: { value: new THREE.Vector4(0, 0, -1, -1) },   // centre x, centre z, R1 (voxelise front), R2 (heal front)
  waveB: { value: new THREE.Vector4(9, 0, 0, 0) },     // band width, ring glow, flat-look amount, -
  hero: { value: new THREE.Vector3() },
  sunDir: { value: new THREE.Vector3(-0.55, 0.42, -0.72).normalize() },
  sunCol: { value: new THREE.Color(1.0, 0.78, 0.5) },
};
const WV = { x: 0, z: 0, R1: -1, R2: -1, band: 9, glow: 0 }; // CPU mirror of the uniforms
function syncWave() { U.wave.value.set(WV.x, WV.z, WV.R1, WV.R2); U.waveB.value.set(WV.band, WV.glow, 0, 0); }
function voxAtCPU(x, z) { // must mirror GLSL voxAt()
  if (WV.R1 < 0) return 0;
  const d = Math.hypot(x - WV.x, z - WV.z) + 2.2 * Math.sin(x * 0.21 + z * 0.13) * Math.sin(z * 0.19 - x * 0.11);
  const a = 1 - sstep(WV.R1 - WV.band, WV.R1, d);
  const h = WV.R2 > 0 ? 1 - sstep(WV.R2 - WV.band, WV.R2, d) : 0;
  return a * (1 - h);
}
const GLSL = {};
GLSL.vox = `
uniform vec4 uWave; uniform vec4 uWaveB;
float voxAt(vec2 p){
  if (uWave.z < 0.0) return 0.0;
  float d = length(p - uWave.xy) + 2.2 * sin(p.x * 0.21 + p.y * 0.13) * sin(p.y * 0.19 - p.x * 0.11);
  float b = uWaveB.x;
  float a = 1.0 - smoothstep(uWave.z - b, uWave.z, d);
  float h = uWave.w > 0.0 ? 1.0 - smoothstep(uWave.w - b, uWave.w, d) : 0.0;
  return a * (1.0 - h);
}
float ringAt(vec2 p){
  if (uWave.z < 0.0) return 0.0;
  float d = length(p - uWave.xy) + 2.2 * sin(p.x * 0.21 + p.y * 0.13) * sin(p.y * 0.19 - p.x * 0.11);
  float q1 = (d - uWave.z + uWaveB.x * 0.3) / (uWaveB.x * 0.22); float r1 = exp(-q1 * q1);
  float q2 = (d - uWave.w + uWaveB.x * 0.3) / (uWaveB.x * 0.22); float r2 = uWave.w > 0.0 ? exp(-q2 * q2) * 0.6 : 0.0;
  return (r1 + r2) * uWaveB.y;
}
float bayer4(vec2 p){
  int x = int(mod(p.x, 4.0)); int y = int(mod(p.y, 4.0)); int i = x + y * 4;
  float t[16] = float[16](0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.);
  return t[i] / 16.0 - 0.47;
}
vec3 snrm(vec3 v){ float l = dot(v, v); return l > 1e-18 ? v * inversesqrt(l) : vec3(0.0, 1.0, 0.0); }
float hash13(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
vec3 voxPost(vec3 c, float vox, vec2 frag){
  if (vox < 0.02) return c;
  vec3 ex = max(c - 1.0, 0.0); c = min(c, vec3(1.0));
  float lv = mix(255.0, 5.0, smoothstep(0.12, 0.97, vox));
  float amp = sin(clamp(vox, 0.0, 1.0) * 3.14159) * 0.95 + 0.12 * vox;
  vec3 g = pow(max(c, vec3(0.0)), vec3(0.4545));
  g += bayer4(frag) * amp / lv * 1.6;
  g = floor(g * lv + 0.5) / lv;
  return pow(clamp(g, 0.0, 1.0), vec3(2.2)) + ex;
}
`;

// generic voxel-morph patch for any MeshStandardMaterial (trees, rocks, ruins): vertex snap to a 3D grid whose cell size
// animates with uVox, axis-snapped face normals, cell-hash colour, grid bevel lines, posterise + Bayer dither.
function patchVox(mat, o = {}) {
  const cs = (o.cs || 1).toFixed(3);
  mat.customProgramCacheKey = () => 'vox' + cs + (o.leaf ? 'L' : '') + (o.moss ? 'M' : '');
  mat.onBeforeCompile = sh => {
    sh.uniforms.uWave = U.wave; sh.uniforms.uWaveB = U.waveB; sh.uniforms.uNoise = { value: NOISE };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${GLSL.vox}\nvarying float vVox; varying vec3 vWP;`)
      .replace('#include <project_vertex>', `#include <project_vertex>
{ vec4 wp4 = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
  wp4 = instanceMatrix * wp4;
  #endif
  wp4 = modelMatrix * wp4;
  float vx = voxAt(wp4.xz); vVox = vx; vWP = wp4.xyz;
  if (vx > 0.001) { float cs = mix(0.03, ${cs}, smoothstep(0.0, 1.0, vx)); vec3 sn = floor(wp4.xyz / cs + 0.5) * cs;
    vec3 dl = (sn - wp4.xyz) * smoothstep(0.04, 0.85, vx);
    mvPosition.xyz += (viewMatrix * vec4(dl, 0.0)).xyz; gl_Position = projectionMatrix * mvPosition; vWP += dl; } }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${GLSL.vox}\nuniform sampler2D uNoise;\nvarying float vVox; varying vec3 vWP;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
${o.leaf ? 'diffuseColor.rgb *= 0.78 + 0.5 * texture(uNoise, vWP.xz * 0.9 + vWP.y * vec2(0.37, 0.61)).r + 0.2 * texture(uNoise, vWP.xz * 3.1 + vWP.y * 1.3).g - 0.1;' : ''}
${o.moss ? 'diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16, 0.3, 0.07) * (0.7 + 0.6 * texture(uNoise, vWP.xz * 0.7).b), smoothstep(0.55, 0.85, snrm(cross(dFdx(vWP), dFdy(vWP))).y) * smoothstep(0.35, 0.65, texture(uNoise, vWP.xz * 0.35 + 3.0).a) * 0.85);' : ''}
vec3 vxN = snrm(cross(dFdx(vWP), dFdy(vWP)));
{ vec3 a = abs(vxN); vxN = a.x > a.y && a.x > a.z ? vec3(sign(vxN.x), 0., 0.) : (a.y > a.z ? vec3(0., sign(vxN.y), 0.) : vec3(0., 0., sign(vxN.z))); }
float vxK = smoothstep(0.08, 0.7, vVox);
if (vxK > 0.001) {
  vec3 q = vWP / ${cs}; vec3 fq = fract(q); vec3 dd = min(fq, 1.0 - fq) + abs(vxN) * 10.0; float ed = min(min(dd.x, dd.y), dd.z);
  float h = hash13(floor(q - vxN * 0.5));
  diffuseColor.rgb *= mix(1.0, (0.9 + h * 0.2) * mix(0.72, 1.0, smoothstep(0.0, 0.09, ed)), vxK); }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
if (vxK > 0.001) { vec3 nv = normalize((viewMatrix * vec4(vxN, 0.0)).xyz); normal = normalize(mix(normal, nv, vxK)); }`)
      .replace('#include <opaque_fragment>', `outgoingLight = voxPost(outgoingLight, vVox, gl_FragCoord.xy); outgoingLight += vec3(1.0, 0.78, 0.4) * ringAt(vWP.xz) * 0.3;
#include <opaque_fragment>`);
  };
  return mat;
}

// tileable noise texture (RGBA = four independent smooth fbm channels) shared by sky, water, terrain detail
function makeNoiseTex(N = 256) {
  const data = new Uint8Array(N * N * 4), r = mulberry(4242);
  for (let ch = 0; ch < 4; ch++) {
    const out = new Float32Array(N * N);
    let amp = 1, tot = 0;
    for (let oct = 0; oct < 5; oct++) {
      const G = 4 << oct, g = new Float32Array(G * G); for (let i = 0; i < g.length; i++) g[i] = r();
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const fx = x / N * G, fy = y / N * G, x0 = Math.floor(fx), y0 = Math.floor(fy); let tx = fx - x0, ty = fy - y0; tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
        const a = g[(y0 % G) * G + x0 % G], b = g[(y0 % G) * G + (x0 + 1) % G], c = g[((y0 + 1) % G) * G + x0 % G], d = g[((y0 + 1) % G) * G + (x0 + 1) % G];
        out[y * N + x] += amp * lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
      }
      tot += amp; amp *= 0.5;
    }
    for (let i = 0; i < N * N; i++) data[i * 4 + ch] = clamp(out[i] / tot * 255 * 1.25 - 32, 0, 255);
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = true; t.needsUpdate = true; return t;
}
const NOISE = makeNoiseTex(256);
GLSL.noiseFn = `uniform sampler2D uNoise;
float nz(vec2 p, int ch){ vec4 t = texture(uNoise, p); return ch == 0 ? t.r : ch == 1 ? t.g : ch == 2 ? t.b : t.a; }`;

