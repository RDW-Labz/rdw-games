// ==============================================================================================================================================================================================
// INPUT ROUTING: 1-4 cast; LB(Q)+A/B/X/Y cast slot 1-4 (the face button is swallowed, so nothing else fires: no dead keys: LB tap still recentres on release); G or LB+RB = Star Power
// ==============================================================================================================================================================================================
const GFACE = { ' ': 0, z: 1, j: 2, e: 3 };
function gemQEdge() { GM.qHeld = true; GM.qUsed = false; GM.qT = 0; }
function gemKeyDown(k) {
  if (k.length === 1 && k >= '1' && k <= '4') { gemCast(+k - 1); return; } if (k === 'g') { starTry(false); return; }
  if ((k === 'shift' && keys.has('q')) || (k === 'q' && keys.has('shift'))) { if (STAR.meter >= GEM_TUNING.star.max - 0.01 && starTry(false)) GM.qUsed = true; }
}
const _rpgKeyDown2 = rpgKeyDown;
rpgKeyDown = function (k) {
  if (CSU.open) { clsKey(k); return; } if (!PK.open && !RUI.open) { const st = G.state; if (st === 'play') gemKeyDown(k); else if (st === 'pause' && k === 'c') { openChars(); return; } else if (st === 'menu' && (k === 'z' || k === 'c')) { openChars(); return; } }
  _rpgKeyDown2(k);
};
{ const _add = keys.add; keys.add = function (k) { if (G.state === 'play' && GFACE[k] !== undefined && keys.has('q') && !keys.has(k) && !VR.presenting) { GM.qUsed = true; gemCast(GFACE[k]); return keys; } return _add.call(keys, k); }; }
const _uiKey2 = uiKey; uiKey = function (k) { if (RUI.tab === 5 && GU.tgt && UI_MAP[k] === 'B') { GU.tgt = null; rpgRenderInv(); return; } _uiKey2(k); };
const _padMenu2 = padMenu; padMenu = function () { if (CSU.open) { closeChars(); return; } _padMenu2(); };
const _padFire2 = padFire; padFire = function (down) { if (CSU.open) { if (down === true || down === undefined) clsConfirm(); return; } _padFire2(down); };
const _padPlace2 = padPlace; padPlace = function (down) { if (CSU.open) return; _padPlace2(down); };
addEventListener('keydown', e => { if (e.key === 'Escape' && CSU.open) closeChars(); });
$('pauseBtns').insertAdjacentHTML('beforeend', '<button id="pauseClsBtn" style="font:inherit;letter-spacing:.2em;font-size:12px;color:#06221f;background:linear-gradient(180deg,#b9fff4,#53e0d0 55%,#1fb6a6);border:0;border-radius:999px;padding:.4em 1.4em;cursor:pointer;font-weight:800">CHARACTER</button>');
$('pauseClsBtn').addEventListener('mousedown', e => e.stopPropagation()); $('pauseClsBtn').addEventListener('click', e => { e.stopPropagation(); openChars(); });
$('menu').querySelector('.cheat').insertAdjacentHTML('beforeend', '<div class="wide"><kbd>SKILLS &amp; STAR</kbd> keys 1-4 cast your hotbar &middot; pad / phone pad: hold <span data-pad="LB">LB</span> (Q) + <span data-pad="A B X Y">A B X Y</span> = slots 1-4 (a tap of <span data-pad="LB">LB</span> still recentres) &middot; Star Power: G or <span data-pad="LB + RB">LB + RB</span> &middot; VR: wrist skill bar (poke + trigger), right stick flick up / down = slots 1 / 2, both grips = Star Power &middot; C or the CHARACTER button (pad: <span data-pad="B">B</span> on this screen) picks your character</div>');

