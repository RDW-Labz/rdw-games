// ---- stepHero wrapper: dash physics + the class passives that change a core verb (float / glide / wall-run) -------------------------------------------------------------------------
const GLIDE = { fall: 3.4, lim() { return FORM.id === 'gust' ? GEM_TUNING.form.glideFall : GLIDE.fall; } }; let wallRunT = 0;
const _stepHero = stepHero;
stepHero = function (dt) {
  if (GM.dash && GM.dash.on && !P.dead) { dashStep(dt); return; }
  let glideOn = false; const fx = RT.S.fx, jh = INP.jump, air = !P.grounded && !P.dead && P.act !== 'pound' && P.act !== 'dive' && P.act !== 'long' && P.act !== 'slide';
  if (air && jh && P.vy < 0) {
    if (fx.floatJump || (STAR.on && STAR.fx.jumpMul)) P.vy += TUNING.gravity * 0.42 * dt;                                    // Lou: hold jump to float
    if (fx.glide || FORM.id === 'gust') { glideOn = true; if (!INP.mag) { P.vx += Math.sin(P.yaw) * 6 * dt; P.vz += Math.cos(P.yaw) * 6 * dt; } } // Petal / Gust form: glide
  }
  if (fx.wallRun && air && P.wallT > 0 && (INP.iz > 0 || jh) && wallRunT < 0.9) { wallRunT += dt; if (P.vy < 5.2) P.vy = 5.2; if (Math.random() < dt * 30) puff(P.x - P.wnx * 0.4, P.y + 0.8, P.z - P.wnz * 0.4, 1, 0.5, 0xbff8ff, 0.5, 1, 0.3); } if (P.grounded) wallRunT = 0;
  _stepHero(dt);
  if (glideOn && !P.grounded && P.vy < -GLIDE.lim()) P.vy += (-GLIDE.lim() - P.vy) * 0.6; // brake AFTER gravity so the fall speed settles at the glide limit, in about 3 frames
};

