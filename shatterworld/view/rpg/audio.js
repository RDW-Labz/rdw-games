// ---- WebAudio: one cue per event (uses the game's osc / noiseHit helpers, always start(t)/stop(t+dur) scheduled) ----------------------------------------
function rsfx(name, a = 0) {
  if (VR.presenting) vrRsfxHaptic(name, a); // every RPG cue also gets a haptic pattern in VR (<vr-rpg> block)
  if (!AC || muted) return; const t = AC.currentTime, now = performance.now(); if (lastSfx['r' + name] && now - lastSfx['r' + name] < 28) return; lastSfx['r' + name] = now;
  switch (name) {
    case 'pick0': osc('square', 880, 1100, t, 0.06, 0.05); break;
    case 'pick1': osc('triangle', nf(79), nf(79), t, 0.12, 0.08); osc('triangle', nf(86), nf(86), t + 0.07, 0.22, 0.08); osc('sine', nf(98), nf(98), t + 0.07, 0.3, 0.03); break;
    case 'pick2': [0, 4, 7, 12].forEach((n, i) => { osc('triangle', nf(76 + n), nf(76 + n), t + i * 0.06, 0.34, 0.08); osc('sine', nf(88 + n), nf(88 + n), t + i * 0.06, 0.5, 0.025); }); noiseHit(t + 0.1, 0.25, 0.02, 8000, 4000, 1, 'highpass'); break;
    case 'pick3': [0, 4, 7, 12, 16, 19, 24].forEach((n, i) => { osc('square', nf(64 + n), nf(64 + n), t + i * 0.075, 0.4, 0.06); osc('triangle', nf(76 + n), nf(76 + n), t + i * 0.075, 0.9, 0.08); }); osc('sawtooth', 110, 330, t, 1.4, 0.05); noiseHit(t, 1.2, 0.05, 9000, 2000, 1, 'highpass'); break;
    case 'drop0': osc('sine', 220, 120, t, 0.09, 0.06); break;
    case 'drop1': osc('sine', 300, 140, t, 0.12, 0.08); osc('triangle', nf(88), nf(88), t + 0.05, 0.2, 0.05); break;
    case 'drop2': osc('sine', 260, 90, t, 0.18, 0.12); osc('triangle', nf(84), nf(91), t + 0.04, 0.5, 0.07); break;
    case 'drop3': osc('sine', 120, 40, t, 0.6, 0.35); [0, 7, 12, 19].forEach((n, i) => osc('sawtooth', nf(60 + n), nf(60 + n) * 1.01, t + i * 0.09, 0.9, 0.05)); noiseHit(t, 0.6, 0.12, 4000, 300, 1); break;
    case 'gold': osc('square', nf(86 + Math.min(10, a)), nf(86 + Math.min(10, a)), t, 0.05, 0.05); osc('square', nf(91 + Math.min(10, a)), nf(91 + Math.min(10, a)), t + 0.05, 0.12, 0.05); break;
    case 'dust': osc('sine', nf(96), nf(100), t, 0.18, 0.05); break;
    case 'hit': noiseHit(t, 0.06, 0.07, 3500, 600, 1, 'bandpass'); osc('square', 200 + a * 40, 100, t, 0.07, 0.05); break;
    case 'crit': noiseHit(t, 0.14, 0.12, 5000, 400, 1); osc('square', 520, 200, t, 0.12, 0.09); osc('triangle', nf(84), nf(96), t + 0.03, 0.2, 0.06); break;
    case 'shield': osc('triangle', nf(96), nf(72), t, 0.25, 0.07); noiseHit(t, 0.2, 0.05, 7000, 1500, 1, 'highpass'); break;
    case 'death': osc('sawtooth', 300, 70, t, 0.26, 0.07); noiseHit(t, 0.2, 0.08, 2500, 200, 1); break;
    case 'elite': osc('sawtooth', 90, 60, t, 0.7, 0.12); osc('square', 180, 120, t, 0.5, 0.05); break;
    case 'levelup': [0, 4, 7, 12, 16, 19, 24, 28].forEach((n, i) => { osc('square', nf(60 + n), nf(60 + n), t + i * 0.085, 0.42, 0.06); osc('triangle', nf(72 + n), nf(72 + n), t + i * 0.085, 0.9, 0.07); }); osc('sine', 90, 360, t, 1.0, 0.1); noiseHit(t + 0.5, 1.0, 0.04, 9000, 3000, 1, 'highpass'); break;
    case 'perk': [0, 7, 12].forEach((n, i) => osc('triangle', nf(72 + n), nf(72 + n), t + i * 0.05, 0.5, 0.08)); osc('sine', 220, 440, t, 0.3, 0.06); break;
    case 'ui': osc('square', 700, 760, t, 0.035, 0.04); break;
    case 'uiopen': osc('triangle', 400, 700, t, 0.12, 0.07); osc('sine', 800, 1000, t + 0.06, 0.12, 0.04); break;
    case 'uiclose': osc('triangle', 700, 380, t, 0.12, 0.06); break;
    case 'deny': osc('square', 160, 120, t, 0.12, 0.07); break;
    case 'equip': noiseHit(t, 0.07, 0.1, 2500, 800, 1, 'bandpass'); osc('square', 330, 520, t, 0.07, 0.06); osc('triangle', nf(79), nf(79), t + 0.05, 0.15, 0.06); break;
    case 'salvage': noiseHit(t, 0.28, 0.12, 3500, 400, 1.2); osc('sawtooth', 300, 80, t, 0.22, 0.05); osc('triangle', nf(96), nf(103), t + 0.18, 0.2, 0.05); break;
    case 'reroll': for (let i = 0; i < 7; i++) osc('square', 300 + (i % 3) * 140 + i * 25, 300 + (i % 3) * 140 + i * 25, t + i * 0.045, 0.05, 0.04); osc('triangle', nf(84), nf(91), t + 0.34, 0.35, 0.08); break;
    case 'lock': osc('square', 500, 380, t, 0.06, 0.06); osc('triangle', 260, 200, t + 0.04, 0.1, 0.05); break;
    case 'chest': noiseHit(t, 0.2, 0.1, 1800, 400, 1); osc('sawtooth', 120, 240, t, 0.3, 0.06); [0, 4, 7, 12].forEach((n, i) => osc('triangle', nf(72 + n), nf(72 + n), t + 0.12 + i * 0.06, 0.4, 0.07)); break;
    case 'crate': noiseHit(t, 0.18, 0.14, 2200, 300, 1); osc('square', 140, 70, t, 0.1, 0.07); break;
    case 'pulse': noiseHit(t, 0.4, 0.09, 600, 5000, 1.2, 'bandpass'); osc('sine', 300, 800, t, 0.3, 0.08); osc('triangle', 900, 300, t + 0.05, 0.3, 0.05); break;
    case 'nova': noiseHit(t, 0.35, 0.12, 4000, 300, 1); osc('sine', 200, 60, t, 0.4, 0.14); break;
    case 'bolt': noiseHit(t, 0.12, 0.08, 7000, 1500, 1, 'highpass'); osc('sawtooth', 1200, 300, t, 0.12, 0.05); break;
    case 'slam': osc('sine', 80, 30, t, 0.45, 0.4); noiseHit(t, 0.35, 0.2, 1800, 100, 1); break;
    case 'windup': osc('sawtooth', 100, 260, t, 0.6, 0.05); break;
    case 'spit': osc('sine', 500, 200, t, 0.2, 0.08); noiseHit(t, 0.1, 0.05, 3000, 800, 1, 'bandpass'); break;
    case 'hop': osc('triangle', 220, 520, t, 0.16, 0.08); break;
    case 'heal': [0, 4, 7].forEach((n, i) => osc('sine', nf(79 + n), nf(79 + n), t + i * 0.06, 0.4, 0.06)); break;
    case 'phoenix': [0, 7, 12, 16, 19, 24].forEach((n, i) => osc('sawtooth', nf(55 + n), nf(55 + n), t + i * 0.07, 0.8, 0.06)); noiseHit(t, 1.2, 0.12, 5000, 300, 1); break;
    case 'rift': osc('sine', 60, 30, t, 1.6, 0.4); noiseHit(t, 1.6, 0.25, 5000, 120, 0.8); [0, 3, 7, 10, 14].forEach((n, i) => osc('square', nf(84 - n), nf(84 - n), t + 0.2 + i * 0.09, 0.3, 0.05)); break;
    case 'riftwin': [0, 4, 7, 12, 16, 19, 24, 28, 31].forEach((n, i) => { osc('square', nf(60 + n), nf(60 + n), t + i * 0.1, 0.5, 0.06); osc('triangle', nf(72 + n), nf(72 + n), t + i * 0.1, 1.0, 0.07); }); break;
    case 'riftlose': osc('sawtooth', 300, 40, t, 1.2, 0.1); osc('square', 150, 30, t, 1.2, 0.07); break;
    case 'tick': osc('square', 1200, 1000, t, 0.03, 0.03); break;
  }
}

