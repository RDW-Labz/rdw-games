// ============================================================================
// AUDIO: WebAudio chiptune-flavoured sfx + generative two-layer music bed (warm pads <-> 8-bit square/triangle), crossfaded by the world's voxel state
// ============================================================================
let AC = null, master = null, sfxBus = null, musicBus = null, revBus = null, gReal = null, gVox = null, muted = false, noiseBuf = null;
try { muted = localStorage.getItem('swn_mute') === '1'; } catch (e) { }
function audioInit() {
  if (AC) { if (AC.state === 'suspended') AC.resume(); return; }
  try {
    AC = new (window.AudioContext || window.webkitAudioContext)(); if (AC.state === 'suspended') AC.resume();
    master = AC.createGain(); master.gain.value = muted ? 0 : 0.85; const comp = AC.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4; master.connect(comp); comp.connect(AC.destination);
    sfxBus = AC.createGain(); sfxBus.gain.value = 0.8; sfxBus.connect(master); musicBus = AC.createGain(); musicBus.gain.value = 0.42; musicBus.connect(master);
    gReal = AC.createGain(); gVox = AC.createGain(); gReal.connect(musicBus); gVox.connect(musicBus); gVox.gain.value = 0;
    // cheap reverb: decaying noise impulse
    const len = AC.sampleRate * 2.4, ir = AC.createBuffer(2, len, AC.sampleRate); for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6); }
    const conv = AC.createConvolver(); conv.buffer = ir; revBus = AC.createGain(); revBus.gain.value = 0.55; revBus.connect(conv); conv.connect(gReal);
    noiseBuf = AC.createBuffer(1, AC.sampleRate * 1.5, AC.sampleRate); const nd = noiseBuf.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    musicT = AC.currentTime + 0.3;
  } catch (e) { AC = null; }
}
function setMuted(m) { muted = m; try { localStorage.setItem('swn_mute', m ? '1' : '0'); } catch (e) { } if (master) master.gain.setTargetAtTime(m ? 0 : 0.85, AC.currentTime, 0.05); const t = $('muteTag'); if (t) t.textContent = m ? 'MUTED' : ''; }
let SFXP = 1; // per-class pitch of the hero's action sounds (set around sfx() by the class layer)
function osc(type, f0, f1, t, dur, g, dest, detune = 0) {
  if (SFXP !== 1) { f0 *= SFXP; f1 *= SFXP; }
  const o = AC.createOscillator(), v = AC.createGain(); o.type = type; o.frequency.setValueAtTime(f0, t); if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur); if (detune) o.detune.value = detune;
  v.gain.setValueAtTime(0.0001, t); v.gain.exponentialRampToValueAtTime(Math.max(0.0002, g), t + Math.min(0.012, dur * 0.2)); v.gain.exponentialRampToValueAtTime(0.0001, t + dur); o.connect(v); v.connect(dest || sfxBus); o.start(t); o.stop(t + dur + 0.03); return o;
}
function noiseHit(t, dur, g, f0, f1, q = 1, type = 'lowpass', dest) {
  const s = AC.createBufferSource(), fl = AC.createBiquadFilter(), v = AC.createGain(); s.buffer = noiseBuf; fl.type = type; fl.frequency.setValueAtTime(f0, t); fl.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur); fl.Q.value = q;
  v.gain.setValueAtTime(0.0001, t); v.gain.exponentialRampToValueAtTime(Math.max(0.0002, g), t + Math.min(0.01, dur * 0.2)); v.gain.exponentialRampToValueAtTime(0.0001, t + dur); s.connect(fl); fl.connect(v); v.connect(dest || sfxBus); s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.03);
}
const nf = n => 440 * Math.pow(2, (n - 69) / 12);
let lastSfx = {};
function sfx(name, a = 0) {
  if (VR.presenting) vrSfxHaptic(name, a);
  if (!AC || muted) return; const t = AC.currentTime, now = performance.now(); if (lastSfx[name] && now - lastSfx[name] < 30) return; lastSfx[name] = now;
  switch (name) {
    case 'jump': osc('square', 300, 640, t, 0.14, 0.09); osc('sine', 150, 320, t, 0.14, 0.12); break;
    case 'jump2': osc('square', 380, 820, t, 0.15, 0.09); osc('triangle', 190, 410, t, 0.15, 0.12); break;
    case 'jump3': [0, 4, 7, 12].forEach((n, i) => osc('square', nf(64 + n), nf(64 + n) * 1.05, t + i * 0.055, 0.12, 0.07)); noiseHit(t, 0.3, 0.03, 4000, 800, 1, 'highpass'); break;
    case 'long': osc('sawtooth', 200, 700, t, 0.3, 0.06); noiseHit(t, 0.25, 0.05, 3000, 600, 1, 'bandpass'); break;
    case 'flip': osc('triangle', 260, 900, t, 0.3, 0.1); osc('square', 520, 1400, t + 0.02, 0.2, 0.04); break;
    case 'kick': osc('square', 220, 90, t, 0.12, 0.1); noiseHit(t, 0.1, 0.1, 3000, 400, 1); break;
    case 'land': osc('sine', 130, 50, t, 0.14, 0.18 * Math.min(1.4, 0.4 + a)); noiseHit(t, 0.08, 0.06 * (0.5 + a), 1500, 300); break;
    case 'coin': { const n = 83 + Math.min(10, a) * 1; osc('square', nf(n), nf(n), t, 0.07, 0.07); osc('square', nf(n + 5), nf(n + 5), t + 0.07, 0.22, 0.07); break; }
    case 'stomp': osc('square', 400, 120, t, 0.14, 0.12); noiseHit(t, 0.1, 0.08, 2500, 300); break;
    case 'bump': osc('square', 160, 110, t, 0.1, 0.14); osc('triangle', 90, 60, t, 0.14, 0.18); break;
    case 'bonk': osc('square', 120, 70, t, 0.14, 0.14); break;
    case 'punch': noiseHit(t, 0.09, 0.1, 5000, 800, 1, 'bandpass'); osc('square', 240, 150, t, 0.08, 0.06); break;
    case 'dive': noiseHit(t, 0.3, 0.07, 1000, 3500, 1, 'bandpass'); osc('sawtooth', 300, 500, t, 0.2, 0.04); break;
    case 'poundstart': osc('triangle', 600, 1200, t, 0.22, 0.09); break;
    case 'poundgo': noiseHit(t, 0.35, 0.09, 2500, 500, 1, 'bandpass'); osc('sawtooth', 500, 90, t, 0.3, 0.06); break;
    case 'pound': osc('sine', 90, 28, t, 0.5, 0.5); noiseHit(t, 0.4, 0.22, 2200, 90, 1); osc('square', 140, 50, t, 0.2, 0.1); break;
    case 'hurt': osc('sawtooth', 500, 90, t, 0.35, 0.12); osc('square', 330, 80, t, 0.3, 0.06); break;
    case 'powerup_spawn': osc('triangle', 300, 600, t, 0.3, 0.1); break;
    case 'powerup': [0, 4, 7, 12, 16, 19].forEach((n, i) => osc('square', nf(60 + n), nf(60 + n), t + i * 0.07, 0.15, 0.07)); break;
    case 'pipe': osc('sine', 400, 80, t, 0.4, 0.2); osc('square', 200, 50, t, 0.4, 0.05); break;
    case 'talk': osc('triangle', nf(72), nf(72), t, 0.07, 0.1); osc('triangle', nf(76), nf(76), t + 0.08, 0.09, 0.1); break;
    case 'shard': [0, 4, 7, 11, 12, 16, 19, 23].forEach((n, i) => { osc('sine', nf(72 + n), nf(72 + n), t + i * 0.05, 1.2, 0.09); osc('triangle', nf(84 + n), nf(84 + n), t + i * 0.05, 0.6, 0.04); }); noiseHit(t, 0.8, 0.04, 6000, 1500, 1, 'highpass'); break;
    case 'shatter': noiseHit(t, 1.1, 0.35, 5000, 200, 0.8); osc('sine', 120, 34, t, 1.0, 0.5); osc('sawtooth', 800, 100, t, 0.6, 0.07); [0, 3, 7, 10, 14].forEach((n, i) => osc('square', nf(88 - n), nf(88 - n), t + 0.1 + i * 0.06, 0.2, 0.04)); break;
    case 'shatter_big': noiseHit(t, 2.2, 0.45, 6000, 120, 0.8); osc('sine', 100, 24, t, 1.8, 0.6); osc('sawtooth', 1200, 60, t, 1.2, 0.09); noiseHit(t + 0.05, 1.4, 0.2, 400, 4000, 1.5, 'bandpass'); for (let i = 0; i < 10; i++) osc('square', nf(96 - i * 2), nf(96 - i * 2), t + 0.15 + i * 0.09, 0.22, 0.04); break;
    case 'shatter_small': noiseHit(t, 0.35, 0.12, 4500, 400, 1); for (let i = 0; i < 4; i++) osc('square', 300 + Math.random() * 700, 100, t + i * 0.03, 0.08, 0.04); break;
    case 'heal': for (let i = 0; i < 6; i++) osc('triangle', nf(72 + [0, 4, 7, 11, 12, 16][i]), nf(72 + [0, 4, 7, 11, 12, 16][i]), t + i * 0.06, 0.5, 0.07); break;
    case 'rebuild': for (let i = 0; i < 12; i++) osc('square', nf(48 + [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26][i]), nf(48 + [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26][i]), t + i * 0.16, 0.14, 0.05); osc('sine', 60, 240, t, 2.2, 0.15); break;
    case 'rewind': noiseHit(t, 0.35, 0.07, 400, 5000, 1.2, 'bandpass'); osc('triangle', 900, 200, t, 0.3, 0.05); break;
    case 'click': osc('square', 660, 880, t, 0.06, 0.07); break;
    case 'victory': for (let i = 0; i < 16; i++) { const n = [0, 4, 7, 12, 16, 19, 24, 28][i % 8] + (i > 7 ? 5 : 0); osc('square', nf(60 + n), nf(60 + n), t + i * 0.11, 0.3, 0.06); osc('triangle', nf(48 + n), nf(48 + n), t + i * 0.11, 0.5, 0.08); } break;
    case 'die': osc('sawtooth', 500, 60, t, 0.9, 0.12); osc('square', 250, 40, t, 0.9, 0.08); break;
  }
}
const PENTA = [0, 2, 4, 7, 9];
function sfxClack(x, y, z) { // quantised to a pentatonic scale by height, panned by screen position
  if (!AC || muted) return; const t = AC.currentTime, q = Math.floor(((y * 0.9 + x * 0.21 + z * 0.13) % 15 + 15) % 15), oct = (q / 5) | 0, n = 60 + PENTA[q % 5] + oct * 12; const pan = AC.createStereoPanner ? AC.createStereoPanner() : null;
  const g = AC.createGain(); g.gain.value = 0.55; let dest = g; if (pan) { const dx = x - CP.x, dz = z - CP.z, rr = Math.cos(CAM.yaw) * dx - Math.sin(CAM.yaw) * dz; pan.pan.value = clamp(-rr / 30, -0.8, 0.8); g.connect(pan); pan.connect(sfxBus); } else g.connect(sfxBus);
  osc('triangle', nf(n), nf(n), t, 0.16, 0.05, g); osc('square', nf(n + 12), nf(n + 12), t, 0.04, 0.03, g); noiseHit(t, 0.03, 0.04, 6000, 3000, 1, 'highpass', g);
}

// ---- music ------------------------------------------------------------------------------------------------------------------
const MUSIC = {
  1: { root: 48, chords: [[0, 4, 7, 11], [9, 12, 16, 19], [5, 9, 12, 16], [7, 11, 14, 17]], scale: [0, 2, 4, 7, 9], bpm: 78 },      // C maj7 / Am7 / F maj7 / G6: warm golden valley
  2: { root: 53, chords: [[0, 4, 7, 11], [2, 5, 9, 12], [4, 7, 11, 14], [7, 11, 14, 18]], scale: [0, 2, 4, 6, 7, 9, 11], bpm: 92 },   // F lydian dream
  3: { root: 45, chords: [[0, 3, 7, 10], [5, 8, 12, 15], [3, 7, 10, 14], [7, 10, 14, 17]], scale: [0, 3, 5, 7, 10], bpm: 104 },     // A minor neon
};
let musicT = 0, mStep = 0, musicVoxNow = 0;
function padVoice(f, t, dur) {
  for (const d of [-6, 6]) { const o = AC.createOscillator(), v = AC.createGain(), fl = AC.createBiquadFilter(); o.type = 'triangle'; o.frequency.value = f; o.detune.value = d; fl.type = 'lowpass'; fl.frequency.value = 1100; v.gain.setValueAtTime(0.0001, t); v.gain.linearRampToValueAtTime(0.05, t + 1.4); v.gain.linearRampToValueAtTime(0.03, t + dur * 0.7); v.gain.linearRampToValueAtTime(0.0001, t + dur + 1.6); o.connect(fl); fl.connect(v); v.connect(gReal); v.connect(revBus); o.start(t); o.stop(t + dur + 1.7); }
}
function pluck(f, t, layer) {
  if (layer === 0) { osc('sine', f, f, t, 0.9, 0.06, gReal); osc('triangle', f * 2, f * 2, t, 0.35, 0.025, gReal); const o = osc('sine', f, f, t, 0.9, 0.02, revBus); }
  else { osc('square', f, f, t, 0.16, 0.035, gVox); }
}
function scheduleMusic() {
  if (!AC || !gReal) return; const M = MUSIC[Math.min(3, Math.max(1, G.act))] || MUSIC[1], sd = 60 / M.bpm / 2, ahead = 0.25; if (musicT < AC.currentTime - 0.5) musicT = AC.currentTime + 0.1;
  while (musicT < AC.currentTime + ahead) {
    const st = mStep, ci = ((st / 16) | 0) % 4, ch = M.chords[ci], t = musicT, r = M.root;
    const doReal = gReal.gain.value > 0.03, doVox = gVox.gain.value > 0.03;
    if (st % 16 === 0 && doReal) ch.forEach((n, i) => padVoice(nf(r + 12 + n + (i > 2 ? 0 : 0)), t + i * 0.04, sd * 16));
    if (doReal && st % 2 === 0 && Math.random() < 0.55) { const n = M.scale[(Math.random() * M.scale.length) | 0] + 12 * (1 + ((Math.random() * 2) | 0)); pluck(nf(r + 12 + n), t, 0); }
    if (doVox) {
      pluck(nf(r + 24 + ch[[0, 1, 2, 1, 3, 2, 1, 2][st % 8]]), t, 1);
      if (st % 4 === 0) osc('triangle', nf(r - 12 + ch[0]), nf(r - 12 + ch[0]), t, sd * 3.6, 0.09, gVox);
      if (st % 2 === 1) noiseHit(t, 0.04, 0.025, 9000, 7000, 1, 'highpass', gVox);
      if (st % 8 === 4) noiseHit(t, 0.08, 0.05, 1800, 600, 1, 'bandpass', gVox);
    }
    mStep++; musicT += sd;
  }
}
function updateMusic(rdt) {
  if (!AC || !gReal) return; const wantVox = clamp((G.act > 1 && !G.trans ? 0.9 : 0) + (G.trans ? Math.max(voxAtCPU(P.x, P.z), G.atmT * (G.trans.to > 1 ? 0.9 : 0.0)) : voxAtCPU(P.x, P.z) * 0.9), 0, 1);
  musicVoxNow = damp(musicVoxNow, wantVox, 2.2, rdt); gVox.gain.setTargetAtTime(musicVoxNow, AC.currentTime, 0.1); gReal.gain.setTargetAtTime(1 - musicVoxNow * 0.95, AC.currentTime, 0.1);
  if (G.state === 'play' || G.state === 'menu') scheduleMusic();
}

