// <mob-core> ====================================================================================================================
// SHATTERWORLD mob variety, part 1 of 2: pure data + a small data-driven finite state machine. No DOM, no three.js, no game globals (needs rpgRng / rpgHashSeed / RPG_TUNING from rpg-core).
// scratchpad/shatter-passB/mob-unit.mjs extracts this block verbatim and runs it under node (seeded determinism, every attack's telegraph, death, boss phases).
// borrowed: FiniteStateMachine.js + entities/NPC/CharacterFSM.js (AddState / SetState(Exit prev, Enter next) / Update, States Idle -> Patrol -> Chase -> Attack -> Dead) from
//   mohsenheydari/three-fps (MIT, Copyright (c) 2021 Mohsen Heydari): re-written as MobFSM / MobState below, the states are built from the mob's DATA instead of one class per monster.
// borrowed: the attack vocabulary + numbers from tenplus1/mobs_redo api.txt + mobs_monster (MIT, Copyright (c) TenPlus1): attack_type dogfight / shoot / dogshoot (shoot for N s, then fight for M s) /
//   explode (explosion_timer fuse, reach), group_attack (the whole pack wakes up together), runaway, fly (hover), view_range / reach / shoot_interval, walk 1 / run 3 velocities, hp / damage ratios
//   of dungeon_master (dogshoot), land_guard (group_attack), oerkki, lava_flan, fire_spirit.
// ideas only (no code): flare-game enemies' power lists (melee / ranged / on_join_combat), mari0_ae hammer-thrower / lakitu / boo / bomb / chain-chomp / boom-boom move sets. Every name, number and shape here is original.
// ==============================================================================================================================
const hyp2 = (a, b) => Math.sqrt(a * a + b * b), hyp3 = (a, b, c) => Math.sqrt(a * a + b * b + c * c); // Math.hypot boxes its result on every call: the per-frame loops use these
const MOB_STEP = 1 / 30;                                  // the FSM runs at a fixed 30 Hz whatever the frame rate (deterministic)
const MOB_TUNING = { telegraphMin: 0.35, alertT: [0.22, 0.45], stunVuln: 1.5, packAlert: 14, turn: 9, hopTell: 0.35, exposeVuln: 1.35, minionCap: 6 };

class MobFSM { // three-fps FiniteStateMachine, same API shape
  constructor(proxy) { this.proxy = proxy; this.states = {}; this.currentState = null; }
  AddState(name, instance) { this.states[name] = instance; }
  SetState(name) {
    const prev = this.currentState; if (prev && prev.Name === name) return; if (prev) prev.Exit();
    this.currentState = this.states[name]; this.proxy.st = name; this.proxy.t = 0; this.currentState.Enter(prev);
  }
  Update(dt) { if (this.currentState) this.currentState.Update(dt); }
}
class MobState { constructor(fsm, name) { this.parent = fsm; this.Name = name; this.m = fsm.proxy; } Enter() { } Exit() { } Update() { } }

// ---- attacks: kind = what happens at the end of the wind-up (the TELEGRAPH). wind = telegraph seconds, exec = active seconds, rec = recovery, cd = per-attack cooldown, range = hero distance window ----------------
function mobAtk(id, kind, o) { return Object.assign({ id, kind, wind: 0.65, exec: 0.2, rec: 0.7, cd: 2.5, range: [0, 6], wt: 1, w: 1, dmg: 1, kb: 6, tell: 'circle', r: 2, aim: 0.6, col: '#ff6a4a', phase: 0, fam: '' }, o); }
const MOB_ATK = {};
[
  // ---- ranged / artillery ----
  mobAtk('smack', 'strike', { wind: 0.45, exec: 0.15, rec: 0.6, cd: 1.8, range: [0, 2.6], r: 1.9, dmg: 0.8, kb: 5, tell: 'circle', col: '#ffb060', off: 0.9 }),
  mobAtk('volley', 'shoot', { wind: 0.62, exec: 0.5, rec: 0.7, cd: 2.4, range: [3.5, 15], n: 3, spread: 0.3, spd: 10.5, dmg: 0.7, tell: 'aim', aim: 0.8, gap: 0.16, col: '#ff9a4a' }),
  mobAtk('sporelob', 'lob', { wind: 0.8, exec: 0.3, rec: 0.9, cd: 4.2, range: [4, 16], dmg: 0.55, tell: 'circle', r: 2.5, aim: 0.5, col: '#b8e86a', cloud: 3.2, flight: 0.9 }),
  // ---- melee ----
  mobAtk('lunge', 'dash', { wind: 0.36, exec: 0.26, rec: 0.6, cd: 1.5, range: [0.6, 4.2], dist: 3.2, spd: 12, w: 1.1, dmg: 0.8, kb: 4, tell: 'line', len: 3.4, aim: 0.5, col: '#ff7a5a' }),
  mobAtk('ram', 'charge', { wind: 0.85, exec: 0.75, rec: 0.45, cd: 3.4, range: [4, 15], dist: 12, spd: 16.5, w: 1.5, dmg: 1.5, kb: 11, tell: 'line', len: 12, aim: 0.55, col: '#ff4a3a', stunOnWall: 1.9 }),
  mobAtk('bash', 'dash', { wind: 0.7, exec: 0.28, rec: 0.9, cd: 3.0, range: [1.2, 5.5], dist: 3.6, spd: 13, w: 2.0, dmg: 1.2, kb: 9, tell: 'line', len: 3.8, aim: 0.6, col: '#8fd0ff' }),
  mobAtk('clack', 'strike', { wind: 0.55, exec: 0.15, rec: 0.7, cd: 2.0, range: [0, 2.8], r: 2.3, dmg: 1.0, kb: 6, tell: 'circle', col: '#ffd07a', off: 0.6 }),
  mobAtk('erupt', 'emerge', { wind: 0.8, exec: 0.2, rec: 0.3, cd: 3.0, range: [0, 4.6], r: 2.2, dmg: 1.25, kb: 8, tell: 'circle', aim: 0.45, col: '#d8b070', expose: 2.6 }),
  // ---- fliers ----
  mobAtk('swoop', 'swoop', { wind: 0.72, exec: 0.4, rec: 0.3, cd: 3.4, range: [2, 12], r: 1.7, dmg: 1.1, kb: 7, tell: 'circle', aim: 0.5, col: '#7ff0e8', stun: 1.3 }),
  // ---- bomber ----
  mobAtk('fuse', 'fuse', { wind: 0.9, exec: 0.1, rec: 0.1, cd: 9, range: [0, 3.0], r: 3.4, dmg: 1.7, kb: 10, tell: 'circle', col: '#fff2b0' }),
  // ---- support ----
  mobAtk('mend', 'heal', { wind: 0.9, exec: 0.3, rec: 0.9, cd: 3.4, range: [0, 11], heal: 0.28, tell: 'beam', col: '#8af7a0' }),
  mobAtk('weave', 'summon', { wind: 1.0, exec: 0.3, rec: 1.1, cd: 7.5, range: [0, 40], n: 2, summon: 'scuttler', r: 2.6, tell: 'circle', col: '#c28cff' }),
  // ---- mini-boss ----
  mobAtk('leapslam', 'leap', { wind: 0.85, exec: 0.55, rec: 0.8, cd: 3.6, range: [3, 13], r: 3.2, dmg: 1.4, kb: 10, tell: 'circle', aim: 0.6, col: '#ff6a3a' }),
  mobAtk('sweepclaw', 'strike', { wind: 0.6, exec: 0.2, rec: 0.8, cd: 2.6, range: [0, 4], r: 4.0, dmg: 1.1, kb: 9, tell: 'cone', arc: 2.3, col: '#ff8a4a', off: 0 }),
  mobAtk('wardenram', 'charge', { wind: 0.8, exec: 0.6, rec: 0.5, cd: 4.0, range: [5, 14], dist: 11, spd: 17, w: 1.7, dmg: 1.4, kb: 11, tell: 'line', len: 11, aim: 0.55, col: '#ff4a3a', stunOnWall: 1.6, phase: 1 }),
  // ---- Act I guardian: Old Thornback ----
  mobAtk('thorn_slam', 'ring', { wind: 1.1, exec: 0.2, rec: 0.9, cd: 3.4, range: [0, 14], r: 4.2, spd: 11, band: 1.2, dmg: 1.2, kb: 9, tell: 'circle', col: '#ff8a3a', phase: 0 }),
  mobAtk('thorn_spikes', 'spikes', { wind: 0.9, exec: 0.9, rec: 0.8, cd: 3.0, range: [3.5, 20], len: 16, w: 2.0, dmg: 1.1, kb: 7, tell: 'line', aim: 0.7, col: '#ff6a2a', n: 12, phase: 0 }),
  mobAtk('thorn_charge', 'charge', { wind: 1.0, exec: 1.1, rec: 0.6, cd: 5.0, range: [6, 22], dist: 18, spd: 15, w: 2.2, dmg: 1.6, kb: 12, tell: 'line', len: 18, aim: 0.5, col: '#ff3a2a', stunOnWall: 2.3, phase: 1 }),
  mobAtk('thorn_call', 'summon', { wind: 1.2, exec: 0.3, rec: 1.0, cd: 11, range: [0, 40], n: 3, summon: 'scuttler', r: 3.2, tell: 'circle', col: '#c28cff', phase: 1 }),
  mobAtk('thorn_star', 'star', { wind: 1.0, exec: 0.9, rec: 1.0, cd: 6, range: [0, 16], n: 8, len: 12, w: 1.5, dmg: 1.0, kb: 7, tell: 'line', col: '#ff5a2a', phase: 2 }),
  // ---- Act II guardian: Stormcaller ----
  mobAtk('storm_bolts', 'bolts', { wind: 1.1, exec: 0.3, rec: 0.9, cd: 3.2, range: [0, 30], n: 4, r: 2.0, spread: 4.6, dmg: 1.1, kb: 6, tell: 'circle', col: '#9fd0ff', phase: 0 }),
  mobAtk('storm_orbs', 'shoot', { wind: 0.8, exec: 0.3, rec: 1.0, cd: 4.2, range: [0, 30], n: 8, spread: 6.283, spd: 6.2, dmg: 0.8, tell: 'self', r: 2.4, gap: 0, col: '#c8b0ff', phase: 0, ring: true }),
  mobAtk('storm_blink', 'blink', { wind: 0.6, exec: 0.2, rec: 0.35, cd: 6.0, range: [0, 30], dmin: 6, dmax: 10, tell: 'self', r: 1.6, col: '#e0d0ff', phase: 1 }),
  mobAtk('storm_call', 'summon', { wind: 1.0, exec: 0.3, rec: 1.0, cd: 12, range: [0, 40], n: 2, summon: 'slinger', r: 3, tell: 'circle', col: '#9fe8ff', phase: 1 }),
  mobAtk('storm_sweep', 'sweep', { wind: 1.2, exec: 2.3, rec: 1.0, cd: 7, range: [0, 24], len: 19, w: 1.5, arc: 2.6, dmg: 1.2, kb: 8, tell: 'line', aim: 0.4, col: '#a0e0ff', phase: 2 }),
  // ---- Act III guardian: the Prismatic Hollow ----
  mobAtk('prism_stomp', 'leap', { wind: 0.9, exec: 0.6, rec: 0.9, cd: 3.4, range: [2, 20], r: 3.6, dmg: 1.3, kb: 10, tell: 'circle', aim: 0.6, col: '#ff7aff', phase: 0 }),
  mobAtk('prism_barrage', 'bolts', { wind: 1.0, exec: 0.3, rec: 1.0, cd: 4.0, range: [0, 30], n: 5, r: 1.7, spread: 5.2, dmg: 1.0, kb: 6, tell: 'circle', col: '#ff9aff', phase: 0 }),
  mobAtk('prism_laser', 'sweep', { wind: 1.3, exec: 2.0, rec: 1.0, cd: 6.5, range: [0, 22], len: 17, w: 1.6, arc: 2.3, dmg: 1.2, kb: 8, tell: 'line', aim: 0.4, col: '#ff6aff', phase: 1 }),
  mobAtk('prism_shield', 'shield', { wind: 0.7, exec: 0.1, rec: 0.6, cd: 14, range: [0, 40], dur: 5.0, tell: 'self', r: 2.2, col: '#bfe0ff', phase: 1 }),
  mobAtk('prism_nova', 'ring', { wind: 1.0, exec: 0.2, rec: 0.9, cd: 4.5, range: [0, 12], r: 4.6, spd: 12, band: 1.3, dmg: 1.2, kb: 10, tell: 'circle', col: '#ffb0ff', phase: 2 }),
].forEach(a => { MOB_ATK[a.id] = a; });

// ---- mob definitions. hp / dmg are the level-1 numbers (the walker is hp 8 / dmg 33), spd = patrol m/s, run = chase m/s, aggro = view_range (m), move = movement behaviour --------------------------------------------------
function mobDef(id, name, fam, o) { return Object.assign({ id, name, fam, hp: 8, dmg: 33, xp: 1.5, spd: 1.2, run: 3.4, aggro: 14, size: 1, h: 0.9, move: 'approach', keep: [0, 0], reach: 1.4, atk: [], pal: ['#a5602d', '#3a2412', '#ffd07a'], shape: 'walker', turn: 9, start: 'idle', ing: {}, hover: 0, pack: false, boss: false }, o); }
const MOB_DEFS = {};
[
  mobDef('slinger', 'Cinder Slinger', 'ranged', { hp: 7, dmg: 26, xp: 1.7, spd: 1.2, run: 3.3, aggro: 17, move: 'keep', keep: [6, 10.5], atk: ['volley', 'smack'], shape: 'slinger', pal: ['#e0643a', '#4a1e14', '#ffb060'], dogshoot: [8, 4], reach: 2.2 }),
  mobDef('rammer', 'Ramhorn', 'charger', { hp: 15, dmg: 40, xp: 2.4, spd: 1.2, run: 3.0, aggro: 15, size: 1.15, h: 1.1, move: 'approach', reach: 2.0, atk: ['ram'], shape: 'rammer', pal: ['#8a6a4a', '#e8dcc0', '#ff5a3a'] }),
  mobDef('scuttler', 'Scuttler', 'swarm', { hp: 3, dmg: 14, xp: 0.55, spd: 1.8, run: 5.2, aggro: 12, size: 0.6, h: 0.45, move: 'circle', keep: [2.2, 3.4], reach: 1.2, atk: ['lunge'], shape: 'scuttler', pal: ['#6a3fa0', '#d8b8ff', '#ffe27a'], pack: true, inst: true }),
  mobDef('mender', 'Sproutmender', 'healer', { hp: 8, dmg: 12, xp: 2.2, spd: 1.4, run: 3.6, aggro: 18, move: 'flee', keep: [8, 13], atk: ['mend'], shape: 'mender', pal: ['#58c878', '#f4ffe0', '#ff8fc1'], priority: 1 }),
  mobDef('weaver', 'Hollow Weaver', 'summoner', { hp: 10, dmg: 20, xp: 2.6, spd: 1.0, run: 3.0, aggro: 20, size: 1.1, h: 1.2, move: 'flee', keep: [8, 14], atk: ['weave'], shape: 'weaver', pal: ['#6a3fa0', '#2a1648', '#c28cff'] }),
  mobDef('fuse', 'Fusebug', 'bomber', { hp: 4, dmg: 55, xp: 1.4, spd: 2.0, run: 6.6, aggro: 15, size: 0.8, h: 0.6, move: 'approach', reach: 2.4, atk: ['fuse'], shape: 'fuse', pal: ['#e84a4a', '#3a1414', '#fff2b0'], inst: true }),
  mobDef('bulwark', 'Bulwark Crab', 'shielded', { hp: 20, dmg: 34, xp: 2.8, spd: 1.0, run: 2.5, aggro: 13, size: 1.2, h: 1.0, move: 'approach', reach: 2.2, atk: ['bash', 'clack'], shape: 'bulwark', pal: ['#4a8ac8', '#d8e8ff', '#ffd07a'], shield: { arc: 2.1, front: 0.12 } }),
  mobDef('wisp', 'Gale Wisp', 'flyer', { hp: 6, dmg: 22, xp: 1.8, spd: 2.2, run: 5.0, aggro: 18, size: 0.9, h: 0.7, move: 'hover', keep: [5, 7.5], hover: 1.9, atk: ['swoop'], shape: 'wisp', pal: ['#2fb8ff', '#d8f6ff', '#7ae0ff'], fly: true }),
  mobDef('mole', 'Dustmole', 'ambusher', { hp: 9, dmg: 36, xp: 2.0, spd: 1.2, run: 5.4, aggro: 14, size: 1.0, h: 0.8, move: 'burrow', reach: 2.0, atk: ['erupt'], shape: 'mole', pal: ['#8a6a50', '#f0d8b8', '#ff8f6a'], start: 'burrow' }),
  mobDef('puffer', 'Sporecap', 'artillery', { hp: 12, dmg: 20, xp: 2.1, spd: 0, run: 0, aggro: 17, size: 1.15, h: 1.1, move: 'still', atk: ['sporelob'], shape: 'puffer', pal: ['#b8e86a', '#5a7a2a', '#fff2a0'] }),
  mobDef('warden', 'Thornjaw Warden', 'miniboss', { hp: 70, dmg: 52, xp: 9, spd: 1.2, run: 3.2, aggro: 20, size: 1.15, h: 1.8, move: 'approach', reach: 3.0, atk: ['leapslam', 'sweepclaw', 'wardenram'], shape: 'warden', pal: ['#7a3a3a', '#e8d8b8', '#ff8a4a'], mini: true,
    phases: [{ at: 1, name: 'WARDEN', atk: ['leapslam', 'sweepclaw'], spd: 1, cdK: 1 }, { at: 0.5, name: 'ENRAGED', atk: ['leapslam', 'sweepclaw', 'wardenram'], spd: 1.3, cdK: 0.7 }] }),
  // ---- act guardians (bosses): multi-phase attack patterns, each tell is a ground decal for >= 0.6 s ----
  mobDef('g_thorn', 'Old Thornback', 'boss', { hp: 26, dmg: 46, xp: 40, spd: 1.2, run: 3.4, aggro: 30, size: 0.8, h: 2.2, move: 'approach', reach: 3.6, atk: ['thorn_slam', 'thorn_spikes'], shape: 'thornback', pal: ['#6a4a3a', '#2a1a14', '#ff8a3a'], boss: true,
    phases: [{ at: 1, name: 'THORNBACK', atk: ['thorn_slam', 'thorn_spikes'], spd: 1, cdK: 1 }, { at: 0.66, name: 'THORNS UNLEASHED', atk: ['thorn_slam', 'thorn_spikes', 'thorn_charge', 'thorn_call'], spd: 1.1, cdK: 0.9 },
      { at: 0.33, name: 'RAMPAGE', atk: ['thorn_slam', 'thorn_spikes', 'thorn_charge', 'thorn_star'], spd: 1.3, cdK: 0.7 }] }),
  mobDef('g_storm', 'Stormcaller', 'boss', { hp: 24, dmg: 40, xp: 45, spd: 1.6, run: 4.2, aggro: 34, size: 0.8, h: 2.0, move: 'hover', keep: [7, 11], hover: 1.8, fly: true, atk: ['storm_bolts', 'storm_orbs'], shape: 'stormcaller', pal: ['#5a6ad8', '#e8f0ff', '#9fd0ff'], boss: true,
    phases: [{ at: 1, name: 'STORMCALLER', atk: ['storm_bolts', 'storm_orbs'], spd: 1, cdK: 1 }, { at: 0.66, name: 'EYE OF THE STORM', atk: ['storm_bolts', 'storm_orbs', 'storm_blink', 'storm_call'], spd: 1.15, cdK: 0.85 },
      { at: 0.33, name: 'TEMPEST', atk: ['storm_bolts', 'storm_orbs', 'storm_blink', 'storm_sweep'], spd: 1.3, cdK: 0.7 }] }),
  mobDef('g_prism', 'The Prismatic Hollow', 'boss', { hp: 28, dmg: 44, xp: 50, spd: 1.2, run: 3.0, aggro: 34, size: 0.8, h: 2.4, move: 'approach', reach: 3.4, atk: ['prism_stomp', 'prism_barrage'], shape: 'prism', pal: ['#b06aff', '#1a0a2a', '#ff9aff'], boss: true,
    phases: [{ at: 1, name: 'THE HOLLOW', atk: ['prism_stomp', 'prism_barrage'], spd: 1, cdK: 1 }, { at: 0.66, name: 'CRYSTAL SHELL', atk: ['prism_stomp', 'prism_barrage', 'prism_laser', 'prism_shield'], spd: 1.1, cdK: 0.9 },
      { at: 0.33, name: 'SHATTERING', atk: ['prism_stomp', 'prism_barrage', 'prism_laser', 'prism_nova'], spd: 1.25, cdK: 0.7 }] }),
].forEach(d => { MOB_DEFS[d.id] = d; });
const MOB_IDS = Object.keys(MOB_DEFS);
const MOB_REGULAR = MOB_IDS.filter(i => !MOB_DEFS[i].boss && !MOB_DEFS[i].mini);
const MOB_BOSS_BY_ACT = { 1: 'g_thorn', 2: 'g_storm', 3: 'g_prism' };
// families -> which defs, for rift modifiers ("this rift is full of ...") and the campaign table
const MOB_FAMILIES = {
  nest: { id: 'nest', name: 'Swarm Nest', text: 'Packs of Scuttlers, Fusebugs and a Hollow Weaver.', mobs: ['scuttler', 'fuse', 'weaver'] },
  war: { id: 'war', name: 'War Band', text: 'Ramhorns, Bulwark Crabs and Thornjaw Wardens.', mobs: ['rammer', 'bulwark', 'warden'] },
  sky: { id: 'sky', name: 'Gale Front', text: 'Gale Wisps and Cinder Slingers fill the air.', mobs: ['wisp', 'slinger', 'mender'] },
  deep: { id: 'deep', name: 'Undermine', text: 'Dustmoles, Sporecaps and Fusebugs under your feet.', mobs: ['mole', 'puffer', 'fuse'] },
};
const MOB_FAMILY_IDS = Object.keys(MOB_FAMILIES);
function mobRiftFamilies(seed, tier) { const r = rpgRng(rpgHashSeed(seed >>> 0, 0x3A7)), ids = MOB_FAMILY_IDS.slice(), n = tier >= 6 ? 2 : 1, out = []; while (out.length < n && ids.length) out.push(ids.splice((r() * ids.length) | 0, 1)[0]); return out; }
// campaign population per act: [type, weight, minAct]; the original walker / shell / brute / hopper / spitter table is untouched, these are ADDED spawns
const MOB_CAMPAIGN = { extraPerAct: { 1: 6, 2: 9, 3: 11 }, table: [['slinger', 3, 1], ['scuttler', 3, 1], ['puffer', 1.6, 1], ['rammer', 2, 1], ['mender', 1.1, 2], ['bulwark', 2, 2], ['fuse', 2, 2], ['wisp', 2.4, 2], ['mole', 2.2, 2], ['weaver', 1.6, 3], ['warden', 0.8, 3]], packSize: 4, guardianHpDiv: 1 };
function mobSetTuning() { // plug the new types into the rpg-core scaling tables (monster hp / dmg / xp / name) so levels, tiers, affixes and xp work unchanged
  for (const id of MOB_IDS) { const d = MOB_DEFS[id]; RPG_TUNING.monster.hp[id] = d.hp; RPG_TUNING.monster.dmg[id] = d.dmg; RPG_TUNING.monster.spd[id] = 1; RPG_TUNING.monster.name[id] = d.name; RPG_TUNING.xp.type[id] = d.xp; }
}
mobSetTuning();

// ---- the runtime mob ------------------------------------------------------------------------------------------------------------------------------------------
const mobWrap = a => { a = (a + Math.PI) % (Math.PI * 2); if (a < 0) a += Math.PI * 2; return a - Math.PI; };
function mobNew(id, seed, o = {}) {
  const def = MOB_DEFS[id]; if (!def) return null;
  const m = { id, def, aggro: o.aggro != null ? o.aggro : def.aggro, seed: seed >>> 0, rng: rpgRng(seed >>> 0), x: o.x || 0, y: o.y || 0, z: o.z || 0, hx: o.x || 0, hz: o.z || 0, r: o.r || 4, face: o.face || 0, vx: 0, vz: 0, st: 'idle', t: 0, ev: [], cd: {}, gcd: 0.6, atk: null, atkD: null,
    aim: { x: 0, z: 0 }, d: 99, alert: false, pack: o.pack | 0, phase: 0, phaseT: 0, vuln: 1, noContact: false, hidden: !!(def.start === 'burrow'), hover: 0, hoverT: def.hover || 0, stunT: 0, dead: false, spdK: 1, cdK: 1, atkSet: (def.phases ? def.phases[0].atk : def.atk).slice(), fuseT: 0, shieldT: 0, shieldBroken: false, invuln: false,
    ring: null, sweep: null, circ: (seed & 1) ? 1 : -1, circT: 2 + (seed % 5) * 0.4, idleT: 0, wx: 0, wz: 0, blocked: false, ctx: null, execT: 0, windT: 0, hitDone: false, dash: null, leap: null, spikeI: 0, spikeT: 0, shootI: 0, shootT: 0, tag: o.tag || '', mode: 0, modeT: 0, lastHpf: 1, expose: 0, tgt: null, bolts: null };
  m.fsm = new MobFSM(m); mobBuild(m); m.fsm.SetState(def.start === 'burrow' ? 'burrow' : 'idle'); return m;
}
const mobEmit = (m, e) => { e.id = m.id; m.ev.push(e); return e; };
function mobHeading(m, tx, tz, k, dt) { const want = Math.atan2(tx - m.x, tz - m.z); m.face += mobWrap(want - m.face) * Math.min(1, m.def.turn * k * dt); }
function mobGo(m, ang, sp) { m.vx = Math.sin(ang) * sp; m.vz = Math.cos(ang) * sp; }
function mobStop(m) { m.vx = m.vz = 0; }
function mobCanUse(m, a, c) { // can this attack start right now?
  const d = m.d; if (m.cd[a.id] > 0 || d < a.range[0] || d > a.range[1]) return false;
  if (a.kind === 'heal') return !!(c.ally && c.ally.hurt && hyp2(c.ally.hurt.x - m.x, c.ally.hurt.z - m.z) <= a.range[1]);
  if (a.kind === 'summon') return (c.minions | 0) < (a.cap || MOB_TUNING.minionCap);
  if (a.kind === 'shield') return !m.shieldT && !m.shieldBroken;
  if (a.kind === 'swoop') return m.hover > 0.5;
  if (a.kind === 'emerge') return m.hidden;
  if (a.kind === 'charge' || a.kind === 'dash') { const w = c.wallAhead ? c.wallAhead(m.x, m.z, Math.atan2(c.hx - m.x, c.hz - m.z), Math.min(a.dist, d + 1)) : 1; return w >= 0.55; }
  return true;
}
const MOB_CAND = []; // scratch list for mobPick (the FSM is single-threaded: no per-pick allocation)
function mobPick(m, c) {
  const set = m.atkSet, def = m.def; let tot = 0; const cand = MOB_CAND; cand.length = 0;
  for (const id of set) { const a = MOB_ATK[id]; if (!a) continue; if (def.dogshoot) { const shooting = m.mode === 0, isShot = a.kind === 'shoot' || a.kind === 'lob'; if (shooting !== isShot) continue; } if (mobCanUse(m, a, c)) { cand.push(a); tot += a.wt; } }
  if (!cand.length) return null; let x = m.rng() * tot; for (const a of cand) { x -= a.wt; if (x <= 0) return a; } return cand[cand.length - 1];
}
function mobTell(m, a, c) { // the telegraph event: everything the renderer needs to draw the decal for the wind-up, and the readable "this is where it will hit" shape
  const e = { k: 'tell', atk: a.id, kind: a.kind, shape: a.tell, dur: a.wind, col: a.col, x: m.x, z: m.z, ang: m.face, r: a.r || 0, len: a.len || 0, w: a.w || 0, arc: a.arc || 0, hold: a.kind === 'lob' ? a.flight : (a.kind === 'leap' || a.kind === 'swoop') ? a.exec : 0, self: a.tell === 'self' || (a.tell === 'circle' && !['leap', 'lob', 'swoop', 'emerge', 'bolts'].includes(a.kind)), follow: a.aim > 0.5 && (a.tell === 'line' || a.tell === 'aim') };
  if (a.tell === 'circle') { if (a.kind === 'leap' || a.kind === 'lob' || a.kind === 'swoop' || a.kind === 'emerge') { e.x = m.aim.x; e.z = m.aim.z; e.follow = a.aim > 0.4; } else if (a.off) { e.x = m.x + Math.sin(m.face) * a.off; e.z = m.z + Math.cos(m.face) * a.off; } }
  if (a.kind === 'bolts') { e.pts = m.bolts.map(p => ({ x: p.x, z: p.z })); e.shape = 'multi'; }
  if (a.kind === 'star') { e.shape = 'star'; e.n = a.n; }
  if (a.kind === 'heal' && c.ally && c.ally.hurt) { e.tx = c.ally.hurt.x; e.tz = c.ally.hurt.z; }
  if (a.kind === 'fuse') { e.shape = 'circle'; e.pulse = true; }
  return mobEmit(m, e);
}
function mobBolts(m, a, c) { // target points for a bolts attack: one right on the hero (where they are going), the rest spread around
  const out = []; const n = a.n | 0; out.push({ x: c.hx + (c.hvx || 0) * 0.5, z: c.hz + (c.hvz || 0) * 0.5 });
  for (let i = 1; i < n; i++) { const ang = m.rng() * Math.PI * 2, rr = 1.5 + m.rng() * (a.spread || 4); out.push({ x: c.hx + Math.cos(ang) * rr, z: c.hz + Math.sin(ang) * rr }); } return out;
}
function mobHitCircle(m, x, z, r, c, ground) { // does the hero stand in this ground circle? (ground = only while within ~1.1 m of the floor)
  if (!c.alive) return false; const d = hyp2(c.hx - x, c.hz - z); if (d > r + 0.35) return false; if (ground && (c.hAir || 0) > 1.4) return false; return true;
}
function mobHitLine(m, x, z, ang, len, w, c) { const dx = c.hx - x, dz = c.hz - z, f = Math.sin(ang), g = Math.cos(ang), along = dx * f + dz * g, side = Math.abs(dx * g - dz * f); return c.alive && along > -0.4 && along < len && side < w / 2 + 0.35 && (c.hAir || 0) < 1.6; }
function mobStrike(m, a, shape, x, z, extra) { return mobEmit(m, Object.assign({ k: 'strike', atk: a.id, shape, x, z, ang: m.face, r: a.r || 0, dmg: a.dmg, kb: a.kb, col: a.col, hit: false }, extra || {})); }

function mobBuild(m) {
  const F = m.fsm, def = m.def;
  const common = (st, dt) => { // per-tick bookkeeping shared by every state: cooldowns, phase, hover, ring / sweep objects
    const c = m.ctx; m.d = hyp2(c.hx - m.x, c.hz - m.z); if (def.dogshoot && c.alive && m.d < m.aggro * 1.5) { m.modeT += dt; if (m.modeT > def.dogshoot[m.mode]) { m.mode ^= 1; m.modeT = 0; } } if (m.gcd > 0) m.gcd -= dt; for (const k in m.cd) if (m.cd[k] > 0) m.cd[k] -= dt; if (m.shieldT > 0) { m.shieldT -= dt; if (m.shieldT <= 0) { m.shieldT = 0; mobEmit(m, { k: 'shieldDown' }); } }
    if (def.fly && (m.st === 'idle' || m.st === 'alert' || m.st === 'move' || m.st === 'recover' || m.st === 'phase')) m.hover += (m.hoverT - m.hover) * Math.min(1, 3 * dt);
    if (m.expose > 0) { m.expose -= dt; if (m.expose <= 0) { m.vuln = 1; m.expose = 0; } }
    if (def.phases) { const f = c.hpf == null ? 1 : c.hpf; for (let i = m.phase + 1; i < def.phases.length; i++) if (f <= def.phases[i].at) { m.phase = i; const P = def.phases[i]; m.atkSet = P.atk.slice(); m.spdK = P.spd; m.cdK = P.cdK; m.phaseT = 1.5; m.invuln = true; mobStop(m); mobEmit(m, { k: 'phase', n: i, name: P.name, x: m.x, z: m.z }); m.fsm.SetState('phase'); return true; } }
    if (m.ring) { const R = m.ring; R.r += R.spd * dt; if (!R.hit && c.alive && Math.abs(m.d_ring(c) - R.r) < R.band + 0.3 && (c.hAir || 0) < 0.9) { R.hit = true; mobStrike(m, R.a, 'ringhit', R.x, R.z, { hit: true, r: R.r }); } if (R.r > R.max) m.ring = null; }
    if (m.sweep) { const S = m.sweep; S.t += dt; S.ang = S.a0 + S.dir * S.arc * Math.min(1, S.t / S.dur); const ha = Math.atan2(c.hx - S.x, c.hz - S.z), dd = hyp2(c.hx - S.x, c.hz - S.z); if (!S.hit && c.alive && dd < S.len && dd > 0.4 && Math.abs(mobWrap(ha - S.ang)) < Math.atan2(S.w / 2 + 0.35, Math.max(1, dd)) && (c.hAir || 0) < 1.6) { S.hit = true; mobStrike(m, S.a, 'beamhit', S.x, S.z, { hit: true, ang: S.ang, len: S.len, w: S.w }); } if (S.t >= S.dur) m.sweep = null; }
    return false;
  };
  m.d_ring = c => hyp2(c.hx - m.ring.x, c.hz - m.ring.z);
  // ---------------------------------------------------------------------- idle: patrol the home range (three-fps Idle / Patrol), wake up when the hero comes inside view_range
  class Idle extends MobState {
    Enter() { m.idleT = 0.6 + m.rng() * 1.8; mobStop(m); m.alert = false; }
    Update(dt) {
      if (common('idle', dt)) return; const c = m.ctx;
      if (c.alive && m.d < m.aggro) { F.SetState('alert'); return; }
      if (def.spd > 0) { m.idleT -= dt; if (m.idleT <= 0) { m.idleT = 1.2 + m.rng() * 2.4; if (m.rng() < 0.55) { const a = m.rng() * Math.PI * 2, rr = m.rng() * m.r; m.wx = m.hx + Math.cos(a) * rr; m.wz = m.hz + Math.sin(a) * rr; } else { m.wx = m.x; m.wz = m.z; } }
        const dx = m.wx - m.x, dz = m.wz - m.z, dd = hyp2(dx, dz); if (dd > 0.4 && (m.wx || m.wz)) { mobGo(m, Math.atan2(dx, dz), def.spd * m.spdK * 0.8); mobHeading(m, m.wx, m.wz, 1, dt); } else mobStop(m); }
    }
  }
  class Alert extends MobState {
    Enter() { mobStop(m); m.alertT = MOB_TUNING.alertT[0] + m.rng() * (MOB_TUNING.alertT[1] - MOB_TUNING.alertT[0]); m.alert = true; mobEmit(m, { k: 'alert', pack: m.pack, x: m.x, z: m.z, r: def.pack ? MOB_TUNING.packAlert : 0 }); }
    Update(dt) { if (common('alert', dt)) return; const c = m.ctx; mobHeading(m, c.hx, c.hz, 1.6, dt); m.alertT -= dt; if (m.alertT <= 0) F.SetState(def.start === 'burrow' ? 'burrow' : 'move'); }
  }
  // ---------------------------------------------------------------------- move: dogfight / keep (runaway + shoot) / circle (group_attack) / flee / hover (fly) / still
  class Move extends MobState {
    Update(dt) {
      if (common('move', dt)) return; const c = m.ctx, d = m.d;
      if (!c.alive) { mobStop(m); if (d > m.aggro * 1.2) F.SetState('idle'); return; }
      if (d > m.aggro * 2.4) { m.alert = false; F.SetState('idle'); return; }
      // choose an attack first (the telegraph decides the fight)
      if (m.gcd <= 0) { const a = mobPick(m, c); if (a) { m.atk = a.id; m.atkD = a; F.SetState('wind'); return; } }
      const toH = Math.atan2(c.hx - m.x, c.hz - m.z), run = def.run * m.spdK, mv = def.move;
      if (mv === 'approach') { if (d > def.reach) { mobGo(m, toH, run); } else { mobStop(m); } mobHeading(m, c.hx, c.hz, 1.4, dt); }
      else if (mv === 'keep') { m.circT -= dt; if (m.circT <= 0) { m.circ = -m.circ; m.circT = 1.6 + m.rng() * 2.2; } const lo = def.keep[0], hi = def.keep[1];
        if (def.dogshoot && m.mode === 1) { if (d > def.reach) mobGo(m, toH, run); else mobStop(m); }
        else if (d < lo) mobGo(m, toH + Math.PI + m.circ * 0.5, run); else if (d > hi) mobGo(m, toH, run * 0.9); else mobGo(m, toH + m.circ * 1.45, run * 0.45); mobHeading(m, c.hx, c.hz, 1.3, dt); }
      else if (mv === 'circle') { m.circT -= dt; if (m.circT <= 0) { m.circ = m.rng() < 0.5 ? -1 : 1; m.circT = 1.2 + m.rng() * 1.6; } const orbit = (def.keep[0] + def.keep[1]) / 2; if (d > def.keep[1] + 0.6) mobGo(m, toH, run); else if (d < def.keep[0]) mobGo(m, toH + Math.PI, run * 0.6); else mobGo(m, toH + m.circ * 1.2, run * 0.8); mobHeading(m, c.hx, c.hz, 1.6, dt); }
      else if (mv === 'flee') { const lo = def.keep[0], hi = def.keep[1]; if (d < lo) mobGo(m, toH + Math.PI + (m.circ * 0.4), run); else if (d > hi + 3) mobGo(m, toH, run * 0.6); else mobStop(m); mobHeading(m, c.hx, c.hz, 1.1, dt); }
      else if (mv === 'hover') { m.circT -= dt; if (m.circT <= 0) { m.circ = -m.circ; m.circT = 2.2 + m.rng() * 2.5; } const lo = def.keep[0], hi = def.keep[1]; if (d < lo) mobGo(m, toH + Math.PI + m.circ * 0.6, run); else if (d > hi) mobGo(m, toH, run); else mobGo(m, toH + m.circ * 1.5, run * 0.7); m.hoverT = def.hover; mobHeading(m, c.hx, c.hz, 1.2, dt); }
      else mobHeading(m, c.hx, c.hz, 1.6, dt); // still
    }
  }
  // ---------------------------------------------------------------------- wind: the telegraph (never skipped). The aim follows the hero for the first part, then locks so the decal is honest
  class Wind extends MobState {
    Enter() {
      const a = m.atkD, c = m.ctx; mobStop(m); m.windT = 0; m.aim.x = c.hx + (a.kind === 'lob' || a.kind === 'shoot' ? (c.hvx || 0) * 0.25 : 0); m.aim.z = c.hz + (a.kind === 'lob' || a.kind === 'shoot' ? (c.hvz || 0) * 0.25 : 0);
      if (a.kind === 'charge' || a.kind === 'dash' || a.kind === 'shoot' || a.kind === 'spikes' || a.kind === 'sweep') m.face = Math.atan2(m.aim.x - m.x, m.aim.z - m.z);
      if (a.kind === 'bolts') m.bolts = mobBolts(m, a, c);
      if (a.kind === 'heal') { m.tgt = c.ally.hurt; }
      if (a.kind === 'fuse') m.fuseT = a.wind;
      if (a.kind === 'blink' || a.kind === 'swoop') { /* handled below */ }
      mobTell(m, a, c);
    }
    Update(dt) {
      if (common('wind', dt)) return; const a = m.atkD, c = m.ctx; m.windT += dt;
      if (m.windT < a.wind * a.aim && (a.kind !== 'bolts')) { m.aim.x += (c.hx - m.aim.x) * Math.min(1, 9 * dt); m.aim.z += (c.hz - m.aim.z) * Math.min(1, 9 * dt); if (a.tell === 'line' || a.tell === 'aim' || a.kind === 'sweep') m.face = Math.atan2(m.aim.x - m.x, m.aim.z - m.z); }
      else if (a.kind === 'fuse') { /* the bomber keeps chasing while the fuse burns */ }
      if (a.kind === 'fuse') { const toH = Math.atan2(c.hx - m.x, c.hz - m.z); if (c.alive && m.d > 1.0) mobGo(m, toH, def.run * 0.55 * m.spdK); else mobStop(m); m.face = toH; }
      if (a.kind === 'swoop') { m.hover += (def.hover * 1.25 - m.hover) * Math.min(1, 5 * dt); mobHeading(m, m.aim.x, m.aim.z, 2, dt); }
      if (m.windT >= a.wind) F.SetState('exec');
    }
  }
  // ---------------------------------------------------------------------- exec: the hit (circle / cone / ring / line / projectiles / dash / leap / swoop / ...)
  class Exec extends MobState {
    Enter() {
      const a = m.atkD, c = m.ctx; m.execT = 0; m.hitDone = false; m.shootI = 0; m.shootT = 0; m.spikeI = 0; m.spikeT = 0; const ang = m.face;
      switch (a.kind) {
        case 'strike': { const ox = m.x + Math.sin(ang) * (a.off || 0), oz = m.z + Math.cos(ang) * (a.off || 0); let hit; if (a.tell === 'cone') { const ha = Math.atan2(c.hx - m.x, c.hz - m.z); hit = c.alive && m.d < a.r + 0.35 && Math.abs(mobWrap(ha - ang)) < a.arc / 2 && (c.hAir || 0) < 1.6; } else hit = mobHitCircle(m, ox, oz, a.r, c, true); mobStrike(m, a, a.tell === 'cone' ? 'cone' : 'circle', ox, oz, { hit, arc: a.arc || 0 }); break; }
        case 'shoot': { if (a.gap > 0) break; const n = a.n | 0; for (let i = 0; i < n; i++) { const t = n === 1 ? 0 : (i / (n - 1) - 0.5) * a.spread, base = a.ring ? i / n * Math.PI * 2 : ang; mobEmit(m, { k: 'shoot', atk: a.id, x: m.x, z: m.z, ang: a.ring ? base : base + t, spd: a.spd, dmg: a.dmg, col: a.col, ring: !!a.ring }); } break; }
        case 'lob': mobEmit(m, { k: 'shoot', atk: a.id, lob: true, x: m.x, z: m.z, tx: m.aim.x, tz: m.aim.z, flight: a.flight, dmg: a.dmg, r: a.r, cloud: a.cloud, col: a.col }); break;
        case 'dash': case 'charge': { m.dash = { dx: Math.sin(ang), dz: Math.cos(ang), left: a.dist, a }; m.hitDone = false; mobEmit(m, { k: 'dash', atk: a.id, dx: m.dash.dx, dz: m.dash.dz, spd: a.spd, dist: a.dist, col: a.col, kind: a.kind }); break; }
        case 'ring': m.ring = { x: m.x, z: m.z, r: a.r * 0.5, spd: a.spd, band: a.band, hit: false, a, max: 24 }; mobEmit(m, { k: 'ring', atk: a.id, x: m.x, z: m.z, spd: a.spd, band: a.band, max: 24, col: a.col }); break;
        case 'spikes': m.spikeI = 0; m.spikeT = 0; break;
        case 'star': { m.spikeI = 0; const n = a.n | 0; for (let i = 0; i < n; i++) { const aa = i / n * Math.PI * 2 + m.face, hit = mobHitLine(m, m.x, m.z, aa, a.len, a.w, c); mobStrike(m, a, 'line', m.x, m.z, { ang: aa, len: a.len, w: a.w, hit: hit && !m.hitDone }); if (hit) m.hitDone = true; } break; }
        case 'bolts': { for (const p of m.bolts) { const hit = mobHitCircle(m, p.x, p.z, a.r, c, true) && !m.hitDone; mobStrike(m, a, 'circle', p.x, p.z, { r: a.r, hit }); if (hit) m.hitDone = true; } break; }
        case 'summon': mobEmit(m, { k: 'summon', atk: a.id, type: a.summon, n: a.n, x: m.x, z: m.z, r: a.r }); break;
        case 'heal': if (m.tgt) mobEmit(m, { k: 'heal', atk: a.id, x: m.tgt.x, z: m.tgt.z, ref: m.tgt.ref, frac: a.heal }); break;
        case 'leap': m.leap = { x0: m.x, z0: m.z, x1: m.aim.x, z1: m.aim.z, t: 0, dur: a.exec }; mobEmit(m, { k: 'leap', atk: a.id, x: m.x, z: m.z, tx: m.aim.x, tz: m.aim.z, dur: a.exec, col: a.col }); break;
        case 'swoop': m.leap = { x0: m.x, z0: m.z, x1: m.aim.x, z1: m.aim.z, t: 0, dur: a.exec, h0: m.hover }; mobEmit(m, { k: 'leap', atk: a.id, x: m.x, z: m.z, tx: m.aim.x, tz: m.aim.z, dur: a.exec, col: a.col, swoop: true }); break;
        case 'emerge': { m.x = m.aim.x; m.z = m.aim.z; m.hidden = false; m.noContact = false; const hit = mobHitCircle(m, m.x, m.z, a.r, c, true); mobEmit(m, { k: 'emerge', atk: a.id, x: m.x, z: m.z }); mobStrike(m, a, 'circle', m.x, m.z, { r: a.r, hit }); break; }
        case 'fuse': { const hit = mobHitCircle(m, m.x, m.z, a.r, c, true); mobStrike(m, a, 'circle', m.x, m.z, { r: a.r, hit, boom: true }); mobEmit(m, { k: 'explode', atk: a.id, x: m.x, z: m.z, r: a.r, self: true }); m.dead = true; mobEmit(m, { k: 'death', how: 'self', x: m.x, z: m.z }); F.SetState('dead'); return; }
        case 'blink': { const aa = m.rng() * Math.PI * 2, rr = a.dmin + m.rng() * (a.dmax - a.dmin); mobEmit(m, { k: 'blink', atk: a.id, x: m.x, z: m.z, tx: c.hx + Math.cos(aa) * rr, tz: c.hz + Math.sin(aa) * rr }); m.x = c.hx + Math.cos(aa) * rr; m.z = c.hz + Math.sin(aa) * rr; m.cd.storm_bolts = Math.min(m.cd.storm_bolts || 0, 0.3); m.gcd = 0; break; }
        case 'sweep': { const a0 = ang - a.arc / 2; m.sweep = { x: m.x, z: m.z, a0, ang: a0, dir: 1, arc: a.arc, len: a.len, w: a.w, t: 0, dur: a.exec, hit: false, a }; mobEmit(m, { k: 'sweep', atk: a.id, x: m.x, z: m.z, a0, arc: a.arc, len: a.len, w: a.w, dur: a.exec, col: a.col }); break; }
        case 'shield': m.shieldT = a.dur; mobEmit(m, { k: 'shield', atk: a.id, dur: a.dur }); break;
      }
    }
    Update(dt) {
      if (common('exec', dt)) return; const a = m.atkD, c = m.ctx; m.execT += dt;
      if (a.kind === 'shoot' && a.gap > 0 && m.shootI < (a.n | 0)) { m.shootT -= dt; if (m.shootT <= 0) { m.shootT = a.gap; const n = a.n | 0, i = m.shootI++, t = n === 1 ? 0 : (i / (n - 1) - 0.5) * a.spread; const aim = Math.atan2(m.aim.x - m.x, m.aim.z - m.z); mobEmit(m, { k: 'shoot', atk: a.id, x: m.x, z: m.z, ang: aim + t, spd: a.spd, dmg: a.dmg, col: a.col }); } }
      if (a.kind === 'spikes') { m.spikeT -= dt; const n = a.n | 0; while (m.spikeT <= 0 && m.spikeI < n) { m.spikeT += a.exec / n; const i = m.spikeI++, f = (i + 1) / n, px = m.x + Math.sin(m.face) * a.len * f, pz = m.z + Math.cos(m.face) * a.len * f, hit = mobHitCircle(m, px, pz, a.w * 0.7, c, true) && !m.hitDone; mobStrike(m, a, 'circle', px, pz, { r: a.w * 0.7, hit, spike: true }); if (hit) m.hitDone = true; } }
      if ((a.kind === 'dash' || a.kind === 'charge') && m.dash) { const D = m.dash, step = Math.min(D.left, a.spd * dt); if (step > 0) { m.vx = D.dx * a.spd; m.vz = D.dz * a.spd; D.left -= step; } else mobStop(m);
        if (!m.hitDone && c.alive && hyp2(c.hx - m.x, c.hz - m.z) < a.w * 0.5 + 0.7 && (c.hAir || 0) < 1.6) { m.hitDone = true; mobStrike(m, a, 'hit', m.x, m.z, { hit: true, ang: Math.atan2(D.dx, D.dz) }); }
        if (m.blocked && a.stunOnWall) { m.stunT = a.stunOnWall; mobStop(m); mobEmit(m, { k: 'stun', dur: a.stunOnWall, why: 'wall', x: m.x, z: m.z }); m.dash = null; F.SetState('stun'); return; } if (D.left <= 0.001) { mobStop(m); m.dash = null; } }
      if ((a.kind === 'leap' || a.kind === 'swoop') && m.leap) { const L = m.leap; L.t += dt; const u = Math.min(1, L.t / L.dur), e = u * u * (3 - 2 * u); m.x = L.x0 + (L.x1 - L.x0) * e; m.z = L.z0 + (L.z1 - L.z0) * e; m.vx = m.vz = 0; m.hover = a.kind === 'leap' ? Math.sin(u * Math.PI) * 3.2 : (L.h0 || 0) * (1 - e);
        if (u >= 1) { m.leap = null; m.hover = 0; const hit = mobHitCircle(m, m.x, m.z, a.r, c, true); mobStrike(m, a, 'circle', m.x, m.z, { r: a.r, hit, land: true }); if (a.kind === 'swoop' && a.stun) { m.stunT = a.stun; mobEmit(m, { k: 'stun', dur: a.stun, why: 'swoop', x: m.x, z: m.z }); F.SetState('stun'); return; } } }
      if (m.execT >= a.exec && !m.sweep && !(a.kind === 'leap' && m.leap) && !(a.kind === 'swoop' && m.leap) && !(a.kind === 'spikes' && m.spikeI < (a.n | 0)) && !(a.kind === 'shoot' && a.gap > 0 && m.shootI < (a.n | 0))) { m.cd[a.id] = a.cd * m.cdK * (0.9 + m.rng() * 0.25); m.gcd = 0.25; if (a.kind === 'emerge') { m.expose = a.expose; m.vuln = MOB_TUNING.exposeVuln; F.SetState('exposed'); } else F.SetState('recover'); }
    }
  }
  class Recover extends MobState {
    Enter() { mobStop(m); }
    Update(dt) { if (common('recover', dt)) return; const a = m.atkD; mobHeading(m, m.ctx.hx, m.ctx.hz, 0.8, dt); if (m.t >= (a ? a.rec : 0.5)) F.SetState('move'); }
  }
  class Stun extends MobState { // a charger that hit a wall, a swooper that landed: helpless and takes extra damage
    Enter() { mobStop(m); m.vuln = MOB_TUNING.stunVuln; m.hover = 0; }
    Update(dt) { if (common('stun', dt)) return; m.stunT -= dt; if (m.stunT <= 0) { m.vuln = 1; m.stunT = 0; F.SetState('move'); } }
    Exit() { m.vuln = 1; m.shieldBroken = false; }
  }
  class Exposed extends MobState { // the mole above ground: vulnerable until it burrows again
    Enter() { mobStop(m); m.noContact = false; }
    Update(dt) { if (common('exposed', dt)) return; if (m.expose <= 0) { m.hidden = true; m.noContact = true; mobEmit(m, { k: 'burrow', x: m.x, z: m.z }); F.SetState('burrow'); } }
  }
  class Burrow extends MobState { // underground: invisible, tunnels toward the hero, surfaces under them after the erupt telegraph
    Enter() { m.hidden = true; m.noContact = true; mobStop(m); m.vuln = 1; }
    Update(dt) {
      if (common('burrow', dt)) return; const c = m.ctx; if (!c.alive) { mobStop(m); return; }
      if (!m.alert) { if (m.d < m.aggro) { m.alert = true; mobEmit(m, { k: 'alert', pack: m.pack, x: m.x, z: m.z, r: 0 }); } else { mobStop(m); return; } }
      if (m.d > m.aggro * 2.4) { m.alert = false; mobStop(m); return; }
      const toH = Math.atan2(c.hx - m.x, c.hz - m.z); if (m.d > 3.8) { mobGo(m, toH + Math.sin(m.t * 1.7) * 0.35, def.run * m.spdK); mobHeading(m, c.hx, c.hz, 2, dt); } else mobStop(m);
      if (m.gcd <= 0 && m.d <= 4.6 && !(m.cd.erupt > 0)) { m.atk = 'erupt'; m.atkD = MOB_ATK.erupt; F.SetState('wind'); }
    }
  }
  class PhaseS extends MobState { // boss phase change: roar + brief invulnerable pause
    Enter() { mobStop(m); }
    Update(dt) { m.phaseT -= dt; m.d = hyp2(m.ctx.hx - m.x, m.ctx.hz - m.z); if (m.phaseT <= 0) { m.invuln = false; m.gcd = 0.4; F.SetState('move'); } }
  }
  class Dead extends MobState { Enter() { mobStop(m); m.dead = true; } Update() { } }
  F.AddState('idle', new Idle(F, 'idle')); F.AddState('alert', new Alert(F, 'alert')); F.AddState('move', new Move(F, 'move')); F.AddState('wind', new Wind(F, 'wind')); F.AddState('exec', new Exec(F, 'exec')); F.AddState('recover', new Recover(F, 'recover'));
  F.AddState('stun', new Stun(F, 'stun')); F.AddState('exposed', new Exposed(F, 'exposed')); F.AddState('burrow', new Burrow(F, 'burrow')); F.AddState('phase', new PhaseS(F, 'phase')); F.AddState('dead', new Dead(F, 'dead'));
}
// one fixed step. ctx = { hx, hz, hy, hAir (hero height above the floor), alive, hvx, hvz, hpf (this mob's hp fraction 0..1), minions (alive summons), ally: {hurt:{x,z,ref}|null}, move(m, nx, nz) -> false when blocked, wallAhead(x, z, ang, len) -> 0..1 free fraction }
function mobTick(m, dt, ctx) {
  if (m.dead) return m.ev; m.ctx = ctx; m.fsm.Update(dt); m.t += dt; m.blocked = false; // blocked = last step's wall hit, read by the NEXT update (charge -> wall stun)
  if (m.vx || m.vz) { const nx = m.x + m.vx * dt, nz = m.z + m.vz * dt; if (ctx.move) { if (ctx.move(m, nx, nz) === false) m.blocked = true; } else { m.x = nx; m.z = nz; } }
  return m.ev;
}
function mobAlert(m) { if (!m.dead && (m.st === 'idle' || m.st === 'burrow')) { if (m.st === 'idle') m.fsm.SetState('alert'); } }
function mobShieldFactor(m, sx, sz, kind) { // damage multiplier for a hit from (sx,sz): the Bulwark Crab's frontal shield, the Hollow's crystal shell
  if (m.dead) return 1; const d = m.def;
  if (m.shieldT > 0) { if (kind === 'pound') { m.shieldT = 0; m.stunT = 2.0; m.expose = 0; mobEmit(m, { k: 'shieldBreak', x: m.x, z: m.z }); mobEmit(m, { k: 'stun', dur: 2.0, why: 'shield', x: m.x, z: m.z }); m.fsm.SetState('stun'); return 1; } return 0.1; }
  if (d.shield && !m.shieldBroken && m.st !== 'stun') { const ha = Math.atan2(sx - m.x, sz - m.z), off = Math.abs(mobWrap(ha - m.face)); if (off < d.shield.arc / 2) { if (kind === 'pound') { m.shieldBroken = true; m.stunT = 2.4; mobEmit(m, { k: 'shieldBreak', x: m.x, z: m.z }); mobEmit(m, { k: 'stun', dur: 2.4, why: 'shield', x: m.x, z: m.z }); m.fsm.SetState('stun'); return 1; } mobEmit(m, { k: 'clang', x: m.x, z: m.z }); return d.shield.front; } }
  return m.vuln;
}
function mobHurt(m, srcx, srcz) { if (m.dead) return; m.aggro = Math.max(m.aggro, m.def.aggro); if (m.st === 'idle') m.fsm.SetState('alert'); }
function mobDie(m, how) { // death: family-specific last words (the bomber that was lit blows up, the Weaver's brood vanishes, the guardian announces itself)
  if (m.dead) return m.ev; const d = m.def; const wasFuse = m.st === 'wind' && m.atk === 'fuse'; m.dead = true; m.ring = null; m.sweep = null; m.fsm.SetState('dead');
  mobEmit(m, { k: 'death', how: how || 'hit', x: m.x, z: m.z, boss: !!d.boss, mini: !!d.mini });
  if (wasFuse) mobEmit(m, { k: 'explode', x: m.x, z: m.z, r: MOB_ATK.fuse.r * 0.55, self: false, half: true });
  if (d.fam === 'summoner' || d.boss) mobEmit(m, { k: 'unsummon', x: m.x, z: m.z });
  if (d.fam === 'artillery') mobEmit(m, { k: 'cloud', x: m.x, z: m.z, r: 2.0, dur: 2.2 });
  return m.ev;
}
function mobSnapshot(m) { return { id: m.id, st: m.st, atk: m.atk, x: +m.x.toFixed(3), z: +m.z.toFixed(3), face: +m.face.toFixed(3), hover: +m.hover.toFixed(3), phase: m.phase, vuln: m.vuln, hidden: m.hidden, dead: m.dead, hp: m.lastHpf }; }
// bounty / loot tags for the food + crafting layers: which ingredient a mob type drops (the tables live in food-core, this is the link)
// </mob-core>

