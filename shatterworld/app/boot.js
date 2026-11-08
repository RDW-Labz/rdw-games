// ============================================================================
// BOOT + shelf bridge
// ============================================================================
function detectSoftware() {
  try { const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info'); const r = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : ''; return /swiftshader|llvmpipe|software|softpipe/i.test(r); } catch (e) { return false; }
}
function bootGame() {
  // software-only GL (headless / very old devices): start on the lightest tier at reduced resolution unless the player chose one
  let chosen = false; try { chosen = !!new URLSearchParams(location.search).get('q') || !!localStorage.getItem('swn_q'); } catch (e) { }
  if (!chosen && detectSoftware()) { qName = 'low'; Q = QUALITY.low; qScale = 0.7; }
  else if (!chosen && matchMedia && matchMedia('(pointer:coarse)').matches) { qName = 'medium'; Q = QUALITY.medium; } // tablets / TV browsers start balanced
  gfxHook(); onResize(); applyQuality(qName, true);
  placeTrees(); placeRocks(); buildStructures(); buildFarMountains(); ACT1_BOXES = BOXES.slice();
  onQualityChanged(); drawLogo(); setMuted(muted); updateBestLine();
  startRun(); updateEnv();
  $('boot').classList.add('off'); setTimeout(() => $('boot').remove(), 1200);
  vrInit(); renderer.setAnimationLoop(tick);
}
bootGame();

