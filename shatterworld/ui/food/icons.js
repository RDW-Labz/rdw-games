// ---- icons (procedural canvas, cached): ingredients, materials, dishes, potions -------------------------------------------------------------------------------------------------------------------------
const FD_ICONS = new Map();
function fdIcon(kind, id, s = 64) {
  const key = kind + ':' + id + ':' + s; let c = FD_ICONS.get(key); if (c) return c; c = document.createElement('canvas'); c.width = c.height = s; const k = c.getContext('2d'); k.translate(s / 2, s / 2); k.scale(s / 64, s / 64);
  let glyph = 'bowl', col = '#ffd8a0';
  if (kind === 'dish' || kind === 'pot') { const r = FOOD_RECIPES[id.split(':')[0]]; if (r) { glyph = r.glyph; col = FOOD_FX[r.out.fx[0]].col; } } else { const d = fdDef(id); if (d) { glyph = d.glyph; col = d.col; } }
  k.lineWidth = 3; k.lineJoin = k.lineCap = 'round'; const dk = 'rgba(10,20,30,.55)', fill = col, ell = (x, y, rx, ry, a) => { k.beginPath(); k.ellipse(x, y, rx, ry, a || 0, 0, TAU); k.fill(); k.strokeStyle = dk; k.stroke(); };
  k.fillStyle = fill; k.strokeStyle = dk;
  switch (glyph) {
    case 'berry': ell(-7, 4, 11, 11); ell(9, 6, 9, 9); k.fillStyle = '#4ac070'; ell(0, -11, 7, 4, 0.5); break;
    case 'melon': ell(0, 2, 20, 17); k.strokeStyle = 'rgba(255,255,255,.5)'; for (const x of [-9, 0, 9]) { k.beginPath(); k.moveTo(x, -14); k.quadraticCurveTo(x * 1.4, 2, x, 18); k.stroke(); } break;
    case 'root': k.beginPath(); k.moveTo(-9, -12); k.lineTo(9, -12); k.lineTo(0, 24); k.closePath(); k.fill(); k.strokeStyle = dk; k.stroke(); k.fillStyle = '#4ac070'; ell(-4, -17, 3, 7, -0.3); ell(4, -17, 3, 7, 0.3); break;
    case 'grain': case 'corn': for (const x of [-9, 0, 9]) { k.fillStyle = fill; ell(x, 0, 5, 16, x * 0.02); } k.fillStyle = '#e8c860'; ell(0, 18, 14, 3); break;
    case 'leaf': case 'mint': k.beginPath(); k.moveTo(0, 22); k.quadraticCurveTo(-24, 0, 0, -22); k.quadraticCurveTo(24, 0, 0, 22); k.fill(); k.strokeStyle = dk; k.stroke(); k.strokeStyle = 'rgba(255,255,255,.55)'; k.beginPath(); k.moveTo(0, 22); k.lineTo(0, -14); k.stroke(); break;
    case 'cap': k.beginPath(); k.arc(0, 2, 20, PI, 0); k.closePath(); k.fill(); k.strokeStyle = dk; k.stroke(); k.fillStyle = '#f4ecd8'; k.fillRect(-6, 3, 12, 17); k.strokeRect(-6, 3, 12, 17); k.fillStyle = 'rgba(255,255,255,.6)'; for (const [x, y] of [[-8, -4], [5, -9], [10, -1]]) { k.beginPath(); k.arc(x, y, 2.8, 0, TAU); k.fill(); } break;
    case 'pepper': k.beginPath(); k.moveTo(-8, -12); k.quadraticCurveTo(14, -10, 8, 8); k.quadraticCurveTo(0, 24, -12, 22); k.quadraticCurveTo(-4, 6, -8, -12); k.fill(); k.strokeStyle = dk; k.stroke(); k.fillStyle = '#4ac070'; ell(-7, -14, 5, 3); break;
    case 'bean': case 'pod': ell(0, 0, 22, 8, 0.5); k.fillStyle = 'rgba(255,255,255,.7)'; for (const x of [-10, 0, 10]) { k.beginPath(); k.arc(x, -x * 0.5, 3, 0, TAU); k.fill(); } break;
    case 'drop': case 'flask': k.beginPath(); k.moveTo(-6, -20); k.lineTo(6, -20); k.lineTo(6, -8); k.quadraticCurveTo(24, 6, 16, 18); k.quadraticCurveTo(0, 28, -16, 18); k.quadraticCurveTo(-24, 6, -6, -8); k.closePath(); k.fill(); k.strokeStyle = dk; k.stroke(); k.fillStyle = 'rgba(255,255,255,.55)'; ell(-8, 8, 3, 6, 0.4); k.fillStyle = '#c8a070'; k.fillRect(-7, -25, 14, 6); break;
    case 'honey': k.fillStyle = '#c88a20'; k.fillRect(-14, -8, 28, 28); k.fillStyle = fill; k.fillRect(-14, -8, 28, 18); k.strokeRect(-14, -8, 28, 28); k.fillStyle = '#8a5a20'; k.fillRect(-16, -14, 32, 7); break;
    case 'salt': case 'powder': k.beginPath(); k.moveTo(-18, 18); k.lineTo(-8, -8); k.lineTo(2, 18); k.closePath(); k.fill(); k.strokeStyle = dk; k.stroke(); k.beginPath(); k.moveTo(0, 18); k.lineTo(10, -14); k.lineTo(20, 18); k.closePath(); k.fill(); k.stroke(); break;
    case 'haunch': case 'chop': case 'leg': ell(-2, 0, 17, 13, -0.4); k.fillStyle = '#f4ecd8'; ell(14, -10, 4, 9, -0.6); k.fillStyle = 'rgba(255,255,255,.35)'; ell(-6, -3, 6, 4, -0.4); break;
    case 'gland': ell(0, 0, 14, 18); k.fillStyle = 'rgba(255,255,255,.5)'; ell(-4, -6, 4, 6, 0.3); break;
    case 'roe': for (const [x, y] of [[-9, 6], [4, 8], [0, -6], [11, -3], [-7, -9]]) { k.fillStyle = fill; ell(x, y, 6.5, 6.5); } break;
    case 'claw': k.beginPath(); k.moveTo(-14, 18); k.quadraticCurveTo(-22, -6, 4, -18); k.quadraticCurveTo(-2, -4, 6, 2); k.quadraticCurveTo(20, 6, 14, 18); k.closePath(); k.fill(); k.strokeStyle = dk; k.stroke(); break;
    case 'bulb': ell(0, 6, 15, 14); k.fillStyle = '#4ac070'; for (const a of [-0.6, 0, 0.6]) ell(a * 14, -14, 3, 9, a); break;
    case 'egg': ell(0, 0, 14, 19); k.fillStyle = 'rgba(255,255,255,.6)'; ell(-5, -6, 3, 5, 0.4); break;
    case 'scrap': k.beginPath(); k.moveTo(-18, 8); k.lineTo(-8, -14); k.lineTo(10, -8); k.lineTo(18, 10); k.lineTo(-4, 18); k.closePath(); k.fill(); k.strokeStyle = dk; k.stroke(); k.fillStyle = 'rgba(255,255,255,.5)'; k.fillRect(-4, -2, 8, 3); break;
    case 'ore': case 'crystal': k.beginPath(); k.moveTo(0, -22); k.lineTo(14, -4); k.lineTo(9, 20); k.lineTo(-9, 20); k.lineTo(-14, -4); k.closePath(); k.fill(); k.strokeStyle = dk; k.stroke(); k.fillStyle = 'rgba(255,255,255,.45)'; k.beginPath(); k.moveTo(0, -22); k.lineTo(-14, -4); k.lineTo(-2, 0); k.closePath(); k.fill(); break;
    case 'hide': k.beginPath(); k.moveTo(-18, -12); k.quadraticCurveTo(0, -20, 18, -12); k.lineTo(12, 18); k.quadraticCurveTo(0, 12, -12, 18); k.closePath(); k.fill(); k.strokeStyle = dk; k.stroke(); break;
    case 'silk': k.lineWidth = 4; k.strokeStyle = fill; for (const y of [-12, -4, 4, 12]) { k.beginPath(); k.moveTo(-18, y); k.quadraticCurveTo(0, y - 8, 18, y); k.stroke(); } break;
    case 'timber': k.fillStyle = '#c8924a'; k.fillRect(-20, -12, 40, 9); k.fillRect(-20, 0, 40, 9); k.fillRect(-14, 12, 28, 8); k.fillStyle = 'rgba(0,0,0,.25)'; for (const y of [-12, 0, 12]) k.fillRect(-20, y + 3, 40, 2); break;
    case 'essence': k.beginPath(); k.moveTo(0, -22); k.quadraticCurveTo(14, -4, 0, 20); k.quadraticCurveTo(-14, -4, 0, -22); k.fill(); k.strokeStyle = dk; k.stroke(); k.fillStyle = 'rgba(255,255,255,.6)'; ell(-3, -2, 2.5, 6, 0.2); break;
    case 'bone': k.fillStyle = fill; k.beginPath(); k.arc(-14, -8, 6, 0, TAU); k.arc(-14, 2, 6, 0, TAU); k.arc(14, -8, 6, 0, TAU); k.arc(14, 2, 6, 0, TAU); k.fill(); k.fillRect(-14, -8, 28, 10); break;
    case 'ash': for (const [x, y, r] of [[-8, 6, 9], [8, 8, 7], [0, -6, 8]]) { ell(x, y, r, r * 0.8); } break;
    // dishes
    case 'salad': case 'stew': case 'bowl': case 'pie': case 'roast': case 'loaf': case 'skewer': case 'feast': case 'cake': {
      k.fillStyle = '#e8e0d0'; k.beginPath(); k.moveTo(-22, -2); k.lineTo(22, -2); k.quadraticCurveTo(20, 22, 0, 22); k.quadraticCurveTo(-20, 22, -22, -2); k.fill(); k.strokeStyle = dk; k.stroke();
      k.fillStyle = fill; if (glyph === 'loaf') { k.beginPath(); k.ellipse(0, -8, 17, 11, 0, PI, 0); k.fill(); k.stroke(); } else if (glyph === 'pie') { ell(0, -2, 19, 9); k.fillStyle = 'rgba(255,255,255,.4)'; ell(0, -2, 10, 4); } else if (glyph === 'cake') { k.fillRect(-14, -16, 28, 14); k.fillStyle = '#fff4f0'; k.fillRect(-14, -16, 28, 5); k.fillStyle = '#ffd45a'; k.beginPath(); k.arc(0, -20, 3, 0, TAU); k.fill(); }
      else if (glyph === 'skewer') { k.lineWidth = 3; k.strokeStyle = '#a8743a'; k.beginPath(); k.moveTo(-18, 6); k.lineTo(18, -16); k.stroke(); for (const t of [0.25, 0.5, 0.75]) { k.fillStyle = fill; ell(-18 + 36 * t, 6 - 22 * t, 6, 6); } }
      else { for (const [x, y, r] of glyph === 'feast' ? [[-12, -8, 7], [0, -12, 8], [12, -8, 7], [-5, -4, 6], [6, -4, 6]] : glyph === 'roast' ? [[-8, -6, 9], [8, -8, 8]] : [[-9, -6, 7], [2, -9, 8], [11, -5, 6]]) { k.fillStyle = fill; ell(x, y, r, r * 0.8); } }
      if (glyph === 'stew' || glyph === 'feast') { k.strokeStyle = 'rgba(255,255,255,.65)'; k.lineWidth = 2; for (const x of [-8, 0, 8]) { k.beginPath(); k.moveTo(x, -16); k.quadraticCurveTo(x + 4, -22, x, -27); k.stroke(); } } break; }
    default: ell(0, 0, 16, 16);
  }
  FD_ICONS.set(key, c); return c;
}
