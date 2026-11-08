import Phaser from "phaser";
import { DEPTH } from "../game/theme.js";
import { ensureUiTextures } from "./textures.js";
import { TOKENS } from "./tokens.js";
import { appearFx } from "./motion.js";
import { starRowWidth } from "./geometry.js";

export { starRowWidth } from "./geometry.js";

/** Inert row of 3 stars centered on (x, y). Earned stars pop in; empty stars are static. */
export function starRow(
  scene: Phaser.Scene,
  x: number,
  y: number,
  earned: number,
  variant: "small" | "result" = "small"
): Phaser.GameObjects.Container {
  ensureUiTextures(scene);
  const { size, gap } = TOKENS.component.starRow[variant];
  const left = -starRowWidth(variant) / 2 + size / 2;
  const parts: Phaser.GameObjects.Image[] = [];
  for (let i = 0; i < 3; i++) {
    const key = i < earned ? "ui-star-filled" : "ui-star-empty";
    parts.push(scene.add.image(left + i * (size + gap), 0, key).setDisplaySize(size, size));
  }
  const c = scene.add.container(x, y, parts);
  c.setSize(starRowWidth(variant), size);
  c.setDepth(DEPTH.hud);
  if (earned > 0) appearFx(scene, parts.slice(0, earned), { card: true });
  return c;
}
