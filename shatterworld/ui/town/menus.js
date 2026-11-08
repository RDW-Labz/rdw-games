// ---- the menus: HOME TOWN buttons in the DOM (main menu, pause, dead / win) and in the VR panels (patched in edits) ---------------------------------------------------------------------------------------------------------
(() => {
  const pb = document.createElement('button'); pb.id = 'pauseTownBtn'; pb.textContent = 'HOME TOWN'; $('pauseBtns').appendChild(pb); pb.addEventListener('mousedown', e => e.stopPropagation()); pb.addEventListener('click', e => { e.stopPropagation(); if (TW.on) suiOpen('portal'); else townEnter(); });
  const upd = () => { pb.textContent = TW.on ? 'THE GATE' : 'HOME TOWN'; }; setInterval(upd, 400);
})();
