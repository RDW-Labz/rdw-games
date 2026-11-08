// ---- events from the FSM -> the world ---------------------------------------------------------------------------------------------------------------------------------------------------------------
function mobHealRef(ref, frac) { const R = ref && ref.rpg; if (!R || !ref.alive || ref.state === 'dead') return; const v = R.maxhp * frac; R.hp = Math.min(R.maxhp, R.hp + v); floatText(ref.x, ref.y + 1.4, ref.z, '+' + Math.round(v), 'heal'); sparkBurst(ref.x, ref.y + 0.8, ref.z, 10, 0x8af7a0, 4); fxRing(ref.x, ref.y, ref.z, 0.3, 1.8, 0.5, 0x8af7a0, 0.9); }
function mobSilentKill(o) { if (!o.alive) return; if (o.rpg) o.rpg.dead = true; o.alive = false; o.state = 'dead'; o.mesh.visible = false; puff(o.x, o.y + 0.5, o.z, 5, 0.8, 0xc28cff, 2); }
function mobHandle(e, ev) {
  const m = e.mob, R = e.rpg, def = m.def, k = ev.k, fy = e.fy;
  switch (k) {
    case 'alert': floatText(e.x, e.y + 1.9 * (e.mesh.scale.y || 1), e.z, def.boss ? '' : '!', 'crit'); msfx('alert'); if (def.boss) { rpgBanner(def.name.toUpperCase(), RIFT ? 'THE GUARDIAN' : 'ACT GUARDIAN'); msfx('roar'); camShake(0.4); G.flash = Math.max(G.flash, 0.2); } if (ev.r > 0) for (const o of ENEMIES) { if (o !== e && o.mob && o.alive && o.mob.pack === ev.pack && o.mob.st === 'idle' && hyp2(o.x - e.x, o.z - e.z) < ev.r) mobAlert(o.mob); } break;
    case 'tell': mobTellSpawn(e, ev); msfx(ev.kind === 'shoot' || ev.kind === 'lob' || ev.kind === 'heal' ? 'tellhi' : 'tell', ev.dur > 0.9 ? 2 : ev.dur > 0.6 ? 1 : 0); break;
    case 'strike': {
      const col = hexNum(ev.col || '#ff8a4a'); const y = fy;
      if (ev.shape === 'hit') { if (ev.hit) { mobHurtHero(e, ev.dmg, ev.kb, e.x - Math.sin(ev.ang || 0), e.z - Math.cos(ev.ang || 0)); msfx('bite'); sparkBurst(P.x, P.y + 0.9, P.z, 10, col, 5); } break; }
      if (ev.shape === 'ringhit') { if (ev.hit) { mobHurtHero(e, ev.dmg, ev.kb, ev.x, ev.z); camShake(0.4); } break; }
      if (ev.shape === 'beamhit') { if (ev.hit) { mobHurtHero(e, ev.dmg, ev.kb, ev.x, ev.z); sparkBurst(P.x, P.y + 0.9, P.z, 10, col, 6); } break; }
      if (ev.shape === 'line') { const a = ev.ang, len = ev.len; for (let i = 1; i <= 4; i++) { const px = ev.x + Math.sin(a) * len * i / 4, pz = ev.z + Math.cos(a) * len * i / 4; fxRing(px, floorAt(px, pz, y + 2) > -1e8 ? floorAt(px, pz, y + 2) : y, pz, 0.3, 1.4, 0.35, col, 0.8); } if (ev.hit) mobHurtHero(e, ev.dmg, ev.kb, ev.x, ev.z); msfx('stomp'); camShake(0.2); break; }
      if (ev.shape === 'cone') { for (let i = 0; i < 7; i++) { const a = ev.ang + (i / 6 - 0.5) * ev.arc, px = e.x + Math.sin(a) * ev.r * 0.8, pz = e.z + Math.cos(a) * ev.r * 0.8; sparkBurst(px, y + 0.5, pz, 3, col, 4); } fxRing(e.x, y, e.z, 0.5, ev.r, 0.3, col, 0.7); if (ev.hit) mobHurtHero(e, ev.dmg, ev.kb, e.x, e.z); msfx('bite'); camShake(0.25); break; }
      const f = floorAt(ev.x, ev.z, y + 3), fyy = f > -1e8 ? f : y; fxRing(ev.x, fyy, ev.z, 0.3, ev.r, 0.4, col, 0.95, true); fxRing(ev.x, fyy, ev.z, 0.2, ev.r * 0.6, 0.3, 0xffffff, 0.7); sparkBurst(ev.x, fyy + 0.4, ev.z, ev.spike ? 5 : 12, col, ev.spike ? 4 : 7); puff(ev.x, fyy + 0.1, ev.z, ev.spike ? 3 : 8, 1.2, 0xd8c8a0, 3, -1, 0.7); if (ev.spike) fxChunks(ev.x, fyy + 0.4, ev.z, 3, col, 0.18, 4, fyy); camShake(ev.spike ? 0.08 : ev.boom ? 0.7 : 0.3); msfx(ev.boom ? 'boom' : ev.spike ? 'splat' : 'stomp');
      if (ev.hit) mobHurtHero(e, ev.dmg, ev.kb, ev.x, ev.z); break; }
    case 'shoot': mobShoot(e, ev); break;
    case 'dash': msfx('dash'); puff(e.x, fy + 0.1, e.z, 6, 1.0, 0xd8c8a0, 3, -1, 0.6); break;
    case 'ring': mobWave(ev.x, fy, ev.z, ev.spd, ev.max, ev.col); fxRing(ev.x, fy, ev.z, 0.5, 3.5, 0.4, hexNum(ev.col), 0.9); msfx('boom'); camShake(0.5); sparkBurst(ev.x, fy + 0.3, ev.z, 14, hexNum(ev.col), 7); break;
    case 'sweep': msfx('sweep'); break;
    case 'summon': { msfx('summon'); fxRing(ev.x, fy, ev.z, 0.3, ev.r, 0.6, 0xc28cff, 0.9, true); let nspawn = 0; for (let i = 0; i < ev.n; i++) { const a = Math.random() * TAU, ne = rpgSpawnEnemy(ev.type, ev.x + Math.cos(a) * ev.r * 0.7, ev.z + Math.sin(a) * ev.r * 0.7, { y: fy, minion: true, mlvl: Math.max(1, R.lvl - 2), xpMul: 0.2, aggroR: 24, r: 4 }); if (ne) { ne.owner = e; if (ne.mob) { ne.mob.pack = m.pack || (m.pack = (++MOBX.spawned) | 0 || 1); mobAlert(ne.mob); } nspawn++; } } break; }
    case 'unsummon': for (const o of ENEMIES) if (o.owner === e && o.alive) mobSilentKill(o); break;
    case 'heal': msfx('heal'); mobHealRef(ev.ref, ev.frac); if (ev.ref && ev.ref.alive) fxBolt(e.x, e.y + 0.9, e.z, ev.ref.x, ev.ref.y + 0.7, ev.ref.z, 0x8af7a0); sparkBurst(e.x, e.y + 0.9, e.z, 6, 0x8af7a0, 3); break;
    case 'leap': msfx('dash'); puff(e.x, fy + 0.1, e.z, 6, 1.0, 0xd8c8a0, 3, -1, 0.6); break;
    case 'emerge': msfx('emerge'); puff(ev.x, fy + 0.1, ev.z, 14, 1.6, 0xd8b878, 4, -1, 0.9); fxChunks(ev.x, fy + 0.3, ev.z, 8, 0x8a6a50, 0.2, 5, fy); camShake(0.25); break;
    case 'burrow': msfx('burrow'); puff(ev.x, fy + 0.1, ev.z, 10, 1.3, 0xd8b878, 3, -1, 0.8); break;
    case 'blink': puff(e.x, e.y + 0.8, e.z, 12, 1.2, 0xe0d0ff, 2, 0.5, 0.6); sparkBurst(e.x, e.y + 0.8, e.z, 14, 0xe0d0ff, 6); msfx('tellhi'); e.mob.x = ev.tx; e.mob.z = ev.tz; { const f = floorAt(ev.tx, ev.tz, e.fy + 4); if (f > -1e8) e.fy = f; else { e.mob.x = ev.x; e.mob.z = ev.z; } } e.x = e.mob.x; e.z = e.mob.z; puff(e.x, e.fy + 1, e.z, 12, 1.2, 0xe0d0ff, 2, 0.5, 0.6); sparkBurst(e.x, e.fy + 1, e.z, 14, 0xe0d0ff, 6); fxRing(e.x, e.fy, e.z, 0.3, 2.4, 0.4, 0xe0d0ff, 0.9); break;
    case 'shield': msfx('shield'); fxRing(e.x, e.fy, e.z, 0.4, 3, 0.5, 0xbfe0ff, 0.9, true); floatText(e.x, e.y + 2.2, e.z, 'CRYSTAL SHELL', 'heal'); break;
    case 'shieldDown': floatText(e.x, e.y + 2.2, e.z, 'SHELL FADES', 'xp'); break;
    case 'shieldBreak': msfx('clang'); sparkBurst(e.x, e.y + 1, e.z, 24, 0xbfe0ff, 8); fxRing(e.x, e.fy, e.z, 0.4, 4, 0.5, 0xbfe0ff, 1); floatText(e.x, e.y + 2.2, e.z, 'SHIELD BREAK!', 'crit'); camShake(0.3); heroHitstop(0.06); break;
    case 'clang': msfx('clang'); sparkBurst(e.x, e.y + 1, e.z, 5, 0xfff0c0, 4); floatText(e.x, e.y + 1.6, e.z, 'BLOCKED', 'xp'); break;
    case 'stun': msfx('stun'); floatText(e.x, e.y + 2.0 * (e.mesh.scale.y || 1), e.z, 'STUNNED', 'crit'); sparkBurst(e.x, e.y + 1.2, e.z, 10, 0xffe27a, 4); camShake(0.3); heroHitstop(0.05); break;
    case 'phase': msfx('roar'); rpgBanner(ev.name, def.name.toUpperCase()); camShake(0.7); G.flash = Math.max(G.flash, 0.3); fxRing(e.x, e.fy, e.z, 0.5, 9, 0.9, 0xffe27a, 1); fxRing(e.x, e.fy, e.z, 0.3, 6, 0.7, 0xffffff, 0.8); sparkBurst(e.x, e.y + 1.2, e.z, 30, 0xffe27a, 8); break;
    case 'explode': { const f = ev.half ? 0.5 : 1, y = e.fy; fxRing(ev.x, y, ev.z, 0.4, ev.r, 0.4, 0xfff2b0, 1, true); fxRing(ev.x, y, ev.z, 0.2, ev.r * 0.6, 0.3, 0xff8a3a, 1); sparkBurst(ev.x, y + 0.6, ev.z, 26, 0xffb060, 9); fxChunks(ev.x, y + 0.5, ev.z, 10, 0xe84a4a, 0.22, 6, y); puff(ev.x, y + 0.3, ev.z, 12, 1.8, 0x504040, 4, 0.6, 1.0); msfx('boom'); camShake(0.6 * f);
      if (ev.half && !P.dead && hyp2(P.x - ev.x, P.z - ev.z) < ev.r + 0.35 && P.y - y < 1.6) mobHurtHero(e, MOB_ATK.fuse.dmg * 0.5, 6, ev.x, ev.z); if (ev.self) { if (R) R.dead = true; e.alive = false; e.state = 'dead'; e.mesh.visible = false; } break; }
    case 'cloud': mobCloud(ev.x, e.fy, ev.z, ev.r, ev.dur, 0.25, e, '#b8e86a'); break;
    case 'death': if (ev.how !== 'self') { puff(ev.x, e.y + 0.5, ev.z, 8, 1.0, hexNum(def.pal[0]), 2.5, 0.5, 0.8); } if (def.boss) { msfx('bossdown'); camShake(0.8); G.flash = Math.max(G.flash, 0.4); } break;
  }
}
function mobDrain(e) { const m = e.mob; if (!m.ev.length) return; const evs = m.ev.splice(0, m.ev.length); for (const ev of evs) { try { mobHandle(e, ev); } catch (err) { console.error('mob event', ev.k, err); } if (MOBX.log.length < 400) MOBX.log.push(ev.k + ':' + (ev.atk || ev.id || '')); } }
