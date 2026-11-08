// ==============================================================================================================================================================================================
// GEM ICONS (procedural canvas) + HUD (hotbar, Spark, Star meter, form badge)
// ==============================================================================================================================================================================================
const GEM_ICON_CACHE = new Map();
function gemGlyph(k, id, col) {
  k.strokeStyle = col; k.fillStyle = col; k.lineWidth = 4.5; k.lineCap = k.lineJoin = 'round'; const P2 = (pts, close) => { k.beginPath(); pts.forEach((p, i) => i ? k.lineTo(p[0], p[1]) : k.moveTo(p[0], p[1])); if (close) k.closePath(); };
  switch (id) {
    case 'cubetoss': P2([[-10, -4], [0, -10], [10, -4], [10, 8], [0, 14], [-10, 8]], true); k.stroke(); P2([[-10, -4], [0, 2], [10, -4]]); k.stroke(); P2([[0, 2], [0, 14]]); k.stroke(); break;
    case 'spinslam': k.beginPath(); k.arc(0, 0, 11, 0.4, 4.6); k.stroke(); P2([[-9, -12], [-4, -9], [-10, -5]]); k.fill(); k.beginPath(); k.arc(0, 0, 3, 0, TAU); k.fill(); break;
    case 'shockclap': P2([[-13, 2], [-4, -3], [-4, 7]], true); k.fill(); P2([[13, 2], [4, -3], [4, 7]], true); k.fill(); for (const a of [-0.7, 0, 0.7]) { k.beginPath(); k.moveTo(0, -4 + a * 4); k.lineTo(a * 9, -14); k.stroke(); } break;
    case 'gustdash': for (const [y, l] of [[-8, 12], [0, 18], [8, 12]]) { k.beginPath(); k.moveTo(-14, y); k.lineTo(-14 + l, y); k.stroke(); } P2([[4, -8], [14, 0], [4, 8]]); k.stroke(); break;
    case 'shardboomerang': k.beginPath(); k.moveTo(-12, 10); k.quadraticCurveTo(-14, -12, 10, -12); k.lineTo(10, -4); k.quadraticCurveTo(-4, -4, -4, 10); k.closePath(); k.fill(); break;
    case 'cinderbloom': for (let i = 0; i < 5; i++) { const a = i / 5 * TAU - PI / 2; k.beginPath(); k.ellipse(Math.cos(a) * 8, Math.sin(a) * 8, 5, 8, a + PI / 2, 0, TAU); k.fill(); } k.fillStyle = '#fff6c8'; k.beginPath(); k.arc(0, 0, 4, 0, TAU); k.fill(); break;
    case 'whirlgale': k.beginPath(); for (let i = 0; i < 50; i++) { const a = i * 0.3, r = 2 + i * 0.22; i ? k.lineTo(Math.cos(a) * r, Math.sin(a) * r) : k.moveTo(2, 0); } k.stroke(); break;
    case 'rewinddash': P2([[2, -10], [-9, 0], [2, 10]]); k.stroke(); P2([[13, -10], [2, 0], [13, 10]]); k.stroke(); break;
    case 'sunbeam': k.beginPath(); k.arc(-6, 6, 6, 0, TAU); k.fill(); k.beginPath(); k.moveTo(-2, 2); k.lineTo(14, -14); k.lineWidth = 7; k.stroke(); k.lineWidth = 3; for (const a of [0.2, 0.9, 1.6]) { k.beginPath(); k.moveTo(-6 + Math.cos(a) * 9, 6 - Math.sin(a) * 9); k.lineTo(-6 + Math.cos(a) * 14, 6 - Math.sin(a) * 14); k.stroke(); } break;
    case 'stasis': P2([[-8, -12], [8, -12], [0, 0], [8, 12], [-8, 12], [0, 0]], true); k.stroke(); break;
    case 'meteorfall': k.beginPath(); k.arc(5, 5, 7, 0, TAU); k.fill(); k.lineWidth = 4; for (const [a, b] of [[-3, -3], [-5, 4], [4, -5]]) { k.beginPath(); k.moveTo(a, b); k.lineTo(a - 10, b - 10); k.stroke(); } break;
    case 'chain': k.beginPath(); k.ellipse(-6, 0, 8, 5, -0.6, 0, TAU); k.stroke(); k.beginPath(); k.ellipse(6, 0, 8, 5, -0.6, 0, TAU); k.stroke(); break;
    case 'fork': P2([[0, 12], [0, 0], [-9, -10]]); k.stroke(); P2([[0, 0], [9, -10]]); k.stroke(); break;
    case 'pierce': P2([[-13, 0], [13, 0]]); k.stroke(); P2([[7, -7], [14, 0], [7, 7]]); k.stroke(); k.beginPath(); k.arc(0, 0, 6, 0, TAU); k.stroke(); break;
    case 'area': k.beginPath(); k.arc(0, 0, 13, 0, TAU); k.stroke(); k.beginPath(); k.arc(0, 0, 6, 0, TAU); k.stroke(); break;
    case 'echo': for (const r of [4, 9, 14]) { k.beginPath(); k.arc(0, 0, r, -1, 1); k.stroke(); } break;
    case 'haste': P2([[-12, -9], [-3, 0], [-12, 9]]); k.stroke(); P2([[0, -9], [9, 0], [0, 9]]); k.stroke(); break;
    case 'lifesteal': k.beginPath(); k.moveTo(0, -13); k.bezierCurveTo(13, 2, 9, 13, 0, 13); k.bezierCurveTo(-9, 13, -13, 2, 0, -13); k.fill(); break;
    case 'multicast': for (const [x, y] of [[-9, 6], [0, -8], [9, 6]]) { k.beginPath(); k.arc(x, y, 5, 0, TAU); k.fill(); } break;
    case 'added_ember': k.beginPath(); k.moveTo(0, -14); k.bezierCurveTo(14, 0, 10, 13, 0, 13); k.bezierCurveTo(-10, 13, -14, 0, 0, -14); k.fill(); k.fillStyle = '#fff2c8'; k.beginPath(); k.arc(0, 6, 4, 0, TAU); k.fill(); break;
    case 'added_gust': k.beginPath(); k.moveTo(-13, -4); k.quadraticCurveTo(0, -12, 8, -4); k.stroke(); k.beginPath(); k.moveTo(-13, 4); k.quadraticCurveTo(0, 12, 12, 4); k.stroke(); k.beginPath(); k.arc(9, -6, 4, 0, TAU); k.stroke(); break;
    case 'added_sun': k.beginPath(); k.arc(0, 0, 6, 0, TAU); k.fill(); for (let i = 0; i < 8; i++) { const a = i * PI / 4; k.beginPath(); k.moveTo(Math.cos(a) * 9, Math.sin(a) * 9); k.lineTo(Math.cos(a) * 14, Math.sin(a) * 14); k.stroke(); } break;
    case 'added_time': k.beginPath(); k.arc(0, 0, 12, 0, TAU); k.stroke(); P2([[0, -7], [0, 0], [6, 4]]); k.stroke(); break;
    case 'thrifty': k.beginPath(); k.arc(0, 0, 12, 0, TAU); k.stroke(); P2([[-6, 0], [6, 0]]); k.stroke(); break;
    default: k.beginPath(); k.arc(0, 0, 8, 0, TAU); k.fill();
  }
}
function gemElemOf(d) { return d.elem ? GEM_ELEMS[d.elem] : (d.tags && d.tags.length ? GEM_ELEMS[d.tags[d.tags.length - 1]] : null); } // supports carry no tags
function gemIconBase(id) {
  let cv = GEM_ICON_CACHE.get(id); if (cv) return cv; const d = GEM_BY_ID[id], base = GEM_COLORS[d.color].css, el = gemElemOf(d); cv = document.createElement('canvas'); cv.width = cv.height = 64; const c = cv.getContext('2d');
  const bg = c.createRadialGradient(32, 24, 4, 32, 32, 40); bg.addColorStop(0, base); bg.addColorStop(1, '#0c1622'); c.fillStyle = bg; c.beginPath(); const R = d.kind === 'skill' ? 29 : 27; for (let i = 0; i < 6; i++) { const a = -PI / 2 + i * PI / 3; c.lineTo(32 + Math.cos(a) * R, 32 + Math.sin(a) * R * (d.kind === 'skill' ? 1 : 0.92)); } c.closePath(); c.fill();
  c.lineWidth = 3; c.strokeStyle = RPG_RARITY_COL[d.tier]; c.stroke(); c.save(); c.translate(32, 32); c.shadowColor = 'rgba(0,0,0,.55)'; c.shadowBlur = 4; gemGlyph(c, id, el ? el.css : '#ffffff'); c.restore();
  c.fillStyle = 'rgba(255,255,255,.18)'; c.beginPath(); c.moveTo(32, 5); c.lineTo(50, 14); c.lineTo(32, 22); c.lineTo(14, 14); c.closePath(); c.fill(); GEM_ICON_CACHE.set(id, cv); return cv;
}
function gemDrawIcon(cv, g) { cv.width = cv.height = 64; cv.getContext('2d').drawImage(gemIconBase(g.id), 0, 0); }

