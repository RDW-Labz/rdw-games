// ---- HUD (flat): 4 hotbar slots, Spark bar, Star meter ring, form badge, Star overlay --------------------------------------------------------------------------------------------------------------
const GH = { built: false, slots: [] };
function gemHudBuild() {
  if (GH.built) return; GH.built = true; const bar = $('gmBar'), hints = [['1', 'LB+A'], ['2', 'LB+B'], ['3', 'LB+X'], ['4', 'LB+Y']];
  for (let i = 0; i < 4; i++) { const d = document.createElement('div'); d.className = 'gs'; d.innerHTML = `<canvas width="64" height="64"></canvas><i class="cdv"></i><span class="kh">${hints[i][0]}</span><span class="kp" data-pad="${hints[i][1]}" data-padc="1">${padTxt(hints[i][1], 1)}</span><span class="gl"></span><span class="cs"></span><u class="xp"></u>`; bar.appendChild(d); GH.slots.push({ d, cv: d.querySelector('canvas'), cdv: d.querySelector('.cdv'), gl: d.querySelector('.gl'), cs: d.querySelector('.cs'), xp: d.querySelector('.xp'), id: '', lv: -1 }); }
  GH.spark = $('gmSparkFill'); GH.sparkT = $('gmSparkTxt'); GH.star = $('gmStarArc'); GH.starT = $('gmStarPct'); GH.root = $('gemHud'); GH.starBox = $('gmStar');
}
function gemHudTick(rdt) {
  if (VR.presenting) return; if (!GH.built) gemHudBuild(); const show = G.state === 'play' && !$('hud').classList.contains('hidden'); if (HC.gh !== show) { HC.gh = show; GH.root.classList.toggle('hidden', !show); } if (!show) return;
  rpgSty(GH.spark, 'width', (sat(GM.spark / GM.sparkMax, 0, 1) * 100).toFixed(1) + '%', 'gsp'); rpgSet(GH.sparkT, Math.floor(GM.spark) + ' / ' + Math.round(GM.sparkMax), 'gst'); const fl = GM.sparkFlash > 0 ? 1 : 0; if (HC.gsf !== fl) { HC.gsf = fl; $('gmSpark').classList.toggle('flash', !!fl); }
  for (let i = 0; i < 4; i++) {
    const s = GH.slots[i], a = GM.slot[i], g = a && a.gem, id = g ? g.id + ':' + g.lv : RP.hot[i] ? 'x' : ''; if (s.id !== id) { s.id = id; if (g) { gemDrawIcon(s.cv, g); s.d.classList.remove('empty', 'off'); } else { const c = s.cv.getContext('2d'); c.clearRect(0, 0, 64, 64); s.d.classList.add('empty'); s.d.classList.toggle('off', !!RP.hot[i]); } s.gl.textContent = g ? g.lv : ''; s.cs.textContent = a ? Math.round(a.R.cost) : ''; }
    const cdp = a ? GM.cd[i] / Math.max(0.1, GM.cdMax[i]) : 0; rpgSty(s.cdv, 'height', (sat(cdp, 0, 1) * 100).toFixed(0) + '%', 'gcd' + i); const cf = GM.castFlash[i], k = cf > 0 ? 1 : cf < 0 ? -1 : 0; if (HC['gcf' + i] !== k) { HC['gcf' + i] = k; s.d.classList.toggle('cast', k > 0); s.d.classList.toggle('deny', k < 0); }
    const lowSp = a && !(STAR.on && STAR.fx.freeCast) && GM.spark < a.R.cost ? 1 : 0; if (HC['glo' + i] !== lowSp) { HC['glo' + i] = lowSp; s.d.classList.toggle('low', !!lowSp); } const xpf = g && g.lv < GEM_TUNING.maxLevel ? sat(g.xp / gemXpNext(g.lv), 0, 1) : g ? 1 : 0; rpgSty(s.xp, 'width', (xpf * 100).toFixed(0) + '%', 'gxp' + i);
  }
  const ready = STAR.meter >= GEM_TUNING.star.max - 0.01, frac = STAR.on ? sat(STAR.t / STAR.dur, 0, 1) : STAR.meter / GEM_TUNING.star.max; rpgSty(GH.star, 'strokeDashoffset', (113 * (1 - frac)).toFixed(1), 'gsa'); rpgSet(GH.starT, STAR.on ? Math.ceil(Math.max(0, STAR.t)) + 's' : ready ? 'READY' : Math.floor(STAR.meter) + '%', 'gsp2'); const sk = (STAR.on ? 2 : ready ? 1 : 0); if (HC.gsk !== sk) { HC.gsk = sk; GH.starBox.className = sk === 2 ? 'on' : sk === 1 ? 'ready' : ''; }
  formHud();
}
function formHud() { const el = $('gmForm'); if (!el) return; const id = FORM.id, key = id ? id + Math.ceil(FORM.t) : ''; if (HC.gfm === key) return; HC.gfm = key; if (!id) { el.classList.add('hidden'); return; } el.classList.remove('hidden'); el.className = id; el.querySelector('b').textContent = FORM_DEF[id].name + '  ' + Math.ceil(FORM.t) + 's'; }

