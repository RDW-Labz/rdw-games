// ---- NPC twin ---------------------------------------------------------------------------------------------------------------
const _npcPose = { lx: 0, rx: 0, la: 0, ra: 0, lean: 0, side: 0, pitch: 0, hx: 0, hy: 0, bob: 0, roll: 0 };
const NPC = { x: 0, y: 0, z: 0, active: false, line: 0, lines: [], talkT: 0, near: false, ph: 0 };
function updateNPC(dt, t) {
  twin.root.visible = NPC.active; if (!NPC.active) return;
  const dx = P.x - NPC.x, dz = P.z - NPC.z, d = Math.hypot(dx, dz); NPC.near = d < 3.6 && G.state === 'play'; if (NPC.near && NPC.talkT <= 0 && !PROMPT) PROMPT = 'Press E to talk';
  const want = d < 8 ? Math.atan2(dx, dz) : (NPC.base || 0); NPC.yaw = (NPC.yaw === undefined ? want : NPC.yaw) + angDiff(NPC.yaw === undefined ? want : NPC.yaw, want) * Math.min(1, dt * 5);
  const f = floorAt(NPC.x, NPC.z, NPC.y + 1.5); if (f > -1e8) NPC.y = f;
  twin.root.position.set(NPC.x, NPC.y, NPC.z); twin.root.rotation.y = NPC.yaw; NPC.ph += dt;
  const talking = NPC.talkT > 0, s = Math.sin(NPC.ph * 2), tg = _npcPose; tg.lx = tg.rx = tg.lean = tg.side = tg.pitch = tg.roll = 0; tg.la = s * 0.05; tg.ra = -s * 0.05; tg.hx = 0; tg.hy = Math.sin(NPC.ph * 0.8) * 0.2; tg.bob = s * 0.01;
  if (NPC.near && !talking) { tg.ra = -2.7 + Math.sin(NPC.ph * 9) * 0.45; tg.side = 0.3; } if (talking) { tg.la = -0.9 + Math.sin(NPC.ph * 7) * 0.25; tg.hx = 0.1 + Math.sin(NPC.ph * 8) * 0.1; }
  poseTo(twin, tg, dt, 8); applyPose(twin, dt); twin.root.scale.setScalar(twin.S * 0.95);
  if (talking) { NPC.talkT -= dt; if (NPC.talkT <= 0 || d > 6) { $('talk').classList.remove('on'); NPC.talkT = 0; P.talk = 0; } }
  if (NPC.near && edge.e) { edge.e = false; NPC.line = (NPC.line + 1) % NPC.lines.length; showTalk('TWIN', NPC.lines[NPC.line]); sfx('talk'); }
}
function showTalk(who, txt) { G.talkWho = who; G.talkMsg = txt; G.talkSeq = (G.talkSeq | 0) + 1; $('talkWho').textContent = who; $('talkTxt').textContent = txt; $('talk').classList.add('on'); NPC.talkT = 6; P.talk = 1; }

