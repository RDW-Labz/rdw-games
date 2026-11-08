import Phaser from "phaser";
import { TOKENS } from "../../ui/tokens.js";
import type { AmbientItem } from "./clouds.js";

/** lightShift: 8000 ms full cycle, upper-right warm patch alpha 0.06 -> 0.12 -> 0.06; reduced = 0.08. */
export function addLightShift(
  scene: Phaser.Scene,
  parent: Phaser.GameObjects.Container
): AmbientItem {
  const patch = scene.add.ellipse(300, 80, 180, 140, TOKENS.color.bgLight, 1).setAlpha(0.08);
  parent.add(patch);
  return {
    target: patch,
    rest: { x: patch.x, y: patch.y, angle: 0, alpha: 0.08 },
    start: (sc) =>
      sc.tweens.add({
        targets: patch,
        alpha: { from: 0.06, to: 0.12 },
        duration: 4000,
        yoyo: true,
        repeat: -1,
        ease: TOKENS.motion.ease.ambient,
      }),
  };
}
