// ---- sfx (own switch; same helpers as sfx / rsfx, every note scheduled start(t) / stop(t + dur)) ------------------------------------------------------------------------------------------------
const GSFX_PITCH = () => classDef(RP.cls).sfx.pitch || 1;
function gsfx(name, a = 0) {
  if (VR.presenting) vrGsfxHaptic(name, a);
  if (!AC || muted) return; const t = AC.currentTime, now = performance.now(), key = 'g' + name; if (lastSfx[key] && now - lastSfx[key] < 24) return; lastSfx[key] = now; const k = GSFX_PITCH();
  switch (name) {
    case 'gcube': osc('square', 520 * k, 240 * k, t, 0.12, 0.07); osc('triangle', 260 * k, 520 * k, t, 0.1, 0.06); noiseHit(t, 0.08, 0.05, 5000, 1500, 1, 'bandpass'); break;
    case 'gcubehit': noiseHit(t, 0.16, 0.14, 3200, 300, 1); osc('sine', 150, 55, t, 0.2, 0.2); osc('square', 700 + a * 60, 200, t, 0.05, 0.05); break;
    case 'gspin': osc('sawtooth', 140 * k, 520 * k, t, 0.32, 0.07); noiseHit(t, 0.3, 0.06, 500, 4000, 1.2, 'bandpass'); break;
    case 'gslam': osc('sine', 90, 28, t, 0.5, 0.45); noiseHit(t, 0.35, 0.22, 2600, 120, 1); osc('square', 180 * k, 60, t, 0.16, 0.1); break;
    case 'gclap': noiseHit(t, 0.14, 0.2, 7000, 800, 1, 'highpass'); osc('square', 880 * k, 440 * k, t, 0.08, 0.08); osc('square', 1320 * k, 660 * k, t + 0.03, 0.08, 0.06); osc('sine', 240, 60, t, 0.35, 0.3); break;
    case 'gcinder': noiseHit(t, 0.35, 0.1, 400, 3500, 1, 'lowpass'); osc('triangle', 200 * k, 520 * k, t, 0.3, 0.08); break;
    case 'gbloom': osc('triangle', 520 * k, 980 * k, t, 0.14, 0.09); noiseHit(t, 0.12, 0.08, 4000, 800, 1); osc('sine', 120, 70, t, 0.14, 0.12); break;
    case 'gdash': noiseHit(t, 0.28, 0.14, 800, 7000, 1.4, 'bandpass'); osc('sawtooth', 300 * k, 1500 * k, t, 0.18, 0.04); osc('sine', 600 * k, 200, t + 0.06, 0.2, 0.05); break;
    case 'grewind': noiseHit(t, 0.4, 0.1, 6000, 300, 1.2, 'bandpass'); [0, -2, -5, -9, -14].forEach((n, i) => osc('triangle', nf(86 + n), nf(86 + n) * 0.9, t + i * 0.045, 0.2, 0.07)); break;
    case 'gboom': osc('square', 440 * k, 660 * k, t, 0.1, 0.05); osc('triangle', 880 * k, 440 * k, t, 0.12, 0.05); break;
    case 'gcatch': osc('sine', nf(96), nf(96), t, 0.25, 0.08); osc('triangle', nf(103), nf(103), t + 0.05, 0.3, 0.06); break;
    case 'gbeamup': osc('sawtooth', 120 * k, 900 * k, t, 0.4, 0.05); osc('sine', 240 * k, 1800 * k, t, 0.4, 0.05); break;
    case 'gbeam': noiseHit(t, 0.5, 0.18, 7000, 900, 1, 'highpass'); [0, 7, 12, 16].forEach((n, i) => osc('square', nf(72 + n), nf(72 + n), t + i * 0.01, 0.4, 0.06)); osc('sine', 120, 40, t, 0.5, 0.3); break;
    case 'gwhirl': noiseHit(t, 0.9, 0.12, 500, 2500, 2, 'bandpass'); osc('sine', 220 * k, 440 * k, t, 0.8, 0.05); break;
    case 'gstasis': osc('sine', nf(76), nf(76), t, 0.9, 0.12); osc('triangle', nf(88), nf(88) * 0.98, t, 0.8, 0.07); noiseHit(t, 0.4, 0.04, 6000, 3000, 1, 'highpass'); break;
    case 'gmeteor': osc('sawtooth', 1400, 200, t, 0.7, 0.06); noiseHit(t, 0.7, 0.07, 6000, 500, 1, 'bandpass'); break;
    case 'gmeteorhit': osc('sine', 80, 24, t, 0.6, 0.5); noiseHit(t, 0.55, 0.3, 3000, 100, 1); osc('sawtooth', 300, 60, t, 0.3, 0.1); break;
    case 'glevel': [0, 4, 7, 12, 16].forEach((n, i) => osc('triangle', nf(79 + n), nf(79 + n), t + i * 0.06, 0.4, 0.08)); osc('sine', nf(103), nf(103), t + 0.3, 0.5, 0.05); break;
    case 'gsocket': noiseHit(t, 0.06, 0.1, 2800, 900, 1.5, 'bandpass'); osc('square', 400, 700, t, 0.06, 0.05); osc('triangle', nf(88), nf(88), t + 0.04, 0.16, 0.07); break;
    case 'gunsock': noiseHit(t, 0.08, 0.08, 1800, 500, 1, 'bandpass'); osc('triangle', nf(84), nf(76), t, 0.14, 0.06); break;
    case 'gdeny': osc('square', 170, 130, t, 0.1, 0.06); break;
    case 'gspark': osc('square', 300, 180, t, 0.06, 0.05); break;
    case 'gcls': osc('triangle', nf(84), nf(91), t, 0.14, 0.07); osc('sine', nf(96), nf(96), t + 0.06, 0.25, 0.05); break;
    case 'gunlock': [0, 4, 7, 12, 16, 19, 24].forEach((n, i) => { osc('square', nf(60 + n), nf(60 + n), t + i * 0.08, 0.4, 0.05); osc('triangle', nf(72 + n), nf(72 + n), t + i * 0.08, 0.8, 0.07); }); break;
    case 'gstarup': osc('sawtooth', 80, 700, t, 0.9, 0.06); noiseHit(t, 0.9, 0.06, 500, 8000, 1.2, 'bandpass'); break;
    case 'gstar': // the Star Power sting: the shard arpeggio, doubled an octave up, over a rising swell and a sparkle shimmer
      [0, 4, 7, 11, 12, 16, 19, 23, 24, 28].forEach((n, i) => { osc('sine', nf(67 + n), nf(67 + n), t + i * 0.055, 1.3, 0.09); osc('triangle', nf(79 + n), nf(79 + n), t + i * 0.055, 0.7, 0.05); osc('square', nf(91 + n), nf(91 + n), t + 0.1 + i * 0.055, 0.12, 0.03); });
      osc('sine', 70, 140, t, 1.2, 0.3); osc('sawtooth', 110, 440, t, 1.0, 0.05); noiseHit(t + 0.3, 1.4, 0.07, 9000, 2500, 1, 'highpass'); break;
    case 'gstarend': [0, -3, -7, -12, -15].forEach((n, i) => osc('triangle', nf(88 + n), nf(88 + n), t + i * 0.09, 0.5, 0.07)); noiseHit(t, 0.5, 0.05, 6000, 800, 1, 'highpass'); break;
    case 'gstarhit': osc('square', nf(96 + Math.min(10, a)), nf(96 + Math.min(10, a)), t, 0.06, 0.06); osc('square', nf(103 + Math.min(10, a)), nf(103 + Math.min(10, a)), t + 0.06, 0.16, 0.06); osc('sine', 130, 60, t, 0.14, 0.2); break;
    case 'gstartick': osc('triangle', nf(100 + a), nf(100 + a), t, 0.07, 0.025); break;
    case 'gform': [0, 4, 7, 12, 16].forEach((n, i) => osc('square', nf(64 + n), nf(64 + n), t + i * 0.05, 0.16, 0.05)); osc('triangle', nf(88), nf(100), t, 0.5, 0.06); break;
    case 'gformend': osc('triangle', nf(86), nf(70), t, 0.4, 0.06); break;
    case 'gfire': noiseHit(t, 0.12, 0.08, 800, 3500, 1, 'lowpass'); osc('triangle', 300 * k, 600 * k, t, 0.1, 0.05); break;
  }
}

