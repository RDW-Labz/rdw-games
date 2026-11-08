// <pad-labels> What the buttons of the connected pad are called. The shipped text names buttons the Xbox way (A/B/X/Y/LB/RB/LT/RT);
// padTxt() renames those whole-word tokens for the detected pad family, so a DualSense reads Cross/Circle/Square/Triangle/L1/R1/L2/R2
// (Switch Pro: B/A/Y/X by position, L/R/ZL/ZR); cramped chips (the gem bar) ask for padTxt(t, true) = the DualSense face symbols. Xbox pads, keyboard, phone pad and VR (Touch controllers are A/B/X/Y) keep the source text.
// Static markup carries data-pad="<xbox text>" and padRefresh() rewrites it when the family changes; dynamic text calls padTxt() while it renders.
// ?pad=xbox|ps|nin forces a family (screenshots / tests); window.__game.padFamily(f) does the same at runtime (no argument = read).
function padS() { // lazy state: safe to call before the rest of the module has run
  if (padS.s) return padS.s;
  const S = padS.s = { fam: 'xbox', force: '', n: {
    ps: { A: 'Cross', B: 'Circle', X: 'Square', Y: 'Triangle', LB: 'L1', RB: 'R1', LT: 'L2', RT: 'R2', Start: 'Options' },
    nin: { A: 'B', B: 'A', X: 'Y', Y: 'X', LB: 'L', RB: 'R', LT: 'ZL', RT: 'ZR', Start: '+' } },
  cn: null, /* compact names (cramped chips such as the gem bar): the DualSense face symbols */
  re: /\b(?:LB|RB|LT|RT|A|B|X|Y)\b|\bStart(?= =)/g };
  S.cn = { ps: Object.assign({}, S.n.ps, { A: '\u00d7', B: '\u25cb', X: '\u25a1', Y: '\u25b3' }), nin: S.n.nin };
  try { const q = new URLSearchParams(location.search).get('pad'); if (q === 'xbox' || (q && S.n[q])) S.force = q; } catch (e) { /* no URL */ }
  return S;
}
function padFamOf(id) { /* Chrome: "Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e ...)", "DualSense Wireless Controller", "Wireless Controller (... 054c ...)"; Firefox: "054c-0ce6-Wireless Controller" */
  const s = String(id || '').toLowerCase();
  if (/xbox|xinput|045e|microsoft/.test(s)) return 'xbox';
  if (/dualsense|dualshock|playstation|sony|054c|ps[345]\b|wireless controller/.test(s)) return 'ps';
  if (/057e|pro controller|nintendo|switch|joy-?con/.test(s)) return 'nin';
  return 'xbox';
}
function padFam() { const S = padS(); let vr = false; try { vr = !!VR.presenting; } catch (e) { /* VR not built yet */ } return vr ? 'xbox' : (S.force || S.fam); }
function padTxt(t, compact) { const f = padFam(); if (f === 'xbox') return t; const S = padS(), m = (compact ? S.cn : S.n)[f]; return String(t).replace(padS().re, k => m[k] || k); }
function padRefresh() {
  for (const el of document.querySelectorAll('[data-pad]')) { const t = padTxt(el.getAttribute('data-pad'), el.hasAttribute('data-padc')); if (el.textContent !== t) el.textContent = t; }
  try { if (RUI.open && !VR.presenting) rpgRenderInv(); } catch (e) { /* inventory not ready */ }
  try { if (SUI.open) SUI.dirty = true; } catch (e) { /* stations not ready */ }
}
function padSet(f) { const S = padS(); if (S.fam === f) return; S.fam = f; padRefresh(); }
function padScan() { try { const gs = navigator.getGamepads ? navigator.getGamepads() : []; for (let i = 0; i < gs.length; i++) { const g = gs[i]; if (g && g.connected && g.mapping !== 'xr-standard') return padSet(padFamOf(g.id)); } } catch (e) { /* no pads */ } padSet('xbox'); }
addEventListener('gamepadconnected', e => { try { if (e.gamepad && e.gamepad.mapping !== 'xr-standard') padSet(padFamOf(e.gamepad.id)); } catch (er) { /* ignore */ } });
addEventListener('gamepaddisconnected', () => padScan());
padScan(); padRefresh();
window.__game = window.__game || {}; window.__game.padFamily = f => { if (f !== undefined) { padS().force = f || ''; padRefresh(); } return padFam(); }; window.__game.padFamOf = padFamOf; window.__game.padTxt = padTxt;

