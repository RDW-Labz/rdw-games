// ==============================================================================================================================================================================================
// FRAME: one hook (called from frame() right after rpgFrame)
// ==============================================================================================================================================================================================
let gemErr = 0;
function gemFrame(rdt, sdt) {
  try {
    if (GM.dirty) gemRebuild();
    if (G.state === 'play') {
      GM.t += sdt; GM.histT -= sdt; if (GM.histT <= 0) { GM.histT = 0.05; histPush(); } GM.hitstopT = Math.max(0, GM.hitstopT - rdt); GM.leechT = Math.max(0, GM.leechT - rdt);
      GM.spark = Math.min(GM.sparkMax, GM.spark + gemSparkRegen(RT.S) * sdt); for (let i = 0; i < 4; i++) { if (GM.cd[i] > 0) GM.cd[i] = Math.max(0, GM.cd[i] - sdt); const f = GM.castFlash[i]; if (f > 0) GM.castFlash[i] = Math.max(0, f - rdt * 3); else if (f < 0) GM.castFlash[i] = Math.min(0, f + rdt * 3); }
      GM.sparkFlash = Math.max(0, GM.sparkFlash - rdt); GM.deny = Math.max(0, GM.deny - rdt);
      gemCastTick(sdt); echoUpdate(sdt); pjUpdate(sdt); znUpdate(sdt); flUpdate(sdt); updateBurns(sdt); formTick(sdt, rdt); starTick(rdt, sdt);
      for (const e of ENEMIES) if (e.gSlowT > 0) { e.gSlowT -= sdt; if (e.alive && e.spdMul !== undefined) e.spdMul *= (1 - e.gSlowAmt); if (e.gSlowT <= 0) e.gSlowAmt = 0; }
      const d = GM.dash; if (d && d.on) { const rb = GM.ribDash, u = rb.mesh.material.uniforms; u.uCol.value.copy(vcol(d.kind === 'time' ? 'time' : 'gust', 1)); rb.push(P.x, P.y + 0.9, P.z); rb.build(0.9, CP.x, CP.y, CP.z); } else if (GM.ribDash.life > 0) { GM.ribDash.life -= rdt; GM.ribDash.build(0.9, CP.x, CP.y, CP.z); if (GM.ribDash.life <= 0) GM.ribDash.reset(); }
      if (GM.qHeld) { GM.qT += rdt; if (!keys.has('q')) { GM.qHeld = false; if (!GM.qUsed && GM.qT < 0.5) { CAM.recent = 0.4; CAM.yaw += angDiff(CAM.yaw, P.yaw) * 0.25; } } }
      const fireNow = mouseFire || padFireDown; if (fireNow && !FORM.prevFire && FORM.id === 'cinder' && FORM.cd <= 0 && !P.dead) { FORM.cd = GEM_TUNING.form.cinderCd; formThrow(); } FORM.prevFire = fireNow;
    }
    updateArcs(sdt); updateSlashes(sdt); updateGBeams(sdt); gemHudTick(rdt);
  } catch (err) { if (gemErr++ < 5) console.error('gemFrame', err); }
}

