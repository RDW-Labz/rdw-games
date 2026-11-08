import Phaser from "phaser";
import { DEPTH } from "../game/theme.js";
import { bodyTextStyleUi } from "./fonts.js";
import { faceImage, lockBadgeTexture } from "./textures.js";
import { TOKENS, cssColor } from "./tokens.js";

/** Draw a 14px padlock centered on (0,0) in text ink. Static geometry, drawn once. */
function drawLock(g: Phaser.GameObjects.Graphics, size: number): void {
  const ink = TOKENS.color.text;
  const bodyW = size * 0.78;
  const bodyH = size * 0.56;
  const bodyTop = size / 2 - bodyH;
  g.lineStyle(2, ink, 1);
  g.beginPath();
  g.arc(0, bodyTop, bodyW * 0.32, Math.PI, 0, false);
  g.strokePath();
  g.lineBetween(-bodyW * 0.32, bodyTop, -bodyW * 0.32, bodyTop + 1);
  g.lineBetween(bodyW * 0.32, bodyTop, bodyW * 0.32, bodyTop + 1);
  g.fillStyle(ink, 1);
  g.fillRoundedRect(-bodyW / 2, bodyTop, bodyW, bodyH, 2);
}

/** Inert "Full game" badge centered on (x, y): raised pill, 14px lock, caption. */
export function lockBadge(scene: Phaser.Scene, x: number, y: number): Phaser.GameObjects.Container {
  const { h, padX, icon, gap } = TOKENS.component.lockBadge;
  const label = scene.add
    .text(0, 0, "Full game", bodyTextStyleUi(TOKENS.type.caption.size, TOKENS.type.caption.weight, cssColor("text")))
    .setOrigin(0, 0);
  const w = Math.ceil((padX + icon + gap + label.width + padX + 2) / 2) * 2;
  const face = faceImage(scene, lockBadgeTexture(scene, w), w, h);
  const lock = scene.add.graphics();
  drawLock(lock, icon);
  lock.setPosition(-w / 2 + padX + icon / 2, 0);
  label.setPosition(Math.round(-w / 2 + padX + icon + gap), -Math.round(label.height / 2));
  const c = scene.add.container(x, y, [face, lock, label]);
  c.setSize(w, h);
  c.setDepth(DEPTH.hud);
  return c;
}
