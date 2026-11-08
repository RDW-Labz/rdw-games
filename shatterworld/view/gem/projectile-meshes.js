// ---- instanced projectiles: cube (box) / orb (sphere: orbs, bolts, meteors) / shard (octahedron). One draw call each while any is alive. ------------------------------------------------------------
const PJN = 28, PJ = [];
for (let i = 0; i < PJN; i++) PJ.push({ on: false, kind: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, R: null, mul: 1, rad: 1, pierce: 0, hitN: 0, hits: [null, null, null, null, null, null, null, null], chain: 0, fork: 0, forked: false, bounces: 0, t: 0, phase: 0, sc: 1, rot: 0, trail: 0, spd: 0, ox: 0, oz: 0, dist: 0, elem: 'shatter', gy: 0 });
const PJM = {}; { const mk = (geo, mat) => { const m = new THREE.InstancedMesh(geo, mat, PJN); m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(PJN * 3), 3); m.frustumCulled = false; m.count = 0; m.visible = false; m.renderOrder = 20; scene.add(m); return m; };
  PJM.cube = mk(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.1, emissive: 0x8fb0d8, emissiveIntensity: 1.5 })); PJM.orb = mk(new THREE.SphereGeometry(1, 12, 9), new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false, toneMapped: false })); PJM.shard = mk(new THREE.OctahedronGeometry(1, 0), new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false, toneMapped: false })); }
const _pjD = new THREE.Object3D(), _pjC = new THREE.Color();
function pjAlloc() { for (let i = 0; i < PJN; i++) if (!PJ[i].on) return PJ[i]; return null; }
function pjSpawn(kind, R, x, y, z, vx, vy, vz, mul, o) {
  const p = pjAlloc(); if (!p) return null; p.on = true; p.kind = kind; p.R = R; p.mul = mul; p.x = x; p.y = y; p.z = z; p.vx = vx; p.vy = vy; p.vz = vz; p.hitN = 0; p.t = 0; p.phase = 0; p.forked = false; p.rot = Math.random() * 6; p.trail = 0; p.ox = x; p.oz = z; p.dist = 0; p.spd = Math.hypot(vx, vz);
  p.pierce = R ? R.pierce : 0; p.chain = R ? R.chain : 0; p.fork = R ? R.fork : 0; p.elem = R ? R.elem : 'ember'; p.rad = 1; p.sc = 0.3; p.life = 3; p.bounces = 0; p.gy = y; if (o) Object.assign(p, o); return p;
}
function pjHasHit(p, e) { for (let i = 0; i < p.hitN; i++) if (p.hits[i] === e) return true; return false; }
function pjAddHit(p, e) { if (p.hitN < 8) p.hits[p.hitN++] = e; }
function gemOk(e) { return e.alive && e.state !== 'dead' && e.state !== 'squash'; }

