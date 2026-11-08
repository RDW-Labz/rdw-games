// ---- VFX toolkit: palette per element, partial-arc pool, cut streaks, beams, camera-facing ribbons, instanced projectiles, zones --------------------------------------------------------------
// Palette: Sun gold, Ember orange-red, Gust teal-white, Time violet, Shatter blue-grey (HDR values > 1 so the bloom pass lights them up on High / Medium).
const VCOL = { sun: 0xffd45a, ember: 0xff7a3a, gust: 0x6ff0e0, time: 0xa98aff, shatter: 0x9fbbd8, rainbow: 0xffffff };
const VHDR = { sun: [3.2, 2.3, 0.8], ember: [3.3, 1.15, 0.3], gust: [1.0, 2.8, 2.6], time: [1.9, 1.2, 3.5], shatter: [1.5, 2.0, 2.8] };
const _hc = new THREE.Color();
function vcol(elem, k = 1) { const h = VHDR[elem] || VHDR.sun; return _hc.setRGB(h[0] * k, h[1] * k, h[2] * k); }
// camera-facing ribbon (ported from games/colossus.html, our own code) : n points newest-first, width in metres
class GRibbon {
  constructor(n, mat, order) {
    this.n = n; this.pts = new Float32Array(n * 3); this.len = 0; const g = new THREE.BufferGeometry(); this.pos = new Float32Array(n * 2 * 3); const uv = new Float32Array(n * 2 * 2), idx = [];
    for (let i = 0; i < n; i++) { uv[i * 4] = 0; uv[i * 4 + 1] = i / (n - 1); uv[i * 4 + 2] = 1; uv[i * 4 + 3] = i / (n - 1); if (i < n - 1) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } }
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); g.setIndex(idx);
    this.mesh = new THREE.Mesh(g, mat); this.mesh.frustumCulled = false; this.mesh.renderOrder = order || 21; this.mesh.visible = false; scene.add(this.mesh); this.life = 0; this.fade = 1;
  }
  push(x, y, z) { const p = this.pts; p.copyWithin(3, 0, (this.n - 1) * 3); p[0] = x; p[1] = y; p[2] = z; if (this.len < this.n) this.len++; }
  reset() { this.len = 0; this.mesh.visible = false; }
  build(width, cx, cy, cz) {
    const n = this.len; if (n < 2) { this.mesh.visible = false; return; } const p = this.pts, o = this.pos; this.mesh.visible = true;
    for (let i = 0; i < this.n; i++) {
      const j = Math.min(i, n - 1), i0 = Math.max(0, j - 1) * 3, i1 = Math.min(n - 1, j + 1) * 3, tx = p[i1] - p[i0], ty = p[i1 + 1] - p[i0 + 1], tz = p[i1 + 2] - p[i0 + 2], vx = cx - p[j * 3], vy = cy - p[j * 3 + 1], vz = cz - p[j * 3 + 2];
      let sx = ty * vz - tz * vy, sy = tz * vx - tx * vz, sz = tx * vy - ty * vx; const l = Math.hypot(sx, sy, sz) || 1, w = width * 0.5 * (1 - i / this.n * 0.15) / l; sx *= w; sy *= w; sz *= w;
      o[i * 6] = p[j * 3] - sx; o[i * 6 + 1] = p[j * 3 + 1] - sy; o[i * 6 + 2] = p[j * 3 + 2] - sz; o[i * 6 + 3] = p[j * 3] + sx; o[i * 6 + 4] = p[j * 3 + 1] + sy; o[i * 6 + 5] = p[j * 3 + 2] + sz;
    }
    this.mesh.geometry.attributes.position.needsUpdate = true;
  }
}
function ribbonMat(rain, r, g, b) { // uv.y = age along the trail (0 newest .. 1 oldest), uv.x = across. Additive, fades to nothing at the tail.
  return new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false, uniforms: { uTime: U.time, uRain: { value: rain }, uCol: { value: new THREE.Color(r, g, b) }, uAlpha: { value: 1 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform float uTime; uniform float uRain; uniform vec3 uCol; uniform float uAlpha; varying vec2 vUv;
vec3 hsv(float h){ vec3 k = clamp(abs(fract(vec3(h) + vec3(0.0, 0.6667, 0.3333)) * 6.0 - 3.0) - 1.0, 0.0, 1.0); return k; }
void main(){ float e = smoothstep(0.0, 0.45, vUv.x) * smoothstep(1.0, 0.55, vUv.x); float a = e * pow(max(1.0 - vUv.y, 0.0), 1.5) * uAlpha; vec3 c = uRain > 0.5 ? (0.12 + 1.0 * hsv(vUv.y * 1.1 - uTime * 0.5)) * 1.7 : uCol; gl_FragColor = vec4(c, a);
#include <tonemapping_fragment>
#include <colorspace_fragment>
}` });
}
// partial-arc pool (cone shockwave chevrons, cut arcs)
const ARC_GEO = new THREE.RingGeometry(0.84, 1, 44, 1, -0.7, 1.4).rotateX(-PI / 2), ARC_POOL = []; let arcNext = 0;
for (let i = 0; i < 8; i++) { const m = new THREE.Mesh(ARC_GEO, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide, forceSinglePass: true })); m.visible = false; m.frustumCulled = false; m.renderOrder = 18; scene.add(m); ARC_POOL.push({ m, t: 0, dur: 1, r0: 1, r1: 1, op: 1, on: false }); }
function fxArc(x, y, z, yaw, r0, r1, dur, elem, op = 0.9) { const a = ARC_POOL[arcNext++ % ARC_POOL.length]; a.on = true; a.t = 0; a.dur = dur; a.r0 = r0; a.r1 = r1; a.op = op; const c = vcol(elem, 0.6); a.m.material.color.copy(c); a.m.position.set(x, y + 0.08, z); a.m.rotation.y = yaw - PI / 2; a.m.visible = true; a.m.scale.set(r0, 1, r0); return a; }
function updateArcs(dt) { for (const a of ARC_POOL) { if (!a.on) continue; a.t += dt; const k = a.t / a.dur; if (k >= 1) { a.on = false; a.m.visible = false; continue; } const e = 1 - Math.pow(1 - k, 2.2), s = a.r0 + (a.r1 - a.r0) * e; a.m.scale.set(s, 1, s); a.m.material.opacity = a.op * Math.pow(1 - k, 1.4); } }
// cut streaks: two crossed soft quads (flat + upright) so the line reads from behind, above and the side; pooled, additive, shrink + fade
const SLASH_TEX = (() => { const c = document.createElement('canvas'); c.width = 128; c.height = 32; const g = c.getContext('2d'); const v = g.createLinearGradient(0, 0, 0, 32); v.addColorStop(0, 'rgba(255,255,255,0)'); v.addColorStop(0.5, 'rgba(255,255,255,1)'); v.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = v; g.fillRect(0, 0, 128, 32);
  g.globalCompositeOperation = 'destination-in'; const h = g.createLinearGradient(0, 0, 128, 0); h.addColorStop(0, 'rgba(0,0,0,0)'); h.addColorStop(0.12, 'rgba(0,0,0,1)'); h.addColorStop(0.8, 'rgba(0,0,0,0.9)'); h.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = h; g.fillRect(0, 0, 128, 32); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; })();
const SLASH_GEO = (() => { const a = new THREE.PlaneGeometry(1, 1).rotateX(-PI / 2), b = new THREE.PlaneGeometry(1, 1); return mergeGeometries([a, b]); })(), SLASH_POOL = []; let slashNext = 0;
for (let i = 0; i < 4; i++) { const m = new THREE.Mesh(SLASH_GEO, new THREE.MeshBasicMaterial({ map: SLASH_TEX, color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide, forceSinglePass: true })); m.visible = false; m.frustumCulled = false; m.renderOrder = 19; scene.add(m); SLASH_POOL.push({ m, t: 0, dur: 1, w: 0.4, len: 1, on: false }); }
function fxSlash(x0, y0, z0, x1, y1, z1, w, dur, elem) { const s = SLASH_POOL[slashNext++ % SLASH_POOL.length], dx = x1 - x0, dz = z1 - z0, dy = y1 - y0, l = Math.hypot(dx, dy, dz) + 0.01; s.on = true; s.t = 0; s.dur = dur; s.w = w; s.len = l; s.m.material.color.copy(vcol(elem, 0.7)); s.m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2); s.m.rotation.set(0, Math.atan2(-dz, dx), Math.asin(dy / l)); s.m.visible = true; s.m.scale.set(l, w, w); }
function updateSlashes(dt) { for (const s of SLASH_POOL) { if (!s.on) continue; s.t += dt; const k = s.t / s.dur; if (k >= 1) { s.on = false; s.m.visible = false; continue; } const q = Math.pow(1 - k, 1.2); s.m.scale.set(s.len, s.w * (0.35 + 0.65 * q), s.w * (0.35 + 0.65 * q)); s.m.material.opacity = 0.95 * q; } }
// beams (ported setBeam from colossus): a unit cylinder stretched between two points, soft additive edge shader
const GBEAM_GEO = new THREE.CylinderGeometry(1, 1, 1, 14, 1, true), GBEAM_POOL = []; let gbeamNext = 0; const _bu = new THREE.Vector3(0, 1, 0), _bd = new THREE.Vector3(), _bq = new THREE.Quaternion();
for (let i = 0; i < 4; i++) { const mat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false, forceSinglePass: true, uniforms: { uTime: U.time, uCol: { value: new THREE.Color(3, 2.4, 1) }, uFade: { value: 0 } },
  vertexShader: 'varying vec3 vN; varying vec3 vV; varying float vY; void main(){ vY = position.y + 0.5; vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }',
  fragmentShader: `uniform float uTime; uniform vec3 uCol; uniform float uFade; varying vec3 vN; varying vec3 vV; varying float vY; void main(){ float f = pow(abs(dot(vN, vV)), 1.1); float s = 0.8 + 0.2 * sin(vY * 40.0 - uTime * 30.0); float e = smoothstep(0.0, 0.05, vY) * smoothstep(1.0, 0.9, vY); gl_FragColor = vec4(uCol * s, f * uFade * e * 0.85);
#include <tonemapping_fragment>
#include <colorspace_fragment>
}` }); const m = new THREE.Mesh(GBEAM_GEO, mat); m.visible = false; m.frustumCulled = false; m.renderOrder = 22; scene.add(m); GBEAM_POOL.push({ m, t: 0, dur: 1, r: 1, on: false }); }
function fxBeam(x0, y0, z0, x1, y1, z1, r, dur, elem) { const b = GBEAM_POOL[gbeamNext++ % GBEAM_POOL.length]; b.on = true; b.t = 0; b.dur = dur; b.r = r; b.m.material.uniforms.uCol.value.copy(vcol(elem, 1)); _bd.set(x1 - x0, y1 - y0, z1 - z0); const len = _bd.length() || 1; _bd.multiplyScalar(1 / len); b.m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2); _bq.setFromUnitVectors(_bu, _bd); b.m.quaternion.copy(_bq); b.len = len; b.m.scale.set(r, len, r); b.m.visible = true; b.m.material.uniforms.uFade.value = 1; }
function updateGBeams(dt) { for (const b of GBEAM_POOL) { if (!b.on) continue; b.t += dt; const k = b.t / b.dur; if (k >= 1) { b.on = false; b.m.visible = false; continue; } const q = Math.pow(1 - k, 1.5); b.m.material.uniforms.uFade.value = q; b.m.scale.set(b.r * (0.4 + 0.6 * q), b.len, b.r * (0.4 + 0.6 * q)); } }
// one-shot particle with explicit velocity (HDR colour) written straight into the shared particle pool
function pt(x, y, z, vx, vy, vz, life, size, grav, c) { const i = ptN++ % NPART; PT.x[i] = x; PT.y[i] = y; PT.z[i] = z; PT.vx[i] = vx; PT.vy[i] = vy; PT.vz[i] = vz; PT.life[i] = PT.max[i] = life; PT.size[i] = size; PT.grav[i] = grav; PCOL[i * 3] = c.r; PCOL[i * 3 + 1] = c.g; PCOL[i * 3 + 2] = c.b; }
function ptSuck(x, y, z, n, r, life, size, elem) { for (let k = 0; k < n; k++) { const a = Math.random() * TAU, u = Math.random() * 2 - 1, s = Math.sqrt(1 - u * u), q = r * (0.6 + Math.random() * 0.5); pt(x + Math.cos(a) * s * q, y + u * q, z + Math.sin(a) * s * q, -Math.cos(a) * s * q / life * 1.6, -u * q / life * 1.6, -Math.sin(a) * s * q / life * 1.6, life, size, 0, vcol(elem, 1)); } }
function ptRing(x, y, z, n, r, vup, life, size, c, vr = 0) { for (let k = 0; k < n; k++) { const a = k / n * TAU; pt(x + Math.cos(a) * r, y, z + Math.sin(a) * r, Math.cos(a) * vr, vup, Math.sin(a) * vr, life, size, -1, c); } }

