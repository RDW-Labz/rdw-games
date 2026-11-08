// ---- haptics: Quest Browser exposes gamepad.hapticActuators[0].pulse(), Chrome desktop gamepad.vibrationActuator.playEffect() -------------
const HAP = { startDelay: 0, duration: 0, weakMagnitude: 0, strongMagnitude: 0 };
function vrHaptic(h, amp, ms) {
  if (h === 2) { vrHaptic(0, amp, ms); vrHaptic(1, amp, ms); return; }
  const X = XI[h]; if (!X || !X.has || !X.src) return; const gp = X.src.gamepad; if (!gp) return;
  const now = performance.now(); if (now - X.lastHap < 22) return; X.lastHap = now;
  try {
    const ha = gp.hapticActuators;
    if (ha && ha.length && ha[0] && ha[0].pulse) { const r = ha[0].pulse(amp, ms); if (r && r.catch) r.catch(vrNoop); VR.haptics++; return; }
    const va = gp.vibrationActuator;
    if (va && va.playEffect) { HAP.duration = ms; HAP.weakMagnitude = amp * 0.6; HAP.strongMagnitude = amp; const r = va.playEffect('dual-rumble', HAP); if (r && r.catch) r.catch(vrNoop); VR.haptics++; }
  } catch (e) { }
}
function vrSfxHaptic(name, a) { // called from sfx() while presenting: every game event that has a sound also gets a feel
  switch (name) {
    case 'coin': vrHaptic(1, 0.18 + Math.min(0.22, a * 0.03), 24); break;
    case 'hurt': vrHaptic(2, 1, 240); break;
    case 'pound': vrHaptic(2, 1, 260); break;
    case 'poundstart': vrHaptic(2, 0.25, 40); break;
    case 'shatter': vrHaptic(2, 0.9, 320); break;
    case 'shatter_big': vrHaptic(2, 1, 520); break;
    case 'shatter_small': vrHaptic(2, 0.5, 140); break;
    case 'rewind': vrHaptic(2, 0.35, 70); break;
    case 'shard': vrHaptic(2, 0.7, 260); break;
    case 'punch': vrHaptic(VR.fireHand, 0.5, 45); break;
    case 'dive': vrHaptic(VR.fireHand, 0.4, 90); break;
    case 'stomp': case 'kick': vrHaptic(2, 0.65, 70); break;
    case 'land': if (a > 0.3) vrHaptic(2, 0.12 + a * 0.2, 26); break;
    case 'jump': case 'jump2': case 'jump3': vrHaptic(1, 0.12, 18); break;
    case 'powerup': vrHaptic(2, 0.5, 200); break;
    case 'die': vrHaptic(2, 1, 500); break;
    case 'click': vrHaptic(2, 0.2, 18); break;
  }
}

