// ---------------------------------------------------------------------------
// input state (contract globals)
// ---------------------------------------------------------------------------
const latch = new Set(); // keys pressed since the last frame (so a quick tap between two slow frames is never lost)
class KeySet extends Set { add(k) { const fresh = !super.has(k); if (fresh) latch.add(k); const r = super.add(k); if (fresh && typeof immediateInput === 'function') immediateInput(); return r; }
  delete(k) { const r = super.delete(k); if (r && typeof immediateInput === 'function') immediateInput(); return r; } }
const keys = new KeySet();
let placeLatch = false, padFireDown = false, padPlaceDown = false; const padLookV = { x: 0, y: 0 };
let mouseFire = false, mousePlace = false, lookDX = 0, lookDY = 0;
const edge = { fire: false, place: false, jump: false, z: false, e: false, j: false, q: false, m: false, p: false }; // pressed-this-frame latches
let locked = false, plFailed = false;
function padFire(down) { if (down === undefined) { edge.fire = true; } else { padFireDown = !!down; if (down) edge.fire = true; } if (typeof immediateInput === 'function') immediateInput(); }
function padPlace(down) { if (down === undefined) { edge.place = true; placeLatch = true; } else { padPlaceDown = !!down; if (down) placeLatch = true; } if (typeof immediateInput === 'function') immediateInput(); }
function padLook(dx, dy) { const had = padLookV.x !== 0 || padLookV.y !== 0; padLookV.x = Math.abs(dx) < 0.12 ? 0 : dx; padLookV.y = Math.abs(dy) < 0.12 ? 0 : dy; if (!had && (padLookV.x || padLookV.y) && typeof CAM !== 'undefined') { CAM.yaw -= padLookV.x * TUNING.cam.padRate * 0.06; CAM.pitch += padLookV.y * TUNING.cam.padRate * 0.04; CAM.idle = 0; } }
function padMenu() { if (G.state === 'play') pauseGame(); else if (G.state === 'pause') resumeGame(); else if (G.state === 'dead') {} else toMenu(); }

