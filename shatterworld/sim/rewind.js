// ---------------------------------------------------------------------------------------------------------------------
// REWIND: hold the secondary button, nearby debris flies back to where it came from and re-forms the object
// ---------------------------------------------------------------------------------------------------------------------
let rewinding = false, rewindSfx = 0;
function doRewind(dt) {
  const on = INP.place && G.state === 'play'; if (on && !rewinding) G.rewinds = (G.rewinds || 0) + 1; rewinding = on; $('rew').classList.toggle('on', on); if (!on) return;
  let n = 0; const R2 = 55 * 55;
  for (let i = 0; i < cubeHi; i++) {
    const st = C.st[i]; if (st !== ST.BALL && st !== ST.REST || C.owner[i] === -1 || C.rew[i]) continue;
    const dx = C.x[i] - P.x, dz = C.z[i] - P.z; if (dx * dx + dz * dz > R2) continue;
    C.rew[i] = 1; C.tx[i] = C.hx[i]; C.ty[i] = C.hy[i]; C.tz[i] = C.hz[i]; const o = C.owner[i]; C.tr[i] = C.r[i]; C.tg[i] = C.g[i]; C.tb[i] = C.b[i];
    if (o >= 0 && o < 100000) { const ci = o; const cc = CELLCOL; C.tr[i] = cc[ci * 3]; C.tg[i] = cc[ci * 3 + 1]; C.tb[i] = cc[ci * 3 + 2]; }
    C.delay[i] = 0; launchFly(i); C.vx[i] *= 0.2; C.vz[i] *= 0.2; n++;
  }
  rewindSfx -= dt; if (n > 0 && rewindSfx <= 0) { sfx('rewind'); rewindSfx = 0.25; }
}

