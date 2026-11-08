// <aim-assist> ==================================================================================================================
// SHATTERWORLD aiming layer (pass B). Before this layer: the punch and the dive went along P.yaw (the last RUN heading, so a standing hero punched wherever it last ran, not where the camera looks), the skills snapped to the best
// enemy inside +-40 deg of the CAMERA only, their projectiles ignored the target's height, the VR controllers aimed nothing but the UI laser, and nothing nudged a melee swing onto an enemy that was almost in reach.
// Now every attack resolves ONE intended direction, then a soft aim assist pulls it onto the best enemy inside a cone:
//   intent = VR: the right controller's pointing yaw | otherwise: the stick / WASD heading while moving, else the camera yaw (the crosshair)
//   assist = enemy inside a 25 deg (touch 30) cone of the intent: pad / touch / VR snap fully anywhere inside it; the mouse snaps inside 8 deg and fades to nothing at the cone edge (the weakest)
//   melee  = also faces the nearest enemy within 2.8 m with no stick input (any direction), and takes a short magnet step toward a target that is almost in reach
//   ranged = the projectile leaves the hand and is aimed at the target's chest height (not a fixed vy); skills re-aim at release (where the crosshair is NOW, not when the cast started)
// Test hooks only: window.__game.aimDevice(name) forces mouse | pad | touch | vr; window.__aim.last = the last resolution.
const AIMX = { dev: 'mouse', force: '', tNext: 0, last: null,
  tune: { mouse: { cone: 0.436, snap: 0.14, bias: 0.7, step: 1.0 }, pad: { cone: 0.436, snap: 0.436, bias: 1, step: 1.2 }, touch: { cone: 0.52, snap: 0.52, bias: 1, step: 1.3 }, vr: { cone: 0.436, snap: 0.436, bias: 1, step: 1.1 } },
  // thrown / cast skills keep the generous pass-A cone (40 deg: full snap anywhere inside it) on pad / touch / VR; the mouse gets a narrower, fading one
  skill: { mouse: { cone: 0.5, snap: 0.2, bias: 0.8 }, pad: { cone: 0.75, snap: 0.75, bias: 1 }, touch: { cone: 0.8, snap: 0.8, bias: 1 }, vr: { cone: 0.75, snap: 0.75, bias: 1 } } };
const _aq = new THREE.Quaternion(), _av = new THREE.Vector3();
function aimDev() { return AIMX.force || (VR.presenting ? 'vr' : AIMX.dev); }
function aimNotePad() { const now = performance.now(); if (now < AIMX.tNext) return; AIMX.tNext = now + 400; const t = window.__touch; if (t) { const s = t.state(); AIMX.dev = s.visible && !s.gamepad ? 'touch' : 'pad'; } else AIMX.dev = 'pad'; }
addEventListener('mousemove', e => { if (e.movementX || e.movementY) AIMX.dev = 'mouse'; }, true); addEventListener('mousedown', () => { AIMX.dev = 'mouse'; }, true); addEventListener('keydown', () => { AIMX.dev = 'mouse'; }, true);
{ const _pl = padLook; padLook = function (dx, dy) { if (dx || dy) aimNotePad(); return _pl(dx, dy); }; const _pf = padFire; padFire = function (d) { aimNotePad(); return _pf(d); }; const _pp = padPlace; padPlace = function (d) { aimNotePad(); return _pp(d); }; }
function aimWish() { const cy = CAM.yaw, fx = Math.sin(cy), fz = Math.cos(cy); return Math.atan2(fx * INP.iz - fz * INP.ix, fz * INP.iz + fx * INP.ix); }
function aimMoving() { return INP.ix * INP.ix + INP.iz * INP.iz > 0.04; }
function aimBase(useWish) { // the direction the player means
  if (aimDev() === 'vr') { const c = UI.ch[1]; if (c && XI[1].has && c.visible) { c.getWorldQuaternion(_aq); _av.set(0, 0, -1).applyQuaternion(_aq); if (_av.x * _av.x + _av.z * _av.z > 0.04) return Math.atan2(_av.x, _av.z); } return CAM.yaw; }
  return useWish && aimMoving() ? aimWish() : CAM.yaw;
}
function aimPick(base, range, vtol, T, any) { // best enemy inside the cone (score = angle first, then distance); any = nearest in every direction when nothing is inside the cone
  let best = null, bs = 1e9, bda = 0, near = null, nd = 1e9;
  for (const e of ENEMIES) { if (!gemOk(e)) continue; const dx = e.x - P.x, dz = e.z - P.z, d = hyp2(dx, dz); if (d > range || Math.abs(e.y - P.y) > vtol) continue; if (d < 0.05) continue;
    const da = angDiff(base, Math.atan2(dx, dz)), a = da < 0 ? -da : da; if (a <= T.cone) { const sc = a * 4 + d * 0.15; if (sc < bs) { bs = sc; best = e; bda = da; } } if (any && d < nd && d <= any) { nd = d; near = e; } }
  if (best) { AIMX.pickDa = bda; AIMX.pickAny = false; return best; } if (near) { AIMX.pickDa = angDiff(base, Math.atan2(near.x - P.x, near.z - P.z)); AIMX.pickAny = true; return near; } return null;
}
function aimK(da, T) { const a = da < 0 ? -da : da; return a <= T.snap ? 1 : T.bias * Math.max(0, 1 - (a - T.snap) / Math.max(1e-3, T.cone - T.snap)); }
function aimResolve(base, range, vtol, any, label) { // -> the assisted yaw; sets AIMX.hit
  const T = (label === 'skill' ? AIMX.skill : AIMX.tune)[aimDev()] || AIMX.tune.mouse, e = aimPick(base, range, vtol, T, any); let yaw = base, k = 0;
  if (e) { k = AIMX.pickAny ? 1 : aimK(AIMX.pickDa, T); yaw = base + AIMX.pickDa * k; } AIMX.hit = e && k > 0 ? e : null; AIMX.last = { kind: label, dev: aimDev(), base, yaw, k, target: e ? e.type : null, da: e ? AIMX.pickDa : 0 }; return yaw;
}
function aimStep(yaw, d) { const nx = P.x + Math.sin(yaw) * d, nz = P.z + Math.cos(yaw) * d, f = floorAt(nx, nz, P.y + 0.9); if (f > -1e8 && Math.abs(f - P.y) < 0.7 && !solidPoint(nx, P.y + 0.9, nz)) { P.x = nx; P.z = nz; } }
function aimMelee() { // called when a punch starts: turn to the intent, onto the best enemy, and step in if it is almost in reach
  const R = TUNING.punch.reach, T = AIMX.tune[aimDev()] || AIMX.tune.mouse, yaw = aimResolve(aimBase(true), R * 2.4, 1.7, aimMoving() ? 0 : 2.8, 'punch'); P.yaw = yaw;
  const e = AIMX.hit; if (e) { const d = hyp2(e.x - P.x, e.z - P.z), want = Math.min(T.step, d - 1.35); if (want > 0.05) aimStep(Math.atan2(e.x - P.x, e.z - P.z), want); }
}
function aimDive() { P.yaw = aimResolve(aimBase(true), 10, 14, 0, 'dive'); }
// ---- skills: re-aim at release, aim the projectile at the target's chest -------------------------------------------------------------------------------------------------------------------------------------
gemAim = function (range) { const base = aimBase(false), yaw = aimResolve(base, range, 6, 0, 'skill'); GM.aimEnemy = AIMX.hit; return yaw; };
{ const _gfc = gemFireCast; gemFireCast = function (c) { if (c && c.R && c.t > 0.05 && !c.echo && G.state === 'play') { const y = gemAim(c.R.p.range || c.R.p.dist || 12); c.yaw = y; P.yaw = y; } _gfc(c); }; }
function gemAimVy(o, a, speed, grav, vy0) { // vertical launch speed that reaches the aimed enemy's chest (straight line when grav = 0); falls back to the skill's own value
  const e = GM.aimEnemy; if (!e || !gemOk(e)) return vy0; const dx = e.x - o.x, dz = e.z - o.z, d = hyp2(dx, dz); if (d < 1 || Math.abs(angDiff(a, Math.atan2(dx, dz))) > 0.5) return vy0;
  const t = d / Math.max(1, speed), ty = e.y + 0.75 * (e.mesh && e.mesh.scale ? Math.max(0.6, e.mesh.scale.y) : 1), dy = ty - o.y, vy = dy / t + 0.5 * grav * t, lim = speed * 0.75; return vy > lim ? lim : vy < -lim ? -lim : vy;
}
window.__game.aimDevice = d => { AIMX.force = d || ''; return aimDev(); };
window.__aim = { dev: aimDev, tune: AIMX.tune, skill: AIMX.skill, get last() { return AIMX.last; }, base: aimBase, resolve: (base, range, vtol, any) => aimResolve(base, range, vtol, any, 'test') };
// </aim-assist>

