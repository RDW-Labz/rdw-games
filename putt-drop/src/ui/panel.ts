import Phaser from "phaser";
import { DEPTH } from "../game/theme.js";
import { bakePanelTexture, faceImage, type PanelVariant } from "./textures.js";

/** Baked card/sheet panel (gradient, 1px border, stacked shadow) centered on (x, y). */
export function panelImage(
  scene: Phaser.Scene,
  x: number,
  y: number,
  w: number,
  h: number,
  depth: number = DEPTH.hud,
  variant: PanelVariant = "card"
): Phaser.GameObjects.Container {
  const img = faceImage(scene, bakePanelTexture(scene, w, h, variant), w, h);
  const c = scene.add.container(x, y, [img]);
  c.setSize(w, h);
  c.setDepth(depth);
  return c;
}
