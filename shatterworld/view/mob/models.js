// <mob-models> ==================================================================================================================
// SHATTERWORLD mob variety, part 2a: procedural models. Every mob is built with the SAME part() / outline-hull builder as the original walker / hero (parametrised by shape + palette),
// so it carries userData.vrp / vro and is merged into one vertex-coloured mesh (+ one outline mesh) while presenting in VR. The small swarm types (Scuttler, Fusebug) are baked into
// ONE shared geometry and drawn as InstancedMesh (all of them = 2 draw calls, however many).
// ==============================================================================================================================
const MM_CACHE = {};
// the darkest palette entries (guardian shells, boots, hulls) read as pure black blobs once shadows + the toon outline are on: lift anything under a linear luminance of 0.045 (keeps hue)
function mmLift(m) { const c = m.color, l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; if (l < 0.045) { const k = Math.min(8, 0.045 / Math.max(l, 1e-4)); c.r = Math.min(1, Math.max(c.r * k, 0.02)); c.g = Math.min(1, Math.max(c.g * k, 0.015)); c.b = Math.min(1, Math.max(c.b * k, 0.03)); m.emissive.copy(c); } return m; }
const mmat = hex => MM_CACHE[hex] || (MM_CACHE[hex] = mmLift(hv(parseInt(hex.slice(1), 16))));
const mglow = (hex, k = 1.5) => { const c = new THREE.Color(hex); c.multiplyScalar(k); return new THREE.MeshBasicMaterial({ color: c, fog: false, toneMapped: false }); };
const MOB_GEO = { cone: new THREE.ConeGeometry(1, 1, 7), oct: new THREE.OctahedronGeometry(1, 0), box: new THREE.BoxGeometry(1, 1, 1), torus: new THREE.TorusGeometry(1, 0.1, 6, 24), disc: new THREE.CylinderGeometry(1, 1, 1, 18) };
const mpart = (parent, geo, hex, x, y, z, sx, sy, sz, ol = 0.06) => part(parent, geo, mmat(hex), x, y, z, sx, sy, sz, ol);
const mgpart = (parent, geo, mat, x, y, z, sx, sy, sz) => part(parent, geo, mat, x, y, z, sx, sy, sz, 0);
const eyes = (parent, y, z, spread, s, hexW = '#ffffff', hexP = '#101010') => { for (const q of [-1, 1]) { mpart(parent, SPH, hexW, q * spread, y, z, s, s * 1.2, s * 0.7, 0); mpart(parent, SPH, hexP, q * spread, y - s * 0.05, z + s * 0.5, s * 0.5, s * 0.6, s * 0.3, 0); } };
// every builder returns { g, body, x: { named extras the animator uses } } and leaves the model facing +z, standing on y = 0
const MOB_SHAPES = {
  slinger(P) { const g = new THREE.Group(), body = new THREE.Group(); g.add(body); const arm = new THREE.Group(); arm.position.set(0.34, 0.62, 0.05); body.add(arm);
    mpart(body, SPH, P[0], 0, 0.45, 0, 0.42, 0.4, 0.38); mpart(body, SPH, P[2], 0, 0.36, 0.2, 0.26, 0.22, 0.14, 0.03); mpart(body, MOB_GEO.cone, P[1], 0, 1.05, 0, 0.3, 0.55, 0.3); eyes(body, 0.72, 0.28, 0.12, 0.1, '#ffe9a0', '#331000');
    for (const q of [-1, 1]) mpart(body, SPH, P[1], q * 0.18, 0.08, 0.06, 0.15, 0.09, 0.22, 0.04); mpart(arm, CYL, P[0], 0, -0.1, 0, 0.09, 0.3, 0.09, 0.04); const orb = mglow(P[2]); mgpart(arm, SPH, orb, 0, 0.28, 0.1, 0.17, 0.17, 0.17); mpart(body, CYL, P[0], -0.34, 0.5, 0.05, 0.08, 0.28, 0.08, 0.04);
    return { g, body, x: { arm, orb } }; },
  rammer(P) { const g = new THREE.Group(), body = new THREE.Group(); g.add(body); const head = new THREE.Group(); head.position.set(0, 0.72, 0.62); body.add(head);
    mpart(body, SPH, P[0], 0, 0.62, -0.05, 0.5, 0.42, 0.7); mpart(body, SPH, P[1], 0, 0.46, 0.0, 0.34, 0.18, 0.5, 0.03); for (const sx of [-1, 1]) for (const sz of [-1, 1]) mpart(body, CYL, P[0], sx * 0.3, 0.2, sz * 0.42, 0.12, 0.4, 0.12, 0.04);
    mpart(head, SPH, P[0], 0, 0, 0, 0.3, 0.28, 0.3); for (const q of [-1, 1]) { const h = mpart(head, MOB_GEO.cone, P[1], q * 0.26, 0.14, 0.02, 0.08, 0.42, 0.08, 0.03); h.rotation.z = -q * 0.75; h.rotation.x = -0.35; } mgpart(head, SPH, mglow(P[2]), 0.12, 0.06, 0.26, 0.05, 0.05, 0.03); mgpart(head, SPH, mglow(P[2]), -0.12, 0.06, 0.26, 0.05, 0.05, 0.03); mpart(body, SPH, P[1], 0, 0.7, -0.74, 0.14, 0.14, 0.14, 0.03);
    return { g, body, x: { head } }; },
  scuttler(P) { const g = new THREE.Group(), body = new THREE.Group(); g.add(body); mpart(body, HEMI, P[0], 0, 0.22, 0, 0.36, 0.3, 0.42); mpart(body, SPH, P[1], 0, 0.2, 0.34, 0.18, 0.14, 0.16, 0.03); eyes(body, 0.3, 0.45, 0.09, 0.06, '#fff2b0', '#201000');
    for (let i = 0; i < 6; i++) { const q = i % 2 ? 1 : -1, z = ((i / 2) | 0) * 0.22 - 0.1; const l = mpart(body, CYL, P[1], q * 0.34, 0.1, z, 0.04, 0.3, 0.04, 0.02); l.rotation.z = q * 1.0; } mpart(body, SPH, P[2], 0, 0.36, -0.1, 0.1, 0.06, 0.12, 0); return { g, body, x: {} }; },
  mender(P) { const g = new THREE.Group(), body = new THREE.Group(); g.add(body); mpart(body, SPH, P[0], 0, 0.42, 0, 0.36, 0.38, 0.34); mpart(body, SPH, P[1], 0, 0.34, 0.2, 0.22, 0.2, 0.1, 0.03); eyes(body, 0.56, 0.28, 0.12, 0.09, '#ffffff', '#103010');
    for (let i = 0; i < 4; i++) { const a = i / 4 * TAU, lf = mpart(body, SPH, i % 2 ? P[0] : '#8af0a0', Math.cos(a) * 0.12, 0.86, Math.sin(a) * 0.12, 0.2, 0.05, 0.1, 0.03); lf.rotation.y = -a; lf.rotation.z = 0.5; } mpart(body, SPH, P[2], 0, 0.95, 0, 0.09, 0.09, 0.09, 0.02);
    for (const q of [-1, 1]) mpart(body, SPH, P[0], q * 0.3, 0.3, 0.1, 0.1, 0.16, 0.1, 0.03); const bulb = mglow('#9af0a0'); mgpart(body, SPH, bulb, 0.5, 1.0, 0.1, 0.11, 0.11, 0.11); return { g, body, x: { bulb } }; },
  weaver(P) { const g = new THREE.Group(), body = new THREE.Group(); g.add(body); const ring = new THREE.Group(); ring.position.y = 1.6; body.add(ring);
    mpart(body, MOB_GEO.cone, P[1], 0, 0.62, 0, 0.5, 1.2, 0.5); mpart(body, SPH, '#e8dcff', 0, 1.3, 0.04, 0.24, 0.26, 0.22); const ge = mglow(P[2]); for (const q of [-1, 0, 1]) mgpart(body, SPH, ge, q * 0.09, 1.34 + (q === 0 ? 0.07 : 0), 0.22, 0.04, 0.05, 0.03);
    for (let i = 0; i < 4; i++) { const a = i / 4 * TAU + 0.4, l = mpart(body, CYL, P[0], Math.cos(a) * 0.36, 0.34, Math.sin(a) * 0.36, 0.035, 0.7, 0.035, 0.02); l.rotation.z = -Math.cos(a) * 0.7; l.rotation.x = Math.sin(a) * 0.7; }
    const rm = mglow(P[2], 1.24); for (let i = 0; i < 3; i++) { const t = mgpart(ring, MOB_GEO.torus, rm, 0, i * 0.08, 0, 0.3 + i * 0.1, 0.3 + i * 0.1, 0.3 + i * 0.1); t.rotation.x = PI / 2; } return { g, body, x: { ring, ge } }; },
  fuse(P) { const g = new THREE.Group(), body = new THREE.Group(); g.add(body); mpart(body, SPH, P[0], 0, 0.3, 0, 0.3, 0.3, 0.3); eyes(body, 0.38, 0.22, 0.1, 0.07, '#fff6d0', '#201000'); mpart(body, CYL, P[1], 0, 0.62, 0, 0.04, 0.16, 0.04, 0.02); const tip = mglow(P[2], 1.86); mgpart(body, SPH, tip, 0, 0.74, 0, 0.07, 0.07, 0.07);
    for (const q of [-1, 1]) mpart(body, SPH, P[1], q * 0.14, 0.04, 0.04, 0.09, 0.06, 0.12, 0.02); return { g, body, x: { tip } }; },
  bulwark(P) { const g = new THREE.Group(), body = new THREE.Group(); g.add(body); const sh = new THREE.Group(); sh.position.set(0, 0.55, 0.56); body.add(sh);
    mpart(body, HEMI, P[0], 0, 0.28, -0.05, 0.6, 0.48, 0.6); mpart(body, CYL, P[2], 0, 0.26, -0.05, 0.62, 0.06, 0.62, 0.03); for (const q of [-1, 1]) { mpart(body, CYL, P[1], q * 0.18, 0.7, 0.28, 0.03, 0.2, 0.03, 0.02); mpart(body, SPH, '#fff', q * 0.18, 0.84, 0.28, 0.07, 0.07, 0.07, 0); mpart(body, SPH, '#101018', q * 0.18, 0.84, 0.34, 0.035, 0.04, 0.02, 0); mpart(body, SPH, P[0], q * 0.5, 0.25, 0.4, 0.14, 0.1, 0.2, 0.04); }
    for (let i = 0; i < 6; i++) { const q = i % 2 ? 1 : -1, z = ((i / 2) | 0) * 0.28 - 0.3; const l = mpart(body, CYL, P[2], q * 0.58, 0.1, z, 0.05, 0.3, 0.05, 0.02); l.rotation.z = q * 0.9; }
    const plate = mpart(sh, MOB_GEO.disc, P[1], 0, 0, 0, 0.5, 0.09, 0.42, 0.05); plate.rotation.x = PI / 2; const emb = mglow('#9fd8ff', 1.12); const em = mgpart(sh, MOB_GEO.disc, emb, 0, 0, 0.06, 0.28, 0.04, 0.22); em.rotation.x = PI / 2; return { g, body, x: { sh, emb } }; },
  wisp(P) { const g = new THREE.Group(), body = new THREE.Group(); g.add(body); const core = mglow(P[1], 1.05), flame = mglow(P[0], 1.24), rm = mglow(P[2], 0.99); const swirl = new THREE.Group(); body.add(swirl);
    mgpart(body, SPH, core, 0, 0.5, 0, 0.22, 0.26, 0.22); mgpart(body, SPH, flame, 0, 0.34, 0, 0.32, 0.4, 0.32); mgpart(body, MOB_GEO.cone, flame, 0, 0.05, 0, 0.22, 0.5, 0.22).rotation.x = PI; mgpart(body, SPH, flame, 0, 0.78, 0, 0.14, 0.16, 0.14);
    for (let i = 0; i < 2; i++) { const t = mgpart(swirl, MOB_GEO.torus, rm, 0, 0.45, 0, 0.5 + i * 0.12, 0.5 + i * 0.12, 0.5 + i * 0.12); t.rotation.x = PI / 2.4 + i * 0.5; t.rotation.y = i * 1.2; } for (const q of [-1, 1]) { mpart(body, SPH, '#102030', q * 0.1, 0.56, 0.17, 0.045, 0.06, 0.03, 0); } return { g, body, x: { swirl, flame, core } }; },
  mole(P) { const g = new THREE.Group(), body = new THREE.Group(); g.add(body); mpart(body, SPH, P[0], 0, 0.4, 0, 0.42, 0.38, 0.5); mpart(body, SPH, P[1], 0, 0.36, 0.28, 0.3, 0.26, 0.28, 0.04); mpart(body, MOB_GEO.cone, P[2], 0, 0.34, 0.6, 0.09, 0.2, 0.09, 0.02).rotation.x = PI / 2; mpart(body, SPH, '#101010', 0, 0.38, 0.72, 0.05, 0.05, 0.05, 0);
    for (const q of [-1, 1]) { const c = new THREE.Group(); c.position.set(q * 0.42, 0.3, 0.32); body.add(c); for (let i = 0; i < 3; i++) { const cl = mpart(c, MOB_GEO.cone, P[1], (i - 1) * 0.09, 0, 0.1, 0.05, 0.28, 0.05, 0.02); cl.rotation.x = PI / 2; } mpart(c, SPH, P[0], 0, 0, 0, 0.14, 0.12, 0.16, 0.03); mpart(body, SPH, '#ffffff', q * 0.14, 0.52, 0.36, 0.05, 0.06, 0.04, 0); mpart(body, SPH, '#101010', q * 0.14, 0.52, 0.4, 0.025, 0.03, 0.02, 0); }
    return { g, body, x: {} }; },
  puffer(P) { const g = new THREE.Group(), body = new THREE.Group(); g.add(body); const cap = new THREE.Group(); cap.position.y = 0.62; body.add(cap);
    mpart(body, CYL, P[1], 0, 0.32, 0, 0.14, 0.6, 0.14, 0.04); mpart(cap, HEMI, P[0], 0, 0, 0, 0.56, 0.5, 0.56, 0.06); for (let i = 0; i < 7; i++) { const a = i / 7 * TAU, rr = i === 0 ? 0 : 0.34, y = i === 0 ? 0.48 : 0.26; mpart(cap, SPH, P[2], Math.cos(a) * rr, y, Math.sin(a) * rr, 0.09, 0.05, 0.09, 0); } eyes(body, 0.62, 0.3, 0.13, 0.08, '#fff6c0', '#302000');
    const pores = mglow('#fff2a0', 0.99); for (let i = 0; i < 4; i++) { const a = i / 4 * TAU; mgpart(cap, SPH, pores, Math.cos(a) * 0.3, -0.04, Math.sin(a) * 0.3, 0.05, 0.03, 0.05); } for (let i = 0; i < 3; i++) { const a = i / 3 * TAU; mpart(body, SPH, P[1], Math.cos(a) * 0.2, 0.05, Math.sin(a) * 0.2, 0.18, 0.06, 0.1, 0.03).rotation.y = -a; } return { g, body, x: { cap, pores } }; },
  warden(P) { const g = new THREE.Group(), body = new THREE.Group(); g.add(body); const head = new THREE.Group(); head.position.set(0, 1.1, 0.34); body.add(head); const armL = new THREE.Group(), armR = new THREE.Group(); armL.position.set(-0.7, 0.95, 0.05); armR.position.set(0.7, 0.95, 0.05); body.add(armL, armR);
    mpart(body, SPH, P[0], 0, 0.7, 0, 0.68, 0.58, 0.58); mpart(body, SPH, P[1], 0, 0.55, 0.28, 0.4, 0.3, 0.16, 0.04); for (const q of [-1, 1]) { mpart(body, CYL, P[0], q * 0.28, 0.2, 0, 0.18, 0.46, 0.2, 0.05); mpart(body, SPH, P[1], q * 0.8, 1.15, 0, 0.26, 0.2, 0.28, 0.05); for (let i = 0; i < 3; i++) { const sp = mpart(body, MOB_GEO.cone, P[1], q * (0.78 + i * 0.05), 1.34 + i * 0.12, -0.05 - i * 0.06, 0.09, 0.34, 0.09, 0.03); sp.rotation.z = -q * 0.5; } }
    mpart(head, SPH, P[0], 0, 0, 0, 0.36, 0.3, 0.36); mpart(head, SPH, P[1], 0, -0.16, 0.2, 0.3, 0.12, 0.2, 0.03); for (const q of [-1, 1]) { mpart(head, MOB_GEO.cone, '#fff4d0', q * 0.14, -0.2, 0.34, 0.05, 0.22, 0.05, 0.02).rotation.x = -PI * 0.7; mgpart(head, SPH, mglow('#ff5a2a'), q * 0.14, 0.06, 0.3, 0.07, 0.06, 0.04); }
    for (const a of [armL, armR]) { mpart(a, CYL, P[0], 0, -0.28, 0, 0.14, 0.54, 0.14, 0.04); mpart(a, SPH, P[1], 0, -0.6, 0.02, 0.24, 0.22, 0.24, 0.05); } for (let i = 0; i < 5; i++) { const sp = mpart(body, MOB_GEO.cone, P[2], (i - 2) * 0.24, 1.12, -0.38, 0.08, 0.3, 0.08, 0.03); sp.rotation.x = -PI * 0.65; } return { g, body, x: { head, armL, armR } }; },
  thornback(P) { const g = new THREE.Group(), body = new THREE.Group(); g.add(body); const head = new THREE.Group(); head.position.set(0, 0.95, 0.95); body.add(head);
    mpart(body, SPH, P[0], 0, 0.95, 0, 0.95, 0.72, 1.15); mpart(body, SPH, P[1], 0, 0.62, 0.1, 0.7, 0.3, 0.9, 0.04); for (const sx of [-1, 1]) for (const sz of [-1, 0, 1]) { mpart(body, CYL, P[0], sx * 0.62, 0.3, sz * 0.7, 0.22, 0.6, 0.22, 0.05); }
    const glow = mglow(P[2], 1.36); for (let r = 0; r < 3; r++) for (let c = 0; c < 5; c++) { const a = (c - 2) * 0.34, y = 1.45 + Math.cos(a) * 0.22 - r * 0.0, z = -0.5 + r * 0.55, th = mpart(body, MOB_GEO.cone, P[1], Math.sin(a) * 0.82, y, z, 0.1, 0.5 + (c % 2) * 0.12, 0.1, 0.03); th.rotation.z = -a * 0.9; if (c === 2) mgpart(body, SPH, glow, Math.sin(a) * 0.82, y + 0.34, z, 0.06, 0.06, 0.06); }
    mpart(head, SPH, P[0], 0, 0, 0, 0.5, 0.42, 0.5); mpart(head, SPH, P[1], 0, -0.2, 0.26, 0.4, 0.16, 0.3, 0.03); for (const q of [-1, 1]) { const hn = mpart(head, MOB_GEO.cone, '#f4e4c0', q * 0.42, 0.2, 0.1, 0.1, 0.62, 0.1, 0.03); hn.rotation.z = -q * 0.9; hn.rotation.x = -0.4; mgpart(head, SPH, mglow('#ff7a2a'), q * 0.2, 0.08, 0.44, 0.08, 0.07, 0.04); } mgpart(body, MOB_GEO.box, glow, 0, 0.75, -1.12, 0.3, 0.06, 0.04);
    return { g, body, x: { head, glow } }; },
  stormcaller(P) { const g = new THREE.Group(), body = new THREE.Group(); g.add(body); const orbs = new THREE.Group(); orbs.position.y = 1.1; body.add(orbs); const ge = mglow(P[2], 1.24);
    mpart(body, MOB_GEO.cone, P[0], 0, 0.7, 0, 0.62, 1.5, 0.62, 0.05); mpart(body, SPH, P[1], 0, 1.58, 0.02, 0.28, 0.3, 0.26, 0.04); mpart(body, MOB_GEO.cone, P[0], 0, 1.95, 0, 0.3, 0.5, 0.3, 0.04); for (const q of [-1, 1]) { mgpart(body, SPH, ge, q * 0.1, 1.6, 0.24, 0.06, 0.08, 0.04); mpart(body, SPH, P[1], q * 0.46, 0.9, 0.2, 0.12, 0.16, 0.12, 0.03); }
    for (let i = 0; i < 4; i++) { const a = i / 4 * TAU; mgpart(orbs, SPH, ge, Math.cos(a) * 0.9, 0, Math.sin(a) * 0.9, 0.14, 0.14, 0.14); } for (let i = 0; i < 5; i++) { const a = (i - 2) * 0.4; const sp = mgpart(body, MOB_GEO.cone, ge, Math.sin(a) * 0.3, 2.28 + Math.cos(a) * 0.1, 0, 0.05, 0.3, 0.05); sp.rotation.z = -a; } return { g, body, x: { orbs, ge } }; },
  prism(P) { const g = new THREE.Group(), body = new THREE.Group(); g.add(body); const shards = new THREE.Group(); shards.position.y = 1.9; body.add(shards); const core = mglow(P[2], 1.49), cry = mglow('#d8b8ff', 0.93);
    mpart(body, MOB_GEO.box, P[0], 0, 1.0, 0, 1.0, 1.15, 0.8, 0.05); mpart(body, MOB_GEO.box, P[1], 0, 0.3, 0, 0.8, 0.6, 0.6, 0.05); mgpart(body, MOB_GEO.box, core, 0, 1.05, 0.38, 0.34, 0.34, 0.12); for (const q of [-1, 1]) { mpart(body, MOB_GEO.box, P[0], q * 0.85, 1.0, 0.1, 0.34, 0.9, 0.34, 0.05); mpart(body, MOB_GEO.box, P[1], q * 0.85, 0.45, 0.14, 0.5, 0.4, 0.5, 0.05); mgpart(body, SPH, core, q * 0.18, 1.5, 0.38, 0.07, 0.07, 0.05); mpart(body, MOB_GEO.box, P[1], q * 0.3, 0.1, 0, 0.3, 0.4, 0.3, 0.04); }
    mpart(body, MOB_GEO.box, P[0], 0, 1.8, 0.04, 0.4, 0.34, 0.36, 0.04); for (let i = 0; i < 5; i++) { const a = i / 5 * TAU; const c = mgpart(shards, MOB_GEO.oct, cry, Math.cos(a) * 0.85, Math.sin(i * 1.7) * 0.15, Math.sin(a) * 0.85, 0.16, 0.34, 0.16); c.rotation.z = 0.3 * Math.sin(i); } return { g, body, x: { shards, core } }; },
};
// ---- instanced swarm types: bake a built model into one BufferGeometry (+ one outline geometry) --------------------------------------------------------------------------------------------------
function mobBakeModel(m) { // flatten every part (and outline hull) of the model into world-of-root geometry
  m.g.updateMatrixWorld(true); const inv = new THREE.Matrix4().copy(m.g.matrixWorld).invert(), body = [], outl = []; const tmp = new THREE.Matrix4();
  m.g.traverse(o => { const ud = o.userData; if (!ud) return; if (ud.vrp) for (const p of ud.vrp) { p.updateWorldMatrix(true, false); tmp.multiplyMatrices(inv, p.matrixWorld); body.push({ geo: p.geometry, mat: tmp.clone(), col: p.material.color }); } if (ud.vro) for (const p of ud.vro) { p.updateWorldMatrix(true, false); tmp.multiplyMatrices(inv, p.matrixWorld); outl.push({ geo: p.geometry, mat: tmp.clone() }); } });
  return { geo: vrBake(body, true), outGeo: vrBake(outl, false) };
}
const MOBI = {}; // id -> { mesh, out, n }
function mobiGet(id) {
  if (MOBI[id]) return MOBI[id]; const def = MOB_DEFS[id], m = MOB_SHAPES[def.shape](def.pal), b = mobBakeModel(m), cap = 40;
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x100e0c }), mesh = new THREE.InstancedMesh(b.geo, mat, cap), out = new THREE.InstancedMesh(b.outGeo, outlineMat, cap);
  for (const x of [mesh, out]) { x.frustumCulled = false; x.count = 0; x.visible = false; scene.add(x); } mesh.castShadow = !VR.presenting; mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3); out.renderOrder = -1;
  return MOBI[id] = { mesh, out, n: 0, cap };
}
const _mI = new THREE.Matrix4(), _mI2 = new THREE.Matrix4(), _mC = new THREE.Color();
function mobiUpdate() { // once per rendered frame: every alive instanced mob of each type -> instance slots 0..n-1
  for (const id in MOBI) MOBI[id].n = 0;
  for (const e of ENEMIES) {
    if (!e.mob || !e.mob.def.inst || !e.alive) continue; const I = MOBI[e.type]; if (!I || I.n >= I.cap) continue; if (!e.mesh.visible || e.mob.hidden) continue;
    e.mesh.updateMatrixWorld(true); _mI.copy(e.mesh.matrixWorld); e.body.updateMatrix(); _mI2.copy(e.body.matrix); _mI.multiply(_mI2); const i = I.n++; I.mesh.setMatrixAt(i, _mI); I.out.setMatrixAt(i, _mI); const f = e.mob.flash || 0; _mC.setRGB(1 + f * 2.2, 1 + f * 0.9, 1 + f * 0.5); I.mesh.setColorAt(i, _mC);
  }
  for (const id in MOBI) { const I = MOBI[id], on = I.n > 0; I.mesh.count = I.out.count = I.n; I.mesh.visible = on; I.out.visible = on && !(VR.presenting && !VR.mobOutline); if (on) { I.mesh.instanceMatrix.needsUpdate = I.out.instanceMatrix.needsUpdate = true; I.mesh.instanceColor.needsUpdate = true; } }
}
// ---- animation: a few lines per shape, driven by the FSM state (the wind-up is a visible wind-up) ---------------------------------------------------------------------------------------------------
const mk01 = (a, b, x) => Math.max(0, Math.min(1, (x - a) / (b - a)));
function mobAnimate(e, dt, t) {
  const m = e.mob, d = m.def, X = e.mx, b = e.body, st = m.st, wind = st === 'wind' ? mk01(0, m.atkD ? m.atkD.wind : 1, m.windT) : 0, ph = e.ph; if (!X && !d.inst) return;
  if (!d.inst && e.mesh) { b.visible = !m.hidden; }
  if (e.flinch > 0) return; // the rpg layer owns body.scale.y during a flinch
  const sp = hyp2(m.vx, m.vz), walk = Math.sin(t * 9 + ph) * Math.min(1, sp / 2); let sy = 1, sx = 1, by = 0, rz = 0, rx = 0;
  if (st === 'wind') { const k = Math.sin(wind * PI * 0.5); sy = 1 - 0.2 * k; sx = 1 + 0.12 * k; if (d.fam === 'artillery') { sy = 1 + 0.35 * k; sx = 1 + 0.3 * k; } if (d.fam === 'bomber') { sy = 1 + 0.25 * k; sx = 1 + 0.25 * k; } by = 0.02 * Math.sin(t * 40) * k; }
  else if (st === 'stun') { rz = Math.sin(t * 14) * 0.18 + 0.4; sy = 0.86; } else if (st === 'phase') { sy = 1 + 0.08 * Math.sin(t * 24); sx = sy; } else if (st === 'exec') { sy = 1.1; sx = 0.94; } else { by = Math.abs(walk) * 0.05 * (d.fly ? 0.3 : 1); rz = walk * 0.05; }
  if (d.fly && !d.inst) by += 0.06 * Math.sin(t * 3 + ph);
  b.scale.set(sx, sy, sx); b.position.y = by; b.rotation.z = rz; b.rotation.x = rx;
  if (d.inst) { if (d.fam === 'bomber') m.flash = st === 'wind' ? (Math.sin(t * (14 + wind * 24)) > 0 ? 1 : 0) : 0; return; }
  if (!X) return;
  switch (d.shape) {
    case 'slinger': X.arm.rotation.x = st === 'wind' ? -2.4 * wind : st === 'exec' ? 0.6 : -0.3 + walk * 0.4; X.orb.color.setRGB((2.4 + wind * 2) * 0.62, (1.6 + wind) * 0.62, (0.6 + wind * 0.5) * 0.62); break;
    case 'rammer': X.head.rotation.x = st === 'wind' ? 0.5 * wind : st === 'stun' ? 0.7 : st === 'exec' ? 0.35 : walk * 0.05; X.head.position.y = 0.72 - (st === 'wind' ? 0.15 * wind : 0); if (st === 'wind') b.position.z = -0.1 * wind; break;
    case 'weaver': X.ring.rotation.y += dt * (st === 'wind' ? 10 : 1.5); X.ring.position.y = 1.6 + Math.sin(t * 2 + ph) * 0.08 + (st === 'wind' ? wind * 0.3 : 0); X.ring.scale.setScalar(1 + (st === 'wind' ? wind * 0.4 : 0)); break;
    case 'bulwark': X.sh.rotation.y = st === 'wind' ? Math.sin(wind * 6) * 0.3 : 0; X.sh.position.z = 0.56 + (st === 'wind' ? -0.1 * wind : st === 'exec' ? 0.25 : 0); X.emb.color.setRGB((1.2 + wind * 3) * 0.62, (2 + wind * 2) * 0.62, (3 + wind) * 0.62); b.rotation.z = st === 'stun' ? 0.5 : rz; break;
    case 'wisp': X.swirl.rotation.y += dt * (st === 'wind' ? 14 : 3); X.swirl.scale.setScalar(st === 'wind' ? 1 - 0.5 * wind : 1); X.flame.color.setRGB((0.35 + wind * 1.2) * 0.62, (1.3 + wind * 0.8) * 0.62, (2.0) * 0.62); break;
    case 'puffer': X.cap.scale.set(1 + (st === 'wind' ? 0.3 * wind : 0) + 0.04 * Math.sin(t * 3 + ph), 1 + (st === 'wind' ? 0.45 * wind : 0), 1 + (st === 'wind' ? 0.3 * wind : 0)); break;
    case 'mender': X.bulb.color.setRGB((1.2 + wind * 2.5) * 0.62, (2.4 + wind) * 0.62, (1.2 + wind) * 0.62); break;
    case 'warden': X.armL.rotation.x = st === 'wind' ? -2.5 * wind : st === 'exec' ? 0.4 : walk * 0.6; X.armR.rotation.x = st === 'wind' ? -2.5 * wind : st === 'exec' ? 0.4 : -walk * 0.6; X.head.rotation.x = st === 'wind' ? -0.3 * wind : 0; break;
    case 'thornback': X.head.rotation.x = st === 'wind' ? 0.4 * wind : st === 'stun' ? 0.6 : 0; X.glow.color.setRGB((2.2 + wind * 2) * 0.62, (0.8 + wind * 0.4) * 0.62, (0.2) * 0.62); break;
    case 'stormcaller': X.orbs.rotation.y += dt * (st === 'wind' ? 8 : 2); X.orbs.position.y = 1.1 + (st === 'wind' ? wind * 0.4 : 0); break;
    case 'prism': X.shards.rotation.y += dt * (st === 'wind' ? 7 : 1.2); X.shards.position.y = 1.9 + Math.sin(t * 2 + ph) * 0.1; X.core.color.setRGB((2.4 + wind * 2) * 0.62, (1.0 + wind) * 0.62, (2.4 + wind) * 0.62); break;
  }
}

// ---- VR draw-call diet (LOD): a model whose limbs are merged per group while presenting (vrp / vro) also carries ONE whole-body baked copy (rest pose) + one outline. Far models show only that:
//      2 drawables instead of (limb groups x 2). Used by the mobs (everything past the 7 nearest, never a guardian) and by the town people (everyone farther than ~7 m). Flat play never sees it.
// the merged bake needs every geometry indexed or none: the mob shapes mix indexed primitives (box, cone, cylinder) with non-indexed ones (octahedron, icosahedron), so mixed lists are expanded first
{ const _vbk = vrBake; vrBake = function (list, withColor) { let ix = 0, nx = 0; for (const it of list) { if (it.geo.index) ix++; else nx++; } if (ix && nx) for (const it of list) if (it.geo.index) it.geo = it.geo.toNonIndexed(); return _vbk(list, withColor); }; }
// merged limb meshes are baked in group space, so three's own frustum culling is exact: with it ON everything behind / beside the head (hero, NPC twin, every enemy, chests, people) costs nothing in either eye
{ const _vbm = vrBuildMerged; vrBuildMerged = function (g) { _vbm(g); const u = g.userData; if (u.vrM) u.vrM.frustumCulled = true; if (u.vrO) u.vrO.frustumCulled = true; }; }
function vlInfo(root) { // the limb groups of a model (cheap, once); false = nothing to merge (instanced swarm mobs)
  const ud = root.userData; if (ud.vlB !== undefined) return ud.vlB; const gs = []; root.traverse(o => { const u = o.userData; if (u && u.vrp && u.vrp.length) gs.push(o); });
  return (ud.vlB = gs.length ? { body: null, out: null, gs, key: -1, cul: false } : false);
}
function vlBake(root, shadow) { // the one-body copy, built the first time a model needs it (town people: right away, in their rest pose; enemies: in VR only, so flat play pays nothing)
  const B = vlInfo(root); if (!B || B.body) return B || null; root.updateMatrixWorld(true); const inv = new THREE.Matrix4().copy(root.matrixWorld).invert(), l1 = [], l2 = [];
  for (const o of B.gs) { const u = o.userData; for (const m of u.vrp) { m.updateWorldMatrix(true, false); l1.push({ geo: m.geometry, mat: new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld), col: m.material.color }); } if (u.vro) for (const m of u.vro) { m.updateWorldMatrix(true, false); l2.push({ geo: m.geometry, mat: new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld) }); } }
  if (!vrLitMat) vrLitMat = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x100e0c });
  const body = new THREE.Mesh(vrBake(l1, true), vrLitMat); body.castShadow = !!shadow; body.frustumCulled = false; body.visible = false; root.add(body); B.body = body;
  if (l2.length) { const out = new THREE.Mesh(vrBake(l2, false), outlineMat); out.renderOrder = -1; out.frustumCulled = false; out.visible = false; root.add(out); B.out = out; }
  B.key = -1; return B;
}
function vlCull(B) { // the merged limb meshes are baked in group space, so three's own frustum culling is exact: models behind the head or off to the side cost nothing in either eye
  let all = true; for (const o of B.gs) { const u = o.userData; if (u.vrM) { u.vrM.frustumCulled = true; if (u.vrO) u.vrO.frustumCulled = true; } else all = false; } if (B.body) { B.body.frustumCulled = true; if (B.out) B.out.frustumCulled = true; } if (all && B.body) B.cul = true;
}
function vlApply(root, mode, keepOut) { // mode 0 = animated limbs + outlines, 1 = animated limbs, no outlines, 2 = one baked body (+ its outline when keepOut). Idempotent, allocation-free; flat play never reaches the VR branch
  const B = root.userData.vlB === undefined ? vlInfo(root) : root.userData.vlB; if (!B) return; const merged = VR.merge; if (merged && mode === 2 && !B.body) vlBake(root, false); if (merged && !B.cul) vlCull(B);
  const key = merged ? mode : -1; if (key === B.key) return; B.key = key; const baked = key === 2; if (B.body) { B.body.visible = baked; if (B.out) B.out.visible = baked && keepOut === true; }
  if (key >= 0) for (const o of B.gs) { const u = o.userData; if (u.vrM) u.vrM.visible = !baked; if (u.vrO) u.vrO.visible = key === 0; }
}
// </mob-models>

