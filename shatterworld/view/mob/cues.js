// ---- cues: every action has its own sound (+ a haptic pattern in VR through the existing RV_HP table) --------------------------------------------------------------------------------------------------
function msfx(name, a) {
  if (VR.presenting) { const h = { tell: 'windup', boom: 'slam', zap: 'bolt', heal: 'heal', stun: 'crit', clang: 'shield', roar: 'slam', burst: 'nova' }[name]; if (h) vrRsfxHaptic(h, 0); }
  if (!AC || muted) return; const t = AC.currentTime, now = performance.now(), key = 'm' + name; if (lastSfx[key] && now - lastSfx[key] < 40) return; lastSfx[key] = now;
  switch (name) {
    case 'tell': osc('sawtooth', 160 + (a || 0) * 40, 340 + (a || 0) * 60, t, 0.5, 0.04); noiseHit(t, 0.4, 0.025, 800, 3000, 1.5, 'bandpass'); break;
    case 'tellhi': osc('triangle', 500, 900, t, 0.35, 0.05); osc('sine', 1000, 1500, t + 0.05, 0.3, 0.03); break;
    case 'alert': osc('square', 620, 880, t, 0.08, 0.05); osc('square', 880, 880, t + 0.08, 0.1, 0.05); break;
    case 'zap': osc('sawtooth', 900, 260, t, 0.16, 0.06); noiseHit(t, 0.1, 0.05, 6000, 1500, 1, 'highpass'); break;
    case 'lob': osc('sine', 260, 520, t, 0.3, 0.07); noiseHit(t, 0.2, 0.04, 500, 2500, 1, 'bandpass'); break;
    case 'splat': noiseHit(t, 0.3, 0.12, 1800, 200, 1); osc('sine', 150, 60, t, 0.25, 0.15); break;
    case 'dash': noiseHit(t, 0.5, 0.12, 700, 3000, 1.3, 'bandpass'); osc('sawtooth', 120, 260, t, 0.4, 0.05); break;
    case 'boom': osc('sine', 100, 28, t, 0.5, 0.42); noiseHit(t, 0.45, 0.28, 2600, 90, 1); osc('square', 180, 50, t, 0.2, 0.08); break;
    case 'stomp': osc('sine', 80, 30, t, 0.4, 0.4); noiseHit(t, 0.3, 0.18, 1600, 100, 1); break;
    case 'bite': noiseHit(t, 0.08, 0.1, 4500, 800, 1, 'bandpass'); osc('square', 420, 200, t, 0.06, 0.06); break;
    case 'summon': [0, 3, 7, 10].forEach((n, i) => osc('triangle', nf(60 + n), nf(60 + n), t + i * 0.08, 0.5, 0.06)); noiseHit(t, 0.5, 0.05, 400, 1800, 1.5, 'bandpass'); break;
    case 'heal': [0, 4, 7, 12].forEach((n, i) => osc('sine', nf(81 + n), nf(81 + n), t + i * 0.06, 0.4, 0.06)); break;
    case 'clang': osc('square', 880, 700, t, 0.1, 0.07); osc('triangle', 1760, 1200, t, 0.18, 0.05); noiseHit(t, 0.05, 0.08, 6000, 3000, 1, 'highpass'); break;
    case 'stun': osc('sawtooth', 300, 80, t, 0.3, 0.07); [0, 7, 14].forEach((n, i) => osc('triangle', nf(90 - n), nf(90 - n), t + 0.05 + i * 0.07, 0.2, 0.05)); break;
    case 'burrow': noiseHit(t, 0.4, 0.14, 500, 120, 1); osc('sine', 70, 40, t, 0.4, 0.2); break;
    case 'emerge': noiseHit(t, 0.3, 0.2, 1800, 200, 1); osc('sine', 90, 35, t, 0.3, 0.3); break;
    case 'fuse': osc('square', 900 + (a || 0) * 120, 900 + (a || 0) * 120, t, 0.04, 0.04); break;
    case 'roar': osc('sawtooth', 70, 150, t, 1.0, 0.12); osc('square', 140, 90, t, 0.9, 0.06); noiseHit(t, 0.9, 0.12, 1500, 200, 1); break;
    case 'bossdown': [0, 4, 7, 12, 16, 19, 24, 28, 31].forEach((n, i) => { osc('square', nf(60 + n), nf(60 + n), t + i * 0.09, 0.5, 0.05); osc('triangle', nf(72 + n), nf(72 + n), t + i * 0.09, 1.0, 0.07); }); osc('sine', 60, 30, t, 1.6, 0.3); break;
    case 'sweep': osc('sawtooth', 200, 1200, t, 1.4, 0.05); noiseHit(t, 1.4, 0.06, 600, 4000, 1.4, 'bandpass'); break;
    case 'shield': osc('triangle', nf(96), nf(72), t, 0.4, 0.07); noiseHit(t, 0.3, 0.05, 7000, 1500, 1, 'highpass'); break;
  }
}
