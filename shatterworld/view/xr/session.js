// ---- session lifecycle ---------------------------------------------------------------------------------------------------------------------
function vrMenuRefresh(msg, warn) {
  $('ctaVR').classList.toggle('hidden', !VR.supported);
  let t = msg, w = !!warn;
  if (!t) { if (VR.supported) t = VR.prompt ? 'Headset detected. Press ENTER VR (Touch controllers, or a Bluetooth pad).' : 'VR ready: press ENTER VR.'; else { t = 'VR not available here: open this page in Quest Browser'; w = true; } }
  const st = $('vrStatus'); st.textContent = t; st.classList.toggle('warn', w);
}
async function vrCheckSupport() {
  let ok = false;
  try { ok = !!(navigator.xr && navigator.xr.isSessionSupported && await navigator.xr.isSessionSupported('immersive-vr')); } catch (e) { ok = false; }
  VR.supported = ok; VR.checked = true; if (!VR.presenting) vrMenuRefresh(); return ok;
}
function vrInit() {
  $('ctaVR').addEventListener('click', e => { e.stopPropagation(); vrEnter(); });
  try { if (new URLSearchParams(location.search).get('vr') === '1') { VR.prompt = true; $('vrPrompt').classList.remove('hidden'); document.body.classList.add('vrmode'); } } catch (e) { }
  renderer.xr.addEventListener('sessionstart', vrOnStart); renderer.xr.addEventListener('sessionend', vrOnEnd);
  vrMenuRefresh('Checking VR...'); vrCheckSupport();
  try { if (navigator.xr && navigator.xr.addEventListener) navigator.xr.addEventListener('devicechange', vrCheckSupport); } catch (e) { }
}
async function vrEnter() {
  if (VR.presenting || VR.entering) return;
  if (!VR.supported) { vrMenuRefresh('VR not available here: open this page in Quest Browser', true); return; }
  VR.entering = true; vrMenuRefresh('Starting VR...');
  let session = null;
  try {
    audioInit(); // inside the click: the AudioContext may only start from a user gesture
    session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'] });
    VR.session = session; VR.sessionFeatures = session.enabledFeatures ? Array.from(session.enabledFeatures).join(',') : '';
    VR.floorY = 0; renderer.xr.setReferenceSpaceType('local-floor');
    if (session.enabledFeatures && Array.from(session.enabledFeatures).indexOf('local-floor') < 0) { renderer.xr.setReferenceSpaceType('local'); VR.floorY = 1.5; } // no floor space: origin is the eyes
    renderer.xr.setFramebufferScaleFactor(vrFbScale()); renderer.xr.setFoveation(VRT.foveation);
    vrBuild(); VR.soft = detectSoftware(); VR.S = VRT.scales[vrCfg.size]; VR.prevQ = qName;
    applyQuality(vrCfg.q, true); // VR tier: no composer / bloom / god rays, small shadow map, trimmed grass + cubes (applied BEFORE the session starts so the canvas is still resizable)
    vrMergeAll(true); camera.near = VRT.near; camera.far = VRT.far; camera.updateProjectionMatrix();
    try { renderer.compile(scene, camera); } catch (e) { } // warm every shader program now, while the page is still flat
    await renderer.xr.setSession(session);
  } catch (e) {
    VR.entering = false; try { if (session) await session.end(); } catch (e2) { }
    if (!VR.presenting) { vrRestore(); vrMenuRefresh('Could not start VR: ' + String(e && e.message || e).slice(0, 90), true); }
  }
}
function vrExit() { if (VR.session) { try { VR.session.end(); } catch (e) { } } }
function vrOnStart() {
  VR.presenting = true; VR.entering = false; VR.frames = 0; VR.needAnchor = true; VR.snapFollow = true; VR.first = true; VR.lift = 0; VR.wasPlay = G.state === 'play'; VR.pinch[0] = VR.pinch[1] = false; VR.fade = 0; VR.perfT = VR.perfN = 0; VR.autoLite = false;
  const sess = VR.session = renderer.xr.getSession();
  sess.addEventListener('visibilitychange', vrOnVis); sess.addEventListener('selectstart', vrOnSelect); sess.addEventListener('selectend', vrOnSelect);
  const rs = renderer.xr.getReferenceSpace(); if (rs && rs.addEventListener) rs.addEventListener('reset', () => { VR.needAnchor = true; });
  vrRing.visible = true; UI.mode = 'none'; UI.hotKey = -1; vrAttachWrist(); VR.beamK = VRT.beamLen / 90; if (window.__qdbg) console.log('vr start');
  vrMenuRefresh('VR session running');
}
function vrOnSelect(e) { const s = e.inputSource; if (!s || !s.hand) return; const h = s.handedness === 'left' ? 0 : s.handedness === 'right' ? 1 : -1; if (h >= 0) VR.pinch[h] = e.type === 'selectstart'; }
function vrOnVis() { const v = VR.session && VR.session.visibilityState; if (v && v !== 'visible' && G.state === 'play') pauseGame(); } // system menu / headset off: never keep playing blind
function vrOnEnd() {
  if (CSU.open) closeChars(); VR.presenting = false; VR.entering = false; VR.session = null; vrReleaseAll(); XI[0].has = XI[1].has = false; vrRestore();
  if (G.state === 'play') pauseGame(); // pointer lock is gone: flat play resumes with a click, nothing is lost
  plFailed = false; lastT = performance.now(); vrMenuRefresh();
}
function vrRestore() {
  rig.position.set(0, 0, 0); rig.rotation.set(0, 0, 0); rig.scale.set(1, 1, 1); camera.near = 0.1; camera.far = 1400; camera.scale.set(1, 1, 1); camera.fov = TUNING.cam.fov; camera.aspect = W / H; camera.updateProjectionMatrix();
  VR.beamK = 1; ptMat.uniforms.uWS.value = 1; moteMat.uniforms.uWS.value = 1; vrBlink.visible = false; vrRing.visible = false; vrArrow.visible = false; VR.fade = 0;
  if (UI.built) { vrRpgRestore(); UI.main.mesh.visible = UI.how.mesh.visible = UI.capP.mesh.visible = UI.wrP.mesh.visible = false; for (let i = 0; i < 2; i++) { const u = vrCtrl[i].userData; u.laser.visible = false; u.ret.visible = false; } }
  UI.mode = 'none'; vrMergeAll(false); for (const s of SHARDS) s.mesh.visible = !s.got;
  if (VR.prevQ && QUALITY[VR.prevQ] && !QUALITY[VR.prevQ].vr) applyQuality(VR.prevQ, true); else if (Q.vr) applyQuality('high', true);
  applyAtmosphere(); onResize();
}
function vrReleaseAll() {
  for (const k of Array.from(XK)) { XK.delete(k); keys.delete(k); }
  VRIN.mag = 0; VRIN.x = VRIN.z = 0; INP.spd = 1; VR.eT = 0; if (VR.fire) { VR.fire = false; padFire(false); } if (VR.place) { VR.place = false; padPlace(false); }
}
function vrSetQuality(name) { vrCfg.q = name; vrSaveCfg(); if (VR.presenting) applyQuality(name, true); }
function vrPerf(real) { // auto-downgrade for real headsets only (software GL runs at ~2 fps and would trip it): 3 s average above ~19 ms at 72 Hz -> lite tier
  VR.frames++; if (VR.frames < 40 || VR.soft || document.hidden) return; VR.perfT += real; VR.perfN++;
  if (VR.perfT >= 3) { VR.avgMs = VR.perfT / VR.perfN * 1000; VR.perfT = 0; VR.perfN = 0; if (VR.avgMs > 19 && vrCfg.q === 'vr' && !VR.autoLite) { VR.autoLite = true; vrSetQuality('vrlite'); toast('VR: lite graphics (frame time ' + Math.round(VR.avgMs) + ' ms)'); } }
}

