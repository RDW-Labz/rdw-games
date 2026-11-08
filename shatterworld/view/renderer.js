// ---------------------------------------------------------------------------
// renderer + quality tiers
// ---------------------------------------------------------------------------
const QUALITY = {
  high:   { pr: 2,   shadow: 2048, bloom: 1, bloomRes: 1,   msaa: 4, cap: 48000, grass: 110000, water: 2, god: 1, trees: 1,    tex: 1024, lite: 0 },
  medium: { pr: 1.5, shadow: 1024, bloom: 1, bloomRes: 0.5, msaa: 0, cap: 30000, grass: 55000,  water: 1, god: 1, trees: 0.75, tex: 1024, lite: 0 },
  low:    { pr: 1,   shadow: 0,    bloom: 0, bloomRes: 0.5, msaa: 0, cap: 14000, grass: 9000,   water: 0, god: 0, trees: 0.4,  tex: 512, lite: 1 },
  // VR tiers (never persisted, never reachable from the flat quality cycle): no composer / bloom / god rays, one small shadow map, trimmed particles + cube cap + grass
  vr:     { pr: 1,   shadow: 1024, bloom: 0, bloomRes: 0.5, msaa: 0, cap: 16000, grass: 14000,  water: 1, god: 0, trees: 0.6,  tex: 512, lite: 1, vr: 1 },
  vrlite: { pr: 1,   shadow: 512,  bloom: 0, bloomRes: 0.5, msaa: 0, cap: 8000,  grass: 6000,   water: 0, god: 0, trees: 0.35, tex: 512, lite: 1, vr: 1 },
};
const QORDER = ['high', 'medium', 'low'];
// Auto quality/resolution downgrade is OFF by default on every device: the player's quality choice sticks. ON only if the player pressed AUTO in the quality row (saved as swn_auto=1) or opened the page with ?auto=1.
let PERF_AUTO = false; try { PERF_AUTO = new URLSearchParams(location.search).get('auto') === '1' || localStorage.getItem('swn_auto') === '1'; } catch (e) { }
let qName = 'high';
try { const okQ = k => !!QUALITY[k] && !QUALITY[k].vr; const u = new URLSearchParams(location.search).get('q'); const s = localStorage.getItem('swn_q'); qName = okQ(u) ? u : okQ(s) ? s : 'high'; } catch (e) { }
let Q = QUALITY[qName];

const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: (() => { try { return localStorage.getItem('swn_pdb') === '1'; } catch (e) { return false; } })() }); // test hook only
renderer.xr.enabled = true; renderer.xr.setReferenceSpaceType('local-floor'); renderer.xr.setFoveation(TUNING.vr.foveation);
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 1400);
// the camera lives in a dolly: in flat play the rig is the identity; in VR the rig is moved / yawed / scaled (never the XR camera itself)
const rig = new THREE.Group(); rig.name = 'rig'; rig.add(camera); scene.add(rig);
const CP = new THREE.Vector3();   // camera position in WORLD space (== camera.position in flat play; head position through the rig in VR)
const VR = { supported: false, checked: false, presenting: false, entering: false, session: null, frames: 0, S: 12, yaw: 0, merge: false, mode: 'diorama', pix: 1, beamK: 1 };
let composer = null, bloomPass = null, gradePass = null, renderPass = null;
let W = innerWidth, H = innerHeight;

