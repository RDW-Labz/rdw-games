// <ux-nav> ====================================================================================================================
// SHATTERWORLD navigation quick wins (games/DESIGN-menu-ux.md, section 5). Everything here RE-BINDS or ADDS from the outside, the way every other layer of this file does;
// the few in-place edits (template strings, three close functions) are listed in patches/apply-quickwins.mjs. Nothing here runs per frame.
// Items: QW1 Esc closes a station . QW2 RESUME button in Pause . QW3 pad B / Z resumes from Pause, pad X / J opens CHARACTER . QW4 TOWN chip in the inventory header
//        QW6 BACK TO MENU asks first when a run would be lost . QW7 title: legend collapses after the first run, Esc + T row, CONTROLS toggle, PAD hints only with a pad, SHELF link
//        QW9 "ESC MENU" tag in the desktop HUD. (QW5 dead-screen MENU, QW8 class button labels, QW10 back-to-Pause and QW11 camera toggle are in-place edits.)
if (!/[?&]ux=0/.test(location.search)) { // ?ux=0 switches this whole block off (the in-place string edits are reverted by reverting the diff)
{
  const st = document.createElement('style');
  st.textContent = '#pauseResumeRow{flex-basis:100%;display:flex;justify-content:center;margin-bottom:4px}'
    + '#pauseResumeBtn{font:inherit;letter-spacing:.3em;font-size:16px;font-weight:900;color:#2a1400;background:linear-gradient(180deg,#fff2b0,#ffc54a 55%,#ff9c2b);border:0;border-radius:999px;padding:.5em 2.6em;cursor:pointer}'
    + 'body:not(.haspad) .pk,body:not(.haspad) .padline{display:none}'      // pad glyph suffixes and the PAD line only matter once a pad is connected
    + 'body.legend0 .cheat{display:none}'
    + '#legendBtn{font:inherit;letter-spacing:.14em;cursor:pointer;color:#eaf6ff;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.3);border-radius:999px;padding:.25em 1em}'
    + '#shelfLink{position:fixed;left:14px;top:12px;z-index:11;font:700 12px/1 system-ui,sans-serif;letter-spacing:.14em;color:#eaf6ff;text-decoration:none;background:rgba(10,22,34,.62);border:1px solid rgba(255,255,255,.3);border-radius:999px;padding:.6em 1.2em}'
    + '#menuTag{opacity:.55;font-size:.8em;letter-spacing:.14em}body.haspad .kbt,body:not(.haspad) .pdt{display:none}'
    + '@media (pointer:coarse){#pauseResumeBtn,#invTown,#legendBtn,#shelfLink{min-height:44px}#menuTag{display:none}}';
  document.head.appendChild(st);
}
// QW1: Escape closes a station. The base handler returns on Escape before keys.add, so suiKey('escape') is never reached (verified by the node probe).
addEventListener('keydown', e => { if (e.key === 'Escape' && SUI.open) suiClose(); });
// QW2: an explicit RESUME button (a click anywhere on the overlay still resumes; the button needs no handler of its own: its click bubbles to #pause, its mousedown reaches the window handler)
$('pauseBtns').insertAdjacentHTML('afterbegin', '<div id="pauseResumeRow"><button id="pauseResumeBtn">RESUME</button></div>');
// QW3: in Pause, B (= Z) resumes like Esc does, X (= J) opens CHARACTER (the pad has no C key). rpgSwallow so a held B is not read as a fresh crouch / pound.
{ const _k = rpgKeyDown; rpgKeyDown = function (k) {
  if (G.state === 'pause' && !PK.open && !RUI.open && !CSU.open && !SUI.open) { if (k === 'z') { resumeGame(); rpgSwallow(); return; } if (k === 'j') { openChars(); rpgSwallow(); return; } }
  _k(k); }; }
// QW4: a TOWN chip next to the inventory X (THE GATE when you are already in town). Inside a rift it asks first (second press within 2.6 s), like X-twice-to-salvage does.
{ const hd = document.querySelector('#inv .invHead'); if (hd && !document.getElementById('invTown')) {
  const b = document.createElement('button'); b.id = 'invTown'; b.className = 'chip'; b.setAttribute('aria-label', 'Home town'); b.textContent = 'TOWN'; b.style.cssText = 'min-height:34px;min-width:42px;margin-left:auto;font-size:.9em';
  const x = document.getElementById('invClose'); if (x && x.parentNode) { x.parentNode.insertBefore(b, x); x.style.marginLeft = '6px'; } else hd.appendChild(b);
  let armed = -9; b.addEventListener('click', e => { e.stopPropagation(); if (!RUI.open) return;
    if (RIFT && !RIFT.done && RT.real - armed > 2.6) { armed = RT.real; toast('Press TOWN again to abandon this rift'); rsfx('deny'); return; }
    armed = -9; const inTown = TW.on; closeInv(); if (inTown) suiOpen('portal'); else townEnter(); });
  b.addEventListener('mousedown', e => e.stopPropagation()); b.addEventListener('pointerdown', e => e.stopPropagation());
  const _ri = rpgRenderInv; rpgRenderInv = function () { _ri(); if (RUI.open) b.textContent = TW.on ? 'THE GATE' : 'TOWN'; }; } }
// QW6: BACK TO MENU discards the run (toMenu = startRun), so when there is something to lose the first tap only arms the button. Capture phase + stopImmediatePropagation keeps the original handler untouched.
{ let armedAt = -9e9; $('pause').addEventListener('click', e => {
  if (!e.target || e.target.id !== 'toMenuBtn') return; const btn = e.target, lose = G.started && (TW.on ? !!(TW.ret && TW.ret.run) : (G.act > 1 || G.t > 30 || !!RIFT)); // in town only a paused campaign is at stake
  if (!lose) return; if (performance.now() - armedAt < 2600) { armedAt = -9e9; btn.textContent = 'BACK TO MENU'; return; } // second tap: fall through to toMenu()
  e.stopImmediatePropagation(); armedAt = performance.now(); btn.textContent = 'LEAVE RUN? TAP AGAIN'; setTimeout(() => { btn.textContent = 'BACK TO MENU'; armedAt = -9e9; }, 2600); }, true); }
// QW7: title. (a) pad glyphs only when a pad is connected (or ?pad= forces a family); (b) the key legend collapses after the first run and has a CONTROLS toggle; (c) the legend finally lists Esc and T; (d) a SHELF link.
{ const padNow = () => { try { const gs = navigator.getGamepads ? navigator.getGamepads() : []; for (let i = 0; i < gs.length; i++) if (gs[i] && gs[i].connected && gs[i].mapping !== 'xr-standard') return true; } catch (e) { /* no pads */ } return !!(typeof padS === 'function' && padS().force); };
  const sync = () => document.body.classList.toggle('haspad', padNow()); addEventListener('gamepadconnected', sync); addEventListener('gamepaddisconnected', sync); sync();
  let l0 = false; try { l0 = localStorage.getItem('swn_legend') === '0'; } catch (e) { /* private mode */ } document.body.classList.toggle('legend0', l0);
  const q = $('menu').querySelector('.qrow'); if (q) { const lb = document.createElement('button'); lb.id = 'legendBtn'; lb.textContent = 'CONTROLS'; lb.addEventListener('click', e => { e.stopPropagation(); const on = document.body.classList.toggle('legend0'); try { localStorage.setItem('swn_legend', on ? '0' : '1'); } catch (er) { /* ignore */ } }); q.appendChild(lb); }
  const ch = $('menu').querySelector('.cheat'); if (ch) ch.insertAdjacentHTML('beforeend', '<div class="wide"><kbd>ESC</kbd> pause menu (resume, inventory, character, HOME TOWN) &middot; <kbd>T</kbd> home town from the title, pause and result screens &middot; <kbd>C</kbd> character &middot; <kbd>J</kbd> start a Shatter Rift (title)</div>');
  const _bg = beginGame; beginGame = function () { _bg(); try { if (localStorage.getItem('swn_legend') == null) { localStorage.setItem('swn_legend', '0'); document.body.classList.add('legend0'); } } catch (e) { /* ignore */ } };
  const a = document.createElement('a'); a.id = 'shelfLink'; a.href = '../'; a.textContent = '< SHELF'; a.addEventListener('click', e => { e.preventDefault(); if (window.opener && !window.opener.closed) { window.close(); setTimeout(() => { location.href = '../'; }, 200); } else location.href = '../'; }); a.addEventListener('mousedown', e => e.stopPropagation()); $('menu').appendChild(a); }
// QW9: desktop players get a one-word pointer to the pause menu (touch has its MENU button, VR has Y)
{ const hr = $('hudR'); if (hr) hr.insertAdjacentHTML('beforeend', '<br><span id="menuTag"><span class="kbt">ESC</span><span class="pdt">START</span> MENU</span>'); }
}
// </ux-nav>


