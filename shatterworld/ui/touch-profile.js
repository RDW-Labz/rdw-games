// Shatterworld phone profile (read by tools/touch-shim.js as window.__touchProfile). Two button sets that swap by mode: 'field' (campaign / rift: skills, Star Power) and 'town' (pack, potion, camera).
// The three thumb-rest slots and the left column are shared. Every button feeds the SAME key / padFire / padPlace paths as the keyboard, the phone pad and the gamepad shim.
window.__touchProfile = {
  menuQuit: false, fanLift: 0, utilX: 58, overlays: ['inv', 'perkpick', 'chars', 'sta'],
  mode: () => (typeof TW !== 'undefined' && TW.on) ? 'town' : 'field',
  buttons: [
    { id: 'fire', label: 'PUNCH\nDIVE', t: 'fire', ring: 1, big: 1, drag: true },
    { id: 'jump', label: 'JUMP', t: 'key', k: ' ', ring: 1 },
    { id: 'alt', label: 'REWIND', t: 'place', ring: 1 },
    { id: 's1', label: '1', t: 'key', k: '1', only: 'field' }, { id: 's2', label: '2', t: 'key', k: '2', only: 'field' }, { id: 's3', label: '3', t: 'key', k: '3', only: 'field' }, { id: 's4', label: '4', t: 'key', k: '4', only: 'field' },
    { id: 'star', label: 'STAR', t: 'key', k: 'g', only: 'field' },
    { id: 'pack', label: 'PACK', t: 'key', k: 'b', only: 'town' }, { id: 'potion', label: 'POTION', t: 'key', k: 'h', only: 'town' }, { id: 'cam', label: 'CAM', t: 'key', k: 'j', only: 'town' }, { id: 'rc', label: 'RECENTRE', t: 'key', k: 'q', only: 'town' },
    { id: 'sprint', label: 'SPRINT', t: 'key', k: 'shift', side: 'L', mode: 'toggle' },
    { id: 'pound', label: 'POUND\nCROUCH', t: 'key', k: 'z', side: 'L' },
    { id: 'use', label: 'USE\nBAG', t: 'key', k: 'e', side: 'L' },
  ],
};
// The touch shim hides the on-screen buttons while the bag / perk picker / class picker / station panels are up, so those panels must close by tap: the station panel has its own X, the bag gets one here (the footer key chips are only hints).
{ const hd = document.querySelector('#inv .invHead'); if (hd && !document.getElementById('invClose')) { hd.insertAdjacentHTML('beforeend', '<button class="chip" id="invClose" aria-label="Close" style="min-height:34px;min-width:42px;margin-left:auto;font-size:.9em">X</button>'); const b = document.getElementById('invClose'); b.addEventListener('click', e => { e.stopPropagation(); if (RUI.open) closeInv(); }); b.addEventListener('mousedown', e => e.stopPropagation()); b.addEventListener('pointerdown', e => e.stopPropagation()); } }
// Menu / pause / dead-screen chips are mouse-sized in the base build (about 20 px tall): on a coarse pointer they get a 40 px touch target.
{ const st = document.createElement('style'); st.id = 'swbTouchCss'; st.textContent = '@media (pointer:coarse){#rpgMenu button,#rpgDeadBtns button,#toMenuBtn,#pauseInvBtn,#pauseClsBtn,#pauseTownBtn,#deadTownBtn{min-height:40px;padding:.35em 1.3em}#rpgMenu{gap:8px 12px}#chGo,#chBack{min-height:40px}}'; document.head.appendChild(st); }

