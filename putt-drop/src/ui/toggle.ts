import Phaser from "phaser";
import { DEPTH } from "../game/theme.js";
import { bindTap, type InteractiveGo } from "../game/theme.js";
import { registerControlCenter } from "./controls.js";
import { bodyTextStyleUi } from "./fonts.js";
import { reducedMotion } from "./motion.js";
import { TOKENS, cssColor } from "./tokens.js";

export function toggleSwitch(
  scene: Phaser.Scene,
  x: number,
  y: number,
  on: boolean,
  onChange: (v: boolean) => void,
  id?: string,
  parent?: Phaser.GameObjects.Container
): Phaser.GameObjects.Container {
  const { trackW, trackH, knob: knobD, travel } = TOKENS.component.toggle;
  const knobR = knobD / 2;
  const track = scene.add.graphics();
  const knobShadow = scene.add.circle(0, 1.5, knobR + 0.5, TOKENS.color.shadow, 0.18);
  const knobFace = scene.add.circle(0, 0, knobR, TOKENS.color.raisedBottom, 1);
  knobFace.setStrokeStyle(TOKENS.stroke.border, TOKENS.color.border, 1);
  const check = scene.add.graphics();
  check.lineStyle(2, TOKENS.color.success, 1);
  check.beginPath();
  check.moveTo(-5, 0);
  check.lineTo(-1.5, 3.5);
  check.lineTo(5, -3.5);
  check.strokePath();
  const knob = scene.add.container(0, 0, [knobShadow, knobFace, check]);

  const drawTrack = (enabled: boolean) => {
    track.clear();
    track.fillStyle(enabled ? TOKENS.color.success : TOKENS.color.disabledFill, enabled ? 1 : 1);
    track.fillRoundedRect(-trackW / 2, -trackH / 2, trackW, trackH, trackH / 2);
    track.lineStyle(TOKENS.stroke.border, TOKENS.color.controlEdge, 1);
    track.strokeRoundedRect(-trackW / 2 + 0.5, -trackH / 2 + 0.5, trackW - 1, trackH - 1, trackH / 2);
  };

  let state = on;
  const knobX = (enabled: boolean) => (enabled ? travel / 2 : -travel / 2);
  drawTrack(state);
  knob.x = knobX(state);
  check.setVisible(state);

  // State word sits left of the track so the row never grows past the track's right edge.
  const label = scene.add
    .text(-trackW / 2 - TOKENS.space.sm, 0, state ? "On" : "Off", bodyTextStyleUi(TOKENS.type.caption.size, TOKENS.type.caption.weight, cssColor("text")))
    .setOrigin(1, 0.5);

  const rowW = trackW + 72;
  const rowH = TOKENS.component.toggle.rowH;
  const hit = scene.add
    .rectangle(0, 0, rowW, rowH, 0x000000, 0.001)
    .setInteractive({ useHandCursor: true });
  const c = scene.add.container(x, y, [track, knob, label, hit]);
  c.setDepth(parent ? TOKENS.depth.sheetContent : DEPTH.hud + 2);
  if (parent) parent.add(c);
  if (id) registerControlCenter(id, scene.scene.key, x, y, rowW, rowH, c, "toggle", hit);

  hit.on("pointerdown", () => track.setAlpha(0.85));
  hit.on("pointerup", () => track.setAlpha(1));
  hit.on("pointerout", () => track.setAlpha(1));
  bindTap(hit as InteractiveGo, () => {
    state = !state;
    label.setText(state ? "On" : "Off");
    drawTrack(state);
    check.setVisible(state);
    const d = reducedMotion() ? TOKENS.motion.duration.instant : TOKENS.motion.duration.quick;
    scene.tweens.add({
      targets: knob,
      x: knobX(state),
      duration: d,
      ease: TOKENS.motion.ease.release,
    });
    onChange(state);
  });

  return c;
}
