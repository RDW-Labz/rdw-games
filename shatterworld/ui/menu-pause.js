// ---- menu / pause / pointer lock -----------------------------------------------------------------------------------------------------
function requestLock() { if (VR.presenting) return; try { const p = canvas.requestPointerLock && canvas.requestPointerLock(); if (p && p.catch) p.catch(() => { plFailed = true; locked = false; }); } catch (e) { plFailed = true; } }
document.addEventListener('pointerlockchange', () => { const was = locked; locked = document.pointerLockElement === canvas; if (was && !locked && G.state === 'play') pauseGame(); });
document.addEventListener('pointerlockerror', () => { plFailed = true; locked = false; });
function beginGame() {
  edge.e = edge.j = edge.q = edge.m = edge.p = edge.fire = edge.place = false; audioInit(); if (!G.started) { G.started = true; startRun(); } else if (G.state === 'menu') { startRun(); }
  $('menu').classList.add('hidden'); $('hud').classList.remove('hidden'); G.state = 'play'; updateHUD(); updateBestLine(); requestLock(); sfx('click'); toast('Collect the Sun Shards', 3000);
}
function pauseGame() { if (G.state !== 'play') return; G.state = 'pause'; $('pause').classList.remove('hidden'); keys.clear(); mouseFire = mousePlace = false; document.exitPointerLock && document.exitPointerLock(); }
function resumeGame() { if (G.state !== 'pause') return; G.state = 'play'; $('pause').classList.add('hidden'); requestLock(); }
function toMenu() { G.state = 'menu'; $('menu').classList.remove('hidden'); $('hud').classList.add('hidden'); $('pause').classList.add('hidden'); $('dead').classList.add('hidden'); document.exitPointerLock && document.exitPointerLock(); G.started = false; updateBestLine(); keys.clear(); startRun(); }

addEventListener('keydown', e => {
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase(); if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) e.preventDefault();
  if (k === 'escape') { if (G.state === 'play') pauseGame(); else if (G.state === 'pause') resumeGame(); return; }
  if (e.repeat && k !== ' ') { keys.add(k); return; } keys.add(k); audioInit();
  if (G.state === 'menu' && (k === 'enter')) beginGame(); if (G.state === 'dead' && k === 'enter') $('cta2').click();
});
addEventListener('keyup', e => { const k = e.key.toLowerCase(); keys.delete(k); });
addEventListener('blur', () => { keys.clear(); mouseFire = mousePlace = false; });
addEventListener('mousedown', e => { if (G.state === 'pause') { if (e.target.id !== 'toMenuBtn') resumeGame(); return; } if (G.state !== 'play') return; if (e.button === 0) { mouseFire = true; edge.fire = true; } else if (e.button === 2) { mousePlace = true; placeLatch = true; } audioInit(); immediateInput(); if (!locked && !plFailed && document.pointerLockElement !== canvas) requestLock(); });
addEventListener('mouseup', e => { if (e.button === 0) mouseFire = false; else if (e.button === 2) mousePlace = false; immediateInput(); });
addEventListener('contextmenu', e => e.preventDefault());
addEventListener('mousemove', e => { if (G.state !== 'play') return; if (locked || plFailed) { CAM.yaw -= (e.movementX || 0) * TUNING.cam.sens; CAM.pitch += (e.movementY || 0) * TUNING.cam.sens * 0.9; CAM.idle = 0; } });
$('cta').addEventListener('click', e => { e.stopPropagation(); beginGame(); });
$('cta2').addEventListener('click', e => { e.stopPropagation(); audioInit(); if (G.won) restartAll(); else retry(); });
$('pause').addEventListener('click', e => { if (e.target.id === 'toMenuBtn') { toMenu(); return; } resumeGame(); });
document.querySelectorAll('.qrow button[data-q]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); applyQuality(b.dataset.q); }));
{ const ab = document.getElementById('autoQ'); if (ab) { const paint = () => { ab.textContent = 'AUTO: ' + (PERF_AUTO ? 'ON' : 'OFF'); ab.classList.toggle('on', PERF_AUTO); };
  ab.addEventListener('click', e => { e.stopPropagation(); PERF_AUTO = !PERF_AUTO; try { localStorage.setItem('swn_auto', PERF_AUTO ? '1' : '0'); } catch (err) { } slowFrames = 0; perfFrames = 0; perfT = 0; frameMs.length = 0; paint(); if (typeof toast === 'function') toast(PERF_AUTO ? 'Auto quality ON: lowers quality if frames are slow' : 'Auto quality OFF: your quality choice sticks'); }); paint(); } }
$('menu').addEventListener('pointerdown', () => audioInit());

