// ---- main loop -------------------------------------------------------------------------------------------------------------------------
function handleEdges() {
  if (edge.m) { edge.m = false; setMuted(!muted); toast(muted ? 'Muted' : 'Sound on'); }
  if (edge.p) { edge.p = false; applyQuality(QORDER[(QORDER.indexOf(qName) + 1) % 3]); }
  if (edge.j) { edge.j = false; if (G.state === 'play') { CAM.wide = !CAM.wide; toast(CAM.wide ? 'Camera: wide cinematic' : 'Camera: chase'); } }
  if (edge.q) { edge.q = false; gemQEdge(); } // Q / LB: recentre on release (a held LB is the skill modifier)
}
// a key / button event takes effect at once (one fixed step is run and borrowed from the accumulator) so input never waits for a slow frame
let inImm = false;
function deathCheck() { if (P.dead || G.state !== 'play') return; const killY = LV ? LV.deathY + LV.O.y : -28; if (P.y < killY && !(GF < 0)) killHero('fall'); if (GF < 0 && LV && P.y > LV.O.y + 90) killHero('fall'); }
function immediateInput() {
  if (inImm || G.state !== 'play' || P.dead || G.finale) return; inImm = true;
  try { pollInput(0); handleEdges(); stepHero(STEP); acc -= STEP; doRewind(0); updateNPC(0, U.time.value); updatePipesPads(0); edge.e = false; } finally { inImm = false; }
}
let shardHudT = 0, acc = 0, lastT = performance.now(), frameMs = [], qCheckT = 0, frameCount = 0;
const STEP = TUNING.step;
function frame(rdt, doRender) {
  frameCount++; const playing = G.state === 'play' || G.state === 'menu' && false;
  pollInput(rdt);
  handleEdges();
  // time scale: slow-mo recovers toward 1; hitstop freezes briefly
  G.slow += (1 - G.slow) * Math.min(1, rdt * (G.trans ? 0.55 : 1.1)); let sdt = rdt * G.slow;
  if (G.hitstop > 0) { G.hitstop -= rdt; sdt *= 0.04; }
  if (G.state === 'play') {
    G.t += rdt; acc = Math.min(acc + sdt, 0.5);
    while (acc >= STEP) { if (!G.finale) stepHero(STEP); updateEnemies(STEP, U.time.value); updatePowerups(STEP); acc -= STEP; }
    if (G.coinComboT > 0) { G.coinComboT -= rdt; if (G.coinComboT <= 0) G.coinCombo = 0; }
    // death
    deathCheck();
    PROMPT = ''; doRewind(sdt); updateCoins(sdt, U.time.value); updateShards(sdt, U.time.value); updateBlocks(sdt); updateNPC(sdt, U.time.value); updatePipesPads(sdt); updateRotators(sdt);
    edge.e = false; if (!VR.presenting) { const pe = $('prompt'); if (PROMPT) { pe.textContent = PROMPT; pe.classList.add('on'); } else pe.classList.remove('on'); }
    shardHudT -= rdt; if (shardHudT <= 0) { shardHudT = 0.25; let best = 1e9, bs = null; for (const s of SHARDS) if (!s.got) { const d = Math.hypot(s.x - P.x, s.y - P.y, s.z - P.z); if (d < best) { best = d; bs = s; } } G.nextShard = bs; G.nsd = bs ? Math.round(best) : -1; $('shardDist').textContent = bs ? 'NEXT SHARD ' + Math.round(best) + ' m' : ''; }
  } else if (G.state === 'menu') { updateNPC(rdt, U.time.value); updateShards(rdt, U.time.value); updateCoins(rdt, U.time.value); acc = 0; }
  rpgFrame(rdt, sdt); // rpg: loot / enemies / rift / hud tick
  gemFrame(rdt, sdt); // gems: skills / Spark / Star Power / forms
  U.time.value += rdt;
  if (SH.on) { if (SH.kind === 'local') updateLocalShatter(rdt); else if (SH.kind === 'world') updateWorldShatter(rdt); else if (SH.kind === 'pulse') updatePulse(rdt); else if (SH.kind === 'finale') updateFinale(rdt); }
  updateDrops(sdt); updateTerrainGeo(); updateCubes(Math.min(sdt, 1 / 20), rdt, U.time.value); updateParticles(sdt); updateStructures(sdt, U.time.value); updateMotes(U.time.value); updateShafts();
  updateHeroVisual(sdt, rdt); updateCamera(sdt, rdt); if (!VR.presenting) CP.copy(camera.position);
  // shared uniforms
  U.hero.value.set(P.x, P.y, P.z); grassUniforms.uFieldC.value.set(P.x, P.z); sky.position.copy(CP); updateSun(P.x, P.y, P.z);
  waterMat.uniforms.uQ.value = Q.water; moteMat.uniforms.uCol.value.set(G.act === 3 ? 0x6ff0ff : G.act === 2 ? 0xffb6d8 : 0xffd27a);
  grassUniforms.uGrassOn.value = act1Visible ? 1 : 0;
  // flash overlays
  if (VR.presenting) { G.flash = Math.max(0, G.flash - rdt * 1.4); G.flashRed = Math.max(0, G.flashRed - rdt * 2); } // no full-field flashes in a headset (comfort); the DOM overlay is invisible there anyway
  else if (G.flash > 0) { G.flash = Math.max(0, G.flash - rdt * 1.4); $('flash').style.opacity = G.flash.toFixed(3); $('flash').style.background = '#fff'; gradeFlash(G.flash * 0.15); } else if (G.flashRed > 0) { G.flashRed = Math.max(0, G.flashRed - rdt * 2); $('flash').style.background = '#ff3030'; $('flash').style.opacity = (G.flashRed * 0.35).toFixed(3); } else if ($('flash').style.opacity !== '0') $('flash').style.opacity = 0;
  if (gradePass) gradePass.uniforms.uChroma.value = (SH.on ? clamp(WV.glow, 0, 1.3) * 0.22 : 0);
  if (G.state === 'play' && !VR.presenting) { $('timeN').textContent = fmtTime(G.t); }
  updateMusic(rdt);
  if (doRender) renderFrame();
}
function gradeFlash(v) { if (gradePass) gradePass.uniforms.uFlash.value = v; }
let slowFrames = 0, perfFrames = 0, perfT = 0;
function perfMonitor(real) { if (!PERF_AUTO) return; // auto-downgrade: avg frame time over 3 s > 26 ms, or two consecutive very slow frames (software rendering / weak tablet)
  perfFrames++; if (perfFrames < 4 || (G.state !== 'play' && G.state !== 'menu') || document.hidden) { return; }
  if (real > 0.35) slowFrames++; else slowFrames = 0; frameMs.push(real * 1000); perfT += real;
  const idx = QORDER.indexOf(qName); const worse = () => { if (idx < 2) { applyQuality(QORDER[idx + 1]); toast('Performance: ' + qName.toUpperCase() + ' quality'); } else if (qScale > 0.55) { qScale = Math.max(0.5, qScale * 0.75); onResize(); buildComposer(); toast('Performance: lower resolution'); } frameMs.length = 0; perfT = 0; slowFrames = 0; };
  if (slowFrames >= 2) { worse(); return; }
  if (perfT >= TUNING.autoDowngradeWindow) { const avg = frameMs.reduce((a, b) => a + b, 0) / frameMs.length; frameMs.length = 0; perfT = 0; if (avg > TUNING.autoDowngradeMs && real < 2) worse(); }
}
// ONE loop for both worlds: renderer.setAnimationLoop uses window rAF in flat play and the XR session's rAF while presenting (window rAF does not run then on Quest Browser)
let tickErrs = 0;
function tick(now) { // never let one bad frame kill the loop (three schedules the next frame only after this callback returns)
  try { tickBody(now); } catch (e) { if (tickErrs++ < 8) console.error('tick error:', e && e.stack || e); }
}
function tickBody(now) {
  if (window.__paused) { lastT = now; if (VR.presenting) renderFrame(); return; } const real = (now - lastT) / 1000, rdt = Math.min(0.25, real); lastT = now; if (rdt <= 0) return;
  if (VR.presenting) { if (window.__gpPoll) window.__gpPoll(); vrPre(rdt); frame(rdt, true); vrPerf(real); } // the gamepad shim's own rAF loop is dead in VR: pump it from here
  else { frame(rdt, true); perfMonitor(real); }
}
function onQualityChanged() { U.lite.value = Q.lite; U.liteT.value = Q.vr ? 0.4 : Q.lite; onGrassQuality(); onTreeQuality(); updateHUD(); }

