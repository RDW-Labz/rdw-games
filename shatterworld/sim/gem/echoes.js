// ---- echoes (support: repeat) -------------------------------------------------------------------------------------------------------------------------------------------------------------------
for (let i = 0; i < 8; i++) GM.echoes.push({ on: false, t: 0, R: null, yaw: 0, mul: 1, k: 0 });
function gemEcho(R, yaw, delay, mul, k) { for (const q of GM.echoes) if (!q.on) { q.on = true; q.t = delay; q.R = R; q.yaw = yaw; q.mul = mul; q.k = k; return; } }
function echoUpdate(dt) { for (const q of GM.echoes) { if (!q.on) continue; q.t -= dt; if (q.t <= 0) { q.on = false; const sk = SK[q.R.id]; sk.fire({ R: q.R, yaw: q.yaw, mul: q.mul, k: q.k, echo: true }); } } }

