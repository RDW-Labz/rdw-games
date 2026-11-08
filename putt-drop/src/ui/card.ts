import Phaser from "phaser";
import { DEPTH } from "../game/theme.js";
import { bodyTextStyleUi } from "./fonts.js";
import { appearFx } from "./motion.js";
import { bakePanelTexture, faceImage } from "./textures.js";
import { TOKENS, cssColor } from "./tokens.js";

export function infoCard(
  scene: Phaser.Scene,
  x: number,
  y: number,
  title: string,
  body?: string,
  width: number = TOKENS.component.card.w
): Phaser.GameObjects.Container {
  const w = width;
  const minH = TOKENS.component.card.minH;
  const key = bakePanelTexture(scene, w, minH);
  const face = faceImage(scene, key, w, minH);
  const titleT = scene.add
    .text(-w / 2 + TOKENS.component.card.pad, -minH / 2 + 24, title, bodyTextStyleUi(TOKENS.type.body.size, TOKENS.type.body.weight, cssColor("text")))
    .setOrigin(0, 0.5);
  const parts: Phaser.GameObjects.GameObject[] = [face, titleT];
  if (body) {
    parts.push(
      scene.add
        .text(-w / 2 + TOKENS.component.card.pad, 0, body, bodyTextStyleUi(TOKENS.type.caption.size, TOKENS.type.caption.weight, cssColor("textMuted")))
        .setOrigin(0, 0.5)
    );
  }
  const c = scene.add.container(x, y, parts);
  c.setSize(w, minH);
  c.setDepth(DEPTH.hud);
  appearFx(scene, [face], { card: true });
  return c;
}
