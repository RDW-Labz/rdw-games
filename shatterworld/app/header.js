// ============================================================================
// SHATTERWORLD - a realistic valley that shatters into blocks and rebuilds as stranger worlds.
// All art is procedural, all sound is WebAudio. three.js r169 + postprocessing addons only.
// This build adds WebXR (Quest Browser first, PC-VR via desktop Chrome): see the "WEBXR / VR" block + TUNING.vr. Flat play (keyboard/mouse, Xbox/PS pad, phone pad) is unchanged.
// MERGED BUILD = base + RPG layer (<rpg-core>, <rpg-game>: loot, perks, rifts; UI state object is RUI) + VR layer (UI = the VR panels) + the <vr-rpg> block that mirrors the RPG overlays
// into world-space panels (inventory / perk pick / HUD strip / plates / haptics) and trims RPG objects for the diorama (distance cull, beam cap, single-pass additive materials).
// ============================================================================
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

window.__gameId = 'shatterworld-next';
window.__game = { id: 'shatterworld-next' };
// TEST TILE ISOLATION: this build runs next to the verified main game on the same origin and NEVER writes or deletes its keys (sw_rpg, sw_vr, sw_q, sw_pdb, sw_mute, sw_best, ib_saves.shatterworld).
// Everything it saves lives under swn_* (+ ib_saves['shatterworld-next'] through the shelf bridge). First run only: the old sw_rpg / sw_vr are READ and copied (as the Pip class) into swn_rpg / swn_vr, then flagged in swn_imported.
(function swnImport() {
  try {
    if (localStorage.getItem('swn_imported')) return;
    let from = '', vr = false;
    const rd = k => { try { const v = localStorage.getItem(k); if (v) { JSON.parse(v); return v; } } catch (e) { } return null; }; // read-only; anything unparseable is ignored
    if (localStorage.getItem('swn_rpg') === null) {
      let v = rd('sw_rpg');
      if (v) from = 'sw_rpg';
      else { try { const g = (JSON.parse(localStorage.getItem('ib_saves') || '{}') || {}).shatterworld; if (g && g.rpg) { v = JSON.stringify(g.rpg); from = 'ib_saves'; } } catch (e) { } }
      if (v) localStorage.setItem('swn_rpg', v);
    }
    const ov = rd('sw_vr'); if (ov && localStorage.getItem('swn_vr') === null) { localStorage.setItem('swn_vr', ov); vr = true; }
    localStorage.setItem('swn_imported', JSON.stringify({ t: Date.now(), rpg: from, vr }));
  } catch (e) { }
})();

