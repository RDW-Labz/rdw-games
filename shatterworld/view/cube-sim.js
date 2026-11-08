// ============================================================================
// CUBE SIMULATION + THE SHATTER: shockwave -> voxelise blend -> burst -> collapse -> rebuild (spring-damped, staggered) -> relax
// ============================================================================
const DROPT = new Float32Array(GRID * GRID), FALLT = new Float32Array(GRID * GRID).fill(1e9);
let dropActive = false, collapsing = false;
const CS = { nFly: 0, nPend: 0, grav: 26, drag: 0.0, ground: true, kRate: 0, clackBudget: 0, lastClack: 0 };
const _q = { x: 0, y: 0, z: 0, w: 1 };
function cubeBallistic(i, dt) {
  C.vy[i] -= CS.grav * dt; if (CS.drag > 0) { const k = Math.exp(-CS.drag * dt); C.vx[i] *= k; C.vy[i] *= k; C.vz[i] *= k; }
  C.x[i] += C.vx[i] * dt; C.y[i] += C.vy[i] * dt; C.z[i] += C.vz[i] * dt;
  const wx = C.wx[i], wy = C.wy[i], wz = C.wz[i], qx = C.qx[i], qy = C.qy[i], qz = C.qz[i], qw = C.qw[i], h = 0.5 * dt;
  let nx = qx + h * (wx * qw + wy * qz - wz * qy), ny = qy + h * (wy * qw + wz * qx - wx * qz), nz = qz + h * (wz * qw + wx * qy - wy * qx), nw = qw + h * (-wx * qx - wy * qy - wz * qz);
  const l = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw); C.qx[i] = nx * l; C.qy[i] = ny * l; C.qz[i] = nz * l; C.qw[i] = nw * l;
  if (CS.ground) {
    const g = colHeight(C.x[i], C.z[i]), half = 0.5 * C.s[i];
    if (C.y[i] - half < g) {
      C.y[i] = g + half; if (C.vy[i] < -2.5) { C.vy[i] = -C.vy[i] * 0.36; C.vx[i] *= 0.72; C.vz[i] *= 0.72; C.wx[i] *= 0.6; C.wy[i] *= 0.6; C.wz[i] *= 0.6; } else { C.vy[i] = 0; C.vx[i] *= 0.9; C.vz[i] *= 0.9; C.wx[i] *= 0.8; C.wy[i] *= 0.8; C.wz[i] *= 0.8; if (Math.abs(C.vx[i]) + Math.abs(C.vz[i]) < 0.3 && C.st[i] === ST.BALL) { C.st[i] = ST.REST; } }
    }
  }
  if (C.y[i] < CS.floorY) { C.y[i] = CS.floorY; C.vy[i] = 0; C.vx[i] *= 0.9; C.vz[i] *= 0.9; }
  C.glow[i] = Math.max(0, C.glow[i] - dt * 1.1);
}
CS.floorY = -90;
let clackQ = 0; const SCALE_PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21];
function updateCubes(dt, rdt, time) {
  if (cubeHi === 0) return;
  let dirty = cubesDirty; cubesDirty = false; CS.clackBudget = Math.min(6, CS.clackBudget + rdt * 40); clackQ = 0; let nFly = 0, nPend = 0;
  for (let i = 0; i < cubeHi; i++) {
    const st = C.st[i]; if (st === ST.FREE || st === ST.SET || st === ST.HOMED) continue; dirty = true;
    switch (st) {
      case ST.BALL: cubeBallistic(i, dt); C.age[i] += dt; if (C.delay[i] > 0) { nPend++; C.delay[i] -= dt; if (C.delay[i] <= 0) launchFly(i); } break;
      case ST.REST: {
        C.age[i] += dt; C.glow[i] = Math.max(0, C.glow[i] - dt * 1.1);
        if (CS.ground) { const g = colHeight(C.x[i], C.z[i]); if (C.y[i] - 0.5 * C.s[i] > g + 0.06) C.st[i] = ST.BALL; }
        if (C.delay[i] > 0) { nPend++; C.delay[i] -= dt; if (C.delay[i] <= 0) launchFly(i); }
        break;
      }
      case ST.FLY: nFly++; flyCube(i, dt); break;
      case ST.POP: {
        C.age[i] += dt; const t = C.age[i]; C.pop[i] = 0.22 * Math.exp(-14 * t) * Math.cos(32 * t); C.vox[i] = Math.max(0, C.vox[i] - dt * 2.4); C.glow[i] = Math.max(C.tgl[i], C.glow[i] - dt * 2);
        if (t > 0.36) { C.pop[i] = 0; C.vox[i] = 0; C.glow[i] = C.tgl[i]; C.st[i] = ST.SET; }
        break;
      }
      case ST.AMB: {
        const t = time * 0.5 + C.wy[i]; C.x[i] = C.tx[i] + Math.sin(t * 1.3 + C.wx[i]) * 0.9; C.y[i] = C.ty[i] + Math.sin(t * 0.9 + C.wz[i]) * 0.7; C.z[i] = C.tz[i] + Math.cos(t * 1.1 + C.wx[i]) * 0.9;
        const a = time * 0.4 + C.wz[i], sa = Math.sin(a * 0.5), ca = Math.cos(a * 0.5); C.qx[i] = 0; C.qy[i] = sa; C.qz[i] = 0; C.qw[i] = ca; C.vox[i] = 0.35 + 0.3 * Math.sin(time * 2 + C.wy[i] * 9); break;
      }
      case ST.STRM: { // waterfall of falling cubes (analytic)
        const L = C.hx[i], u = (time * C.hy[i] * 6 + C.wy[i] * L) % L; C.x[i] = C.tx[i] + C.wx[i] * (0.3 + u / L * 0.7); C.z[i] = C.tz[i] + C.wz[i] * (0.3 + u / L * 0.7); C.y[i] = C.ty[i] - u; const f = u < 1.5 ? u / 1.5 : u > L - 4 ? (L - u) / 4 : 1; C.s[i] = C.ts[i] * f; C.qy[i] = Math.sin(u * 0.4) * 0.5; C.qw[i] = Math.sqrt(1 - C.qy[i] * C.qy[i]); break; }
      case ST.ROT: { const R = C.grp[i] >= 0 ? null : null; break; }
      case ST.DIE: { C.age[i] += dt; const k = C.age[i] < 0 ? 1 : 1 - C.age[i] / 0.45; if (k <= 0) { freeCube(i); continue; } C.s[i] = C.ts[i] * k; cubeBallistic(i, dt * 0.2); break; }
    }
    writeCube(i);
  }
  CS.nFly = nFly; CS.nPend = nPend;
  if (dirty) { cubeMesh.instanceMatrix.needsUpdate = true; cubeMesh.instanceColor.needsUpdate = true; fxAttr.needsUpdate = true; }
}
function launchFly(i) {
  C.st[i] = ST.FLY; C.age[i] = 0; const dx = C.tx[i] - C.x[i], dy = C.ty[i] - C.y[i], dz = C.tz[i] - C.z[i]; C.d0[i] = Math.max(1, Math.hypot(dx, dy, dz));
  C.r0[i] = C.r[i]; C.g0[i] = C.g[i]; C.b0[i] = C.b[i];
  // little upward pop at lift-off so the cube visibly leaves the debris pile
  C.vy[i] += 2 + Math.random() * 3;
}
function flyCube(i, dt) {
  const a = (C.age[i] += dt), dx = C.tx[i] - C.x[i], dy = C.ty[i] - C.y[i], dz = C.tz[i] - C.z[i], d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const boost = 1 + a * a * 0.6, k = 62 * boost, c = 2 * 0.78 * Math.sqrt(k);
  let vx = C.vx[i] + (dx * k - C.vx[i] * c) * dt, vy = C.vy[i] + (dy * k - C.vy[i] * c) * dt, vz = C.vz[i] + (dz * k - C.vz[i] * c) * dt;
  const vm = 70 * Math.min(2.2, boost), sp = Math.sqrt(vx * vx + vy * vy + vz * vz); if (sp > vm) { const q = vm / sp; vx *= q; vy *= q; vz *= q; }
  C.vx[i] = vx; C.vy[i] = vy; C.vz[i] = vz; C.x[i] += vx * dt; C.y[i] += vy * dt; C.z[i] += vz * dt;
  // orientation: tumble while far, align when close
  if (d > 3) { const h = 0.5 * dt, wx = C.wx[i], wy = C.wy[i], wz = C.wz[i], qx = C.qx[i], qy = C.qy[i], qz = C.qz[i], qw = C.qw[i];
    let nx = qx + h * (wx * qw + wy * qz - wz * qy), ny = qy + h * (wy * qw + wz * qx - wx * qz), nz = qz + h * (wz * qw + wx * qy - wy * qx), nw = qw + h * (-wx * qx - wy * qy - wz * qz); const l = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw); C.qx[i] = nx * l; C.qy[i] = ny * l; C.qz[i] = nz * l; C.qw[i] = nw * l; }
  else { const t = 1 - Math.exp(-9 * dt); let qx = C.qx[i], qy = C.qy[i], qz = C.qz[i], qw = C.qw[i]; if (qw < 0) { qx = -qx; qy = -qy; qz = -qz; qw = -qw; } qx *= 1 - t; qy *= 1 - t; qz *= 1 - t; qw = qw * (1 - t) + t; const l = 1 / Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw); C.qx[i] = qx * l; C.qy[i] = qy * l; C.qz[i] = qz * l; C.qw[i] = qw * l; }
  C.s[i] += (C.ts[i] - C.s[i]) * Math.min(1, dt * 8);
  const pr = clamp(Math.max(1 - d / C.d0[i], a / 1.15), 0, 1), e = pr * pr * (3 - 2 * pr);
  C.r[i] = C.r0[i] + (C.tr[i] - C.r0[i]) * e + Math.sin(PI * pr) * 0.18; C.g[i] = C.g0[i] + (C.tg[i] - C.g0[i]) * e + Math.sin(PI * pr) * 0.16; C.b[i] = C.b0[i] + (C.tb[i] - C.b0[i]) * e + Math.sin(PI * pr) * 0.12;
  C.glow[i] = Math.sin(PI * pr) * 0.28; C.vox[i] = C.rew[i] ? 0.35 * (1 - e) : 1 - sstep(0.55, 1, pr);
  if ((d < 0.05 && sp < 2.2 && (C.owner[i] !== -2 || a > 1.2)) || a > 7) cubeArrive(i);
}
function cubeArrive(i) {
  C.x[i] = C.tx[i]; C.y[i] = C.ty[i]; C.z[i] = C.tz[i]; C.vx[i] = C.vy[i] = C.vz[i] = 0; C.qx[i] = C.qy[i] = C.qz[i] = 0; C.qw[i] = 1; C.s[i] = C.ts[i]; C.r[i] = C.tr[i]; C.g[i] = C.tg[i]; C.b[i] = C.tb[i];
  if (C.rew[i]) { cubeHome(i); return; }
  if (C.owner[i] === -3) { C.st[i] = ST.AMB; C.vox[i] = 0.4; C.glow[i] = 0; C.s[i] = C.ts[i]; return; }
  C.age[i] = 0; C.st[i] = ST.POP; vgSet(Math.floor(C.tx[i]), Math.floor(C.ty[i]), Math.floor(C.tz[i]), 1);
  if (C.owner[i] === -3) { /* ambient converts below */ }
  if (CS.clackBudget > 1 && clackQ < 2) { CS.clackBudget -= 1; clackQ++; sfxClack(C.x[i], C.y[i], C.z[i]); }
}
function cubeHome(i) { // a rewound cube is back at its original place
  const o = C.owner[i]; C.rew[i] = 0;
  if (o >= 0 && o < 100000) { DROPT[o] = 0; dropActive = true; FALLT[o] = 1e9; freeCube(i); }
  else if (o >= 100000) {
    const g = HOMEG.get(o);
    if (!g) freeCube(i); else { g.back++; C.st[i] = ST.HOMED; C.glow[i] = 0; C.vox[i] = 0; writeCube(i); cubesDirty = true; if (g.back >= g.need * 0.9 && !g.done) { g.done = true; g.restore(); } }
  } else freeCube(i);
  if (CS.clackBudget > 1 && clackQ < 3) { CS.clackBudget -= 1; clackQ++; sfxClack(C.x[i], C.y[i], C.z[i]); }
}
const HOMEG = new Map(); // owner id -> {need, back, done, restore(), cubes[]}
function cubeFreeGroup(g) { for (const i of g.cubes) if (C.owner[i] === g.id && C.st[i] !== ST.FREE) freeCube(i); }

