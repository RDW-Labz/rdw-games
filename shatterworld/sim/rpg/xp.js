// ---- xp, levels, perks ----------------------------------------------------------------------------------------------------------------------------------------------
function rpgGainXp(amount, label) {
  if (RP.level >= RPG_TUNING.levelCap) return; amount = Math.max(1, Math.round(amount * (1 + RT.S.xpGain))); RP.xp += amount; RUN.xp += amount;
  while (RP.level < RPG_TUNING.levelCap && RP.xp >= rpgXpNext(RP.level)) { RP.xp -= rpgXpNext(RP.level); rpgLevelUp(); }
  if (RP.level >= RPG_TUNING.levelCap) RP.xp = 0; RT.dirty = true;
}
function rpgLevelUp() {
  RP.level++; RP.free += RPG_TUNING.pointsPerLevel; RP.pending++; RUN.levels++; rpgRecalc(); rpgHealFull(); rsfx('levelup');
  fxRing(P.x, P.y, P.z, 0.5, 8, 1.0, 0xffe27a, 1); fxRing(P.x, P.y, P.z, 0.3, 5, 0.8, 0xffffff, 0.8); fxRing(P.x, P.y + 1.2, P.z, 0.3, 3.5, 1.3, 0x53e0d0, 0.8); sparkBurst(P.x, P.y + 1, P.z, 40, 0xffe27a, 9); G.flash = Math.max(G.flash, 0.3); camShake(0.2);
  rpgBanner('LEVEL UP', 'LEVEL ' + RP.level + '  ·  +' + RPG_TUNING.pointsPerLevel + ' POINTS  ·  PERK READY'); rpgLogLine('Level ' + RP.level + '! New perk available', '#ffe27a'); RT.perkOpenAt = RT.real + 1.5; rpgSaveNow();
}
const PK = { open: false, choices: [], i: 0, from: 'play', hid: [], stale: null };
function rpgMaybePerks() {
  if (RP.pending > 0 && !PK.open && !RUI.open && G.state === 'play' && !G.trans && !G.finale && !P.dead && RT.real >= RT.perkOpenAt && !SH.on && !(RIFT && RIFT.phase === 'victory')) openPerks();
}
function openPerks() { // from play (automatic after a level-up) or from the menu / pause / result screens (PERKS tab)
  if (PK.open || RUI.open) return; const st = G.state; if (!(st === 'play' || st === 'pause' || st === 'menu' || st === 'dead')) return; PK.choices = rpgPerkChoices({ seed: RP.seed, picks: RP.picks, perks: RP.perks }); if (!PK.choices.length) { RP.pending = 0; return; }
  PK.from = st; PK.open = true; PK.i = 1; G.state = 'perk'; PK.stale = new Set(keys); mouseFire = mousePlace = padFireDown = padPlaceDown = false; document.exitPointerLock && document.exitPointerLock(); PK.hid = []; for (const id of ['menu', 'dead', 'pause']) { const el = $(id); if (el && !el.classList.contains('hidden')) { el.classList.add('hidden'); PK.hid.push(id); } }
  $('perkpick').classList.remove('hidden'); renderPerks(); rsfx('uiopen');
}
function renderPerks() {
  $('pkTitle').textContent = 'LEVEL ' + RP.level; $('pkSub').textContent = RP.pending > 1 ? 'CHOOSE A PERK  ·  ' + RP.pending + ' PICKS WAITING' : 'CHOOSE A PERK'; const box = $('perkCards'); box.innerHTML = '';
  PK.choices.forEach((p, i) => { const rk = (RP.perks[p.id] || 0) + 1, d = document.createElement('div'); d.className = 'pcard' + (i === PK.i ? ' focus' : ''); d.dataset.i = i; const cv = document.createElement('canvas'); rpgSigil(cv, p.glyph, i === PK.i ? '#ffe27a' : '#ffd66b'); d.appendChild(cv);
    d.insertAdjacentHTML('beforeend', `<h3>${p.name}</h3><div class="rk">RANK ${rk} / ${p.max}</div><div class="ds">${p.desc(rk)}</div><div class="num">${i + 1}</div>`); box.appendChild(d); });
  $('pkHint').innerHTML = '<span class="kk">&larr;</span><span class="kk">&rarr;</span> choose &nbsp; <span class="kk a">' + padTxt('A') + '</span> / Enter confirm &nbsp; 1 2 3 direct';
}
function perkPick(i) {
  const p = PK.choices[i]; if (!p) return; RP.perks[p.id] = (RP.perks[p.id] || 0) + 1; RP.picks++; RP.pending = Math.max(0, RP.pending - 1); rpgRecalc(); rsfx('perk'); rpgLogLine('Perk: ' + p.name + ' (rank ' + RP.perks[p.id] + ')', '#8af7e6'); rpgSaveNow();
  if (RP.pending > 0) { PK.choices = rpgPerkChoices({ seed: RP.seed, picks: RP.picks, perks: RP.perks }); PK.i = 1; if (PK.choices.length) { renderPerks(); return; } RP.pending = 0; }
  closePerks();
}
function closePerks() { PK.open = false; $('perkpick').classList.add('hidden'); const from = PK.from; for (const id of PK.hid) if (!(id === 'pause' && from === 'play')) $(id).classList.remove('hidden'); PK.hid = []; if (G.state === 'perk') { if (from === 'play') { G.state = 'play'; $('pause').classList.add('hidden'); requestLock(); } else G.state = from; } if (from === 'menu') rpgRenderMenu(); }
function perkKey(k) {
  if (k === 'arrowleft' || k === 'a') { PK.i = (PK.i + PK.choices.length - 1) % PK.choices.length; renderPerks(); rsfx('ui'); } else if (k === 'arrowright' || k === 'd') { PK.i = (PK.i + 1) % PK.choices.length; renderPerks(); rsfx('ui'); }
  else if (k === ' ' || k === 'enter') perkPick(PK.i); else if (k === '1' || k === '2' || k === '3') perkPick((+k) - 1 < PK.choices.length ? (+k) - 1 : PK.i);
}
$('perkCards').addEventListener('click', e => { const c = e.target.closest('.pcard'); if (c && PK.open) perkPick(+c.dataset.i); });
$('perkCards').addEventListener('mouseover', e => { const c = e.target.closest('.pcard'); if (c && PK.open && +c.dataset.i !== PK.i) { PK.i = +c.dataset.i; renderPerks(); } });

