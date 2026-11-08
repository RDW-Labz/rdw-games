// ---- hooks that fill the Star meter ---------------------------------------------------------------------------------------------------------------------------------------------------------------
const _rpgOnKilled2 = rpgOnKilled;
rpgOnKilled = function (e, ak, sx, sz) { const was = e.rpg && e.rpg.dead; _rpgOnKilled2(e, ak, sx, sz); if (was || !e.rpg) return; GM.stats.kills++; GM.spark = Math.min(GM.sparkMax, GM.spark + GM.sparkMax * GEM_TUNING.spark.perKill); starGain(gemStarGain(e.rpg.tier, RT.S), 'kill'); if (ak === 'skill') { /* skill kills already paid xp */ } };
const _rpgHitHooks2 = rpgHitHooks; rpgHitHooks = function (e, ak, h, sx, sz) { _rpgHitHooks2(e, ak, h, sx, sz); if (RT.combo >= 3) starGain(GEM_TUNING.star.combo * (1 + RT.S.starGain), 'combo'); };
const _collectShard2 = collectShard; collectShard = function (s) { const was = s.got; _collectShard2(s); if (was || !s.got) return; starGain(GEM_TUNING.star.shard * (1 + RT.S.starGain), 'shard'); if (s.final) clsUnlockEvent({ type: 'act', n: G.act }); };
const _collectCoin2 = collectCoin; collectCoin = function (c) { _collectCoin2(c); starGain(GEM_TUNING.star.coin, 'coin'); };
const _victory2 = victory; victory = function () { _victory2(); clsUnlockEvent({ type: 'win' }); };
const _rpgRiftEnd2 = rpgRiftEnd; rpgRiftEnd = function (win, why) { const was = RIFT && !RIFT.done, t = RIFT ? RIFT.tier : 0; _rpgRiftEnd2(win, why); if (was && win) clsUnlockEvent({ type: 'rift', n: t }); };
const _clearEntities2 = clearEntities; clearEntities = function () { gemClearFx(); _clearEntities2(); };
const _toMenu2 = toMenu; toMenu = function () { gemClearFx(); STAR.meter = 0; _toMenu2(); };
const _startRun2 = startRun; startRun = function () { STAR.meter = 0; GM.spark = GM.sparkMax; GM.cd.fill(0); _startRun2(); };
const _killHero2 = killHero; killHero = function (reason) { if (P.dead || G.state !== 'play') return; if (STAR.on) starEnd(true); STAR.meter = 0; _killHero2(reason); };

