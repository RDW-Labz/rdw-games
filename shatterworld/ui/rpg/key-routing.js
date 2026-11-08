// ---- key routing: every key (keyboard, pad shim, phone pad bridge) goes through keys.add -------------------------------------------------------------------------------
function rpgSwallow() { latch.clear(); _pk.jump = keys.has(' '); _pk.z = keys.has('z'); _pk.e = keys.has('e'); _pk.j = keys.has('j'); _pk.q = keys.has('q'); _pk.fire = false; edge.fire = edge.place = edge.e = edge.j = edge.q = false; P.jumpBuf = P.zBuf = P.fireBuf = 0; placeLatch = false; }
function rpgKeyDown(k) {
  if (PK.open) { perkKey(k); return; } if (RUI.open) { uiKey(k); return; }
  const st = G.state;
  if (st === 'play') { if (k === 'i' || k === 'tab') openInv(); else if (k === 'e' && !VR.eKey && !(NPC.active && NPC.near) && !/Press E/.test(PROMPT)) openInv(); /* VR.eKey: the R-stick click (talk / flip pad) must never pop the inventory open */ else if (k === 'f') { RP.filter = !RP.filter; RT.dirty = true; toast(RP.filter ? 'Common drops hidden' : 'Showing all drops'); rsfx('lock'); } }
  else if (st === 'pause') { if (k === 'i' || k === 'tab' || k === 'e') openInv(RP.pending ? 2 : null); }
  else if (st === 'menu') menuKey(k);
  else if (st === 'dead') { if (k === 'i' || k === 'tab' || k === 'e') openInv(RP.pending ? 2 : null); else if (k === 'z' && (RIFT || G.won)) toMenu(); else if (k === 'j' && RIFT) rpgRiftRestart(false, false); }
}
{ const proto = Object.getPrototypeOf(keys), base = proto.add; keys.add = function (k) { const fresh = !keys.has(k); const r = base.call(keys, k); if (fresh) { try { rpgKeyDown(k); } catch (err) { console.error('rpg key', err); } } return r; }; }
addEventListener('keydown', e => { if (e.key === 'Tab') e.preventDefault(); if (e.key === 'Escape' && RUI.open) { if (RUI.rr) { RUI.rr = null; rpgRenderInv(); } else closeInv(); } });
const _closeInv = closeInv; closeInv = function () { _closeInv(); rpgSwallow(); }; const _closePerks = closePerks; closePerks = function () { _closePerks(); rpgSwallow(); };

