// ---- procedural icons (canvas): item icons from (slot, rarity, seed), perk sigils ------------------------------------------------------------------------
const ICON_CACHE = new Map(), SIGIL_CACHE = new Map();
function rpgPath(c, pts, close = true) { c.beginPath(); pts.forEach((p, i) => i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])); if (close) c.closePath(); }
function rpgRR(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
function rpgIconBase(item) {
  const key = item.slot + item.rarity + (item.seed % 360) + (item.legendary || ''); let cv = ICON_CACHE.get(key); if (cv) return cv;
  cv = document.createElement('canvas'); cv.width = cv.height = 96; const c = cv.getContext('2d'), ri = RPG_RARITIES.indexOf(item.rarity), col = RPG_RARITY_COL[ri], hue = (item.seed * 137) % 360;
  const acc = ri === 3 ? '#ffb347' : `hsl(${hue},62%,58%)`, accD = ri === 3 ? '#b4561a' : `hsl(${hue},55%,34%)`, accL = ri === 3 ? '#ffe3a8' : `hsl(${hue},75%,78%)`, metal = '#aab6c2', metalD = '#59636e';
  const bg = c.createRadialGradient(48, 40, 6, 48, 48, 62); bg.addColorStop(0, ri === 0 ? '#2b3a4a' : ri === 1 ? '#1d3d6b' : ri === 2 ? '#5a4a12' : '#6b3208'); bg.addColorStop(1, '#0c1622'); c.fillStyle = bg; rpgRR(c, 2, 2, 92, 92, 16); c.fill();
  if (ri === 3) { c.save(); c.translate(48, 48); for (let i = 0; i < 12; i++) { c.rotate(PI / 6); c.fillStyle = 'rgba(255,170,60,.16)'; rpgPath(c, [[0, 0], [-5, -46], [5, -46]]); c.fill(); } c.restore(); }
  c.lineJoin = 'round'; c.lineWidth = 3; c.strokeStyle = 'rgba(8,14,22,.95)';
  const fill = (g, f) => { c.fillStyle = f || g; c.fill(); c.stroke(); };
  const grad = (y0, y1, a, b) => { const g = c.createLinearGradient(0, y0, 0, y1); g.addColorStop(0, a); g.addColorStop(1, b); return g; };
  if (item.slot === 'cap') { c.beginPath(); c.arc(46, 56, 28, PI, 0); c.closePath(); fill(grad(28, 56, accL, accD)); rpgRR(c, 14, 54, 76, 11, 5); fill(grad(54, 66, accD, '#222')); c.beginPath(); c.arc(46, 25, 4, 0, TAU); fill(metal); c.strokeStyle = 'rgba(255,255,255,.35)'; c.lineWidth = 2; c.beginPath(); c.moveTo(46, 30); c.lineTo(46, 54); c.stroke(); c.beginPath(); c.arc(46, 56, 20, PI * 1.1, PI * 1.45); c.stroke(); }
  else if (item.slot === 'gloves') { for (let i = 0; i < 4; i++) { rpgRR(c, 28 + i * 10, 22 + (i === 1 || i === 2 ? -4 : 2), 9, 30, 4.5); fill(grad(20, 52, accL, acc)); } rpgRR(c, 26, 46, 42, 30, 9); fill(grad(46, 76, acc, accD)); c.save(); c.translate(24, 56); c.rotate(-0.75); rpgRR(c, -5, -3, 24, 11, 5); fill(grad(-3, 8, accL, acc)); c.restore(); rpgRR(c, 24, 72, 46, 12, 4); fill(metal); }
  else if (item.slot === 'boots') { rpgRR(c, 30, 14, 28, 46, 7); fill(grad(14, 60, accL, acc)); c.beginPath(); c.moveTo(30, 54); c.lineTo(58, 54); c.quadraticCurveTo(84, 54, 86, 70); c.lineTo(86, 76); c.lineTo(22, 76); c.lineTo(22, 62); c.closePath(); fill(grad(54, 76, acc, accD)); rpgRR(c, 20, 74, 68, 9, 4); fill(metalD); rpgRR(c, 30, 14, 28, 9, 4); fill(metal); }
  else if (item.slot === 'body') { rpgPath(c, [[28, 32], [68, 32], [74, 80], [22, 80]]); fill(grad(32, 80, acc, accD)); rpgRR(c, 33, 12, 7, 26, 3); fill(accL); rpgRR(c, 56, 12, 7, 26, 3); fill(accL); rpgRR(c, 38, 52, 20, 15, 3); fill(grad(52, 67, accD, '#222')); [[36, 36], [60, 36]].forEach(([x, y]) => { c.beginPath(); c.arc(x, y, 3.2, 0, TAU); fill(metal); }); c.strokeStyle = 'rgba(255,255,255,.3)'; c.lineWidth = 2; c.beginPath(); c.moveTo(48, 36); c.lineTo(48, 78); c.stroke(); }
  else { c.lineWidth = 5; c.strokeStyle = metal; c.beginPath(); c.arc(48, 22, 11, 0, TAU); c.stroke(); c.lineWidth = 3; c.strokeStyle = 'rgba(8,14,22,.95)'; c.beginPath(); c.arc(48, 58, 27, 0, TAU); fill(grad(31, 85, metal, metalD)); c.beginPath(); c.arc(48, 58, 20, 0, TAU); fill(grad(38, 78, accD, '#10202e')); rpgPath(c, [[48, 42], [60, 58], [48, 74], [36, 58]]); fill(grad(42, 74, accL, acc)); c.fillStyle = 'rgba(255,255,255,.55)'; rpgPath(c, [[48, 46], [54, 54], [48, 56], [42, 54]]); c.fill(); }
  if (ri >= 2) { for (let i = 0; i < ri; i++) { c.beginPath(); c.arc(80 - i * 9, 14, 3.2, 0, TAU); c.fillStyle = col; c.fill(); } }
  c.lineWidth = 3; c.strokeStyle = col; c.globalAlpha = ri === 0 ? 0.25 : 0.75; rpgRR(c, 3, 3, 90, 90, 15); c.stroke(); c.globalAlpha = 1; ICON_CACHE.set(key, cv); return cv;
}
function rpgDrawIcon(canvas, item) { canvas.width = canvas.height = 96; canvas.getContext('2d').drawImage(rpgIconBase(item), 0, 0); }
function rpgSigil(canvas, glyph, color = '#ffd66b') {
  canvas.width = canvas.height = 96; const c = canvas.getContext('2d'), key = glyph + color; let src = SIGIL_CACHE.get(key);
  if (!src) {
    src = document.createElement('canvas'); src.width = src.height = 96; const k = src.getContext('2d'); k.translate(48, 48);
    const bg = k.createRadialGradient(0, -8, 4, 0, 0, 46); bg.addColorStop(0, '#2c4a66'); bg.addColorStop(1, '#0b1622'); k.fillStyle = bg; k.beginPath(); k.arc(0, 0, 45, 0, TAU); k.fill(); k.lineWidth = 3; k.strokeStyle = color; k.globalAlpha = 0.8; k.beginPath(); k.arc(0, 0, 44, 0, TAU); k.stroke(); k.globalAlpha = 1;
    k.lineWidth = 5; k.lineJoin = k.lineCap = 'round'; k.strokeStyle = color; k.fillStyle = color;
    const P2 = (pts, close) => { k.beginPath(); pts.forEach((p, i) => i ? k.lineTo(p[0], p[1]) : k.moveTo(p[0], p[1])); if (close) k.closePath(); };
    switch (glyph) {
      case 'burst': for (let i = 0; i < 8; i++) { const a = i * PI / 4; k.beginPath(); k.moveTo(Math.cos(a) * 9, Math.sin(a) * 9); k.lineTo(Math.cos(a) * 26, Math.sin(a) * 26); k.stroke(); } k.beginPath(); k.arc(0, 0, 6, 0, TAU); k.fill(); break;
      case 'chain': k.beginPath(); k.arc(-9, 0, 13, 0, TAU); k.stroke(); k.beginPath(); k.arc(9, 0, 13, 0, TAU); k.stroke(); break;
      case 'coin': k.beginPath(); k.arc(0, 0, 20, 0, TAU); k.stroke(); k.font = '900 26px sans-serif'; k.textAlign = 'center'; k.textBaseline = 'middle'; k.fillText('$', 0, 2); break;
      case 'spiral': k.beginPath(); for (let i = 0; i < 60; i++) { const a = i * 0.26, r = 2 + i * 0.4; i ? k.lineTo(Math.cos(a) * r, Math.sin(a) * r) : k.moveTo(2, 0); } k.stroke(); break;
      case 'ricochet': P2([[-24, 12], [-8, -14], [8, 14], [24, -12]]); k.stroke(); P2([[24, -12], [14, -12], [24, -2]], true); k.fill(); break;
      case 'heart': k.beginPath(); k.moveTo(0, 20); k.bezierCurveTo(-34, -2, -16, -28, 0, -12); k.bezierCurveTo(16, -28, 34, -2, 0, 20); k.fill(); break;
      case 'up': P2([[0, -24], [20, 2], [8, 2], [8, 22], [-8, 22], [-8, 2], [-20, 2]], true); k.fill(); break;
      case 'bolt': P2([[6, -26], [-14, 4], [-2, 4], [-8, 26], [16, -6], [3, -6]], true); k.fill(); break;
      case 'wall': for (let r = 0; r < 3; r++) for (let q = 0; q < 2; q++) k.strokeRect(-22 + q * 22 + (r % 2) * 11, -20 + r * 14, 22, 14); break;
      case 'fist': rpgRR(k, -18, -8, 34, 26, 8); k.fill(); for (let i = 0; i < 4; i++) { rpgRR(k, -18 + i * 9, -20, 8, 16, 4); k.fill(); } break;
      case 'meteor': k.beginPath(); k.arc(8, 8, 13, 0, TAU); k.fill(); k.lineWidth = 6; k.beginPath(); k.moveTo(-4, -4); k.lineTo(-26, -26); k.moveTo(-6, 6); k.lineTo(-24, -2); k.moveTo(6, -6); k.lineTo(-2, -24); k.stroke(); break;
      case 'dive': P2([[0, 26], [-18, 0], [-6, 0], [-6, -24], [6, -24], [6, 0], [18, 0]], true); k.fill(); break;
      case 'drop': k.beginPath(); k.moveTo(0, -24); k.bezierCurveTo(26, 4, 18, 24, 0, 24); k.bezierCurveTo(-18, 24, -26, 4, 0, -24); k.fill(); break;
      case 'shield': P2([[0, -24], [22, -14], [20, 8], [0, 26], [-20, 8], [-22, -14]], true); k.stroke(); k.globalAlpha = 0.4; k.fill(); k.globalAlpha = 1; break;
      case 'clover': for (const [x, y] of [[-8, -8], [8, -8], [-8, 8], [8, 8]]) { k.beginPath(); k.arc(x, y, 9, 0, TAU); k.fill(); } k.beginPath(); k.moveTo(0, 6); k.lineTo(4, 26); k.stroke(); break;
      case 'dust': for (const [x, y, s] of [[-10, 6, 11], [10, 8, 9], [0, -10, 12]]) { P2([[x, y - s], [x + s * 0.7, y], [x, y + s], [x - s * 0.7, y]], true); k.fill(); } break;
      case 'book': rpgRR(k, -20, -18, 40, 36, 4); k.stroke(); k.beginPath(); k.moveTo(0, -18); k.lineTo(0, 18); k.stroke(); break;
      case 'eye': k.beginPath(); k.moveTo(-26, 0); k.quadraticCurveTo(0, -26, 26, 0); k.quadraticCurveTo(0, 26, -26, 0); k.stroke(); k.beginPath(); k.arc(0, 0, 8, 0, TAU); k.fill(); break;
      case 'star': P2(Array.from({ length: 10 }, (_, i) => { const r = i % 2 ? 11 : 26, a = -PI / 2 + i * PI / 5; return [Math.cos(a) * r, Math.sin(a) * r]; }), true); k.fill(); break;
      case 'ghost': k.beginPath(); k.moveTo(-18, 22); k.lineTo(-18, -4); k.arc(0, -4, 18, PI, 0); k.lineTo(18, 22); k.lineTo(9, 14); k.lineTo(0, 22); k.lineTo(-9, 14); k.closePath(); k.fill(); k.fillStyle = '#0b1622'; k.beginPath(); k.arc(-7, -4, 3.5, 0, TAU); k.arc(7, -4, 3.5, 0, TAU); k.fill(); break;
      case 'crown': P2([[-24, 16], [-24, -12], [-10, 2], [0, -18], [10, 2], [24, -12], [24, 16]], true); k.fill(); break;
      case 'magnet': k.lineWidth = 9; k.beginPath(); k.arc(0, -2, 17, PI, 0); k.lineTo(17, 18); k.moveTo(-17, -2); k.lineTo(-17, 18); k.stroke(); break;
      default: k.beginPath(); k.arc(0, 0, 14, 0, TAU); k.fill();
    }
    SIGIL_CACHE.set(key, src);
  }
  canvas.getContext('2d').drawImage(src, 0, 0);
}

