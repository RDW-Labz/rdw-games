// ============================================================================
// WEBXR / VR - Quest Browser first (Touch controllers, optional hand pinch), also PC-VR through desktop Chrome.
//  * DIORAMA camera: the rig (dolly) is scaled by S so the world is a ~14 cm-hero tabletop; the table follows the hero (heavily damped, XZ),
//    right stick snap-turns the rig, the headset yaw drives the stick-relative movement. No shake / roll / forced camera moves (the flat chase-cam is NOT used).
//  * input feeds the SAME code paths as keyboard / phone pad (keys, padFire, padPlace) plus an analog stick vector (VRIN).
//  * DOM overlays are invisible in immersive-vr: world-space UI (wrist panel, laser-clickable menu / pause / fail / win panel, how-to panel, caption panel).
//  * every object here is built lazily on the first VR entry; nothing in this block runs during flat play except a few boolean checks.
// ============================================================================
const VRT = TUNING.vr;
const _va = new THREE.Vector3(), _vb = new THREE.Vector3(), _vc = new THREE.Vector3(), _vq = new THREE.Quaternion();
const vrNoop = () => { };
const vrCfg = { size: VRT.sizeDefault, snap: 1, q: 'vr' }; // persisted: table size index, snap(1)/smooth(0) turning, VR graphics tier
try { const o = JSON.parse(localStorage.getItem('swn_vr') || 'null'); if (o) { if (o.size >= 0 && o.size < VRT.scales.length) vrCfg.size = o.size | 0; vrCfg.snap = o.snap ? 1 : 0; if (o.q === 'vrlite') vrCfg.q = 'vrlite'; } } catch (e) { }
function vrSaveCfg() { try { localStorage.setItem('swn_vr', JSON.stringify(vrCfg)); } catch (e) { } }
function vrFbScale() { let v = VRT.fbScale; try { const u = parseFloat(new URLSearchParams(location.search).get('vrscale')); if (u >= 0.5 && u <= 1.5) v = u; } catch (e) { } return v; }
Object.assign(VR, {
  prompt: false, built: false, lift: 0, fy: 0, wasPlay: false, headOk: false, needAnchor: true, snapFollow: true, first: true, floorY: 0,
  hpx: 0, hpy: 1.6, hpz: 0, gx: 0, gz: -1, ax: 0, ay: 0.9, az: -0.6, hx: 0, hy: 0, hz: 0, gy: 0, lpx: 0, lpy: 0, lpz: 0,
  snapArmed: true, turns: 0, haptics: 0, fire: false, place: false, fireHand: 1, eT: 0, xHold: 0, xDone: false, fade: 0, capAng: 0,
  pinch: [false, false], perfT: 0, perfN: 0, avgMs: 0, autoLite: false, soft: false, prevQ: 'high', sessionFeatures: '', gazeLocked: false,
  yArm: '', yDone: false, wasRp: false, eKey: false, // RPG in VR: Y hold = inventory (state at press / hold fired), previous inv-or-perk flag, 'e' injected by the right-stick click
});
