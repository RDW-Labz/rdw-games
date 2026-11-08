// ---- per-hand input state (0 = left, 1 = right) -----------------------------------------------------------------------------------
// mask bits: 1 trigger, 2 grip, 4 A/X, 8 B/Y, 16 stick click. m = raw, e = effective (after suppression), pm/pe = previous frame
const mkHand = () => ({ has: false, hand: false, src: null, ax: 0, ay: 0, trig: 0, grip: 0, stick: false, b4: false, b5: false, trigOn: false, gripOn: false, m: 0, pm: 0, e: 0, pe: 0, sup: 0, rawRise: 0, rise: 0, lastHap: 0 });
const XI = [mkHand(), mkHand()];
const XK = new Set(); // keys injected by the VR layer
function xkey(k, on) { if (on) { if (!keys.has(k)) keys.add(k); XK.add(k); } else if (XK.has(k)) { XK.delete(k); keys.delete(k); } }
function vrAxisKeys(neg, pos, v) { xkey(neg, XK.has(neg) ? v < -0.22 : v < -0.38); xkey(pos, XK.has(pos) ? v > 0.22 : v > 0.38); }

