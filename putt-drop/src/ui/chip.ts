import Phaser from "phaser";
import { DEPTH } from "../game/theme.js";
import { bodyTextStyleUi } from "./fonts.js";
import { chipTexture, faceImage } from "./textures.js";
import { TOKENS, cssColor } from "./tokens.js";

/**
 * Read-only chip (par, strokes): H28 pill, caption text, surface gradient, 1px border, shadow.small.
 * Width is measured from the label and rounded to an even number so the face bake is reused.
 * `_legacyFill` is accepted for older call sites and ignored: the border is always the border token.
 */
export function chip(
  scene: Phaser.Scene,
  x: number,
  y: number,
  label: string,
  _legacyFill?: number
): Phaser.GameObjects.Container {
  void _legacyFill;
  const { h, padX, minW } = TOKENS.component.chip;
  // Origin 0.5 (not pixel-snapped) because callers update the label text in place.
  const text = scene.add
    .text(0, 0, label, bodyTextStyleUi(TOKENS.type.caption.size, TOKENS.type.caption.weight, cssColor("text")))
    .setOrigin(0.5);
  const w = Math.max(minW, Math.ceil((text.width + padX * 2) / 2) * 2);
  const face = faceImage(scene, chipTexture(scene, w), w, h);
  const c = scene.add.container(x, y, [face, text]);
  c.setSize(w, h);
  c.setDepth(DEPTH.hud);
  return c;
}
