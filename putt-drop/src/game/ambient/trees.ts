import Phaser from "phaser";
import { TOKENS } from "../../ui/tokens.js";
import type { AmbientItem } from "./clouds.js";

/** treeSway: 6000 ms full cycle, -1.5 deg -> +1.5 deg, pivot at the trunk base. Max 3 trees. */
export function addTreeSwaySprites(
  scene: Phaser.Scene,
  parent: Phaser.GameObjects.Container,
  positions: { x: number; y: number; scale?: number }[]
): AmbientItem[] {
  return positions.map((p) => {
    // Children are offset upward so the container origin (rotation pivot) is the trunk base.
    const trunk = scene.add.rectangle(0, -11, 6, 22, TOKENS.color.trunk);
    const canopy = scene.add.circle(0, -29, 18, TOKENS.color.tree);
    const highlight = scene.add.circle(-6, -33, 10, TOKENS.color.treeLight, 0.85);
    const tree = scene.add.container(p.x, p.y + 19, [trunk, canopy, highlight]);
    tree.setScale(p.scale ?? 1);
    parent.add(tree);
    return {
      target: tree,
      rest: { x: tree.x, y: tree.y, angle: 0, alpha: 1 },
      start: (sc) =>
        sc.tweens.add({
          targets: tree,
          angle: { from: -1.5, to: 1.5 },
          duration: 3000,
          yoyo: true,
          repeat: -1,
          ease: TOKENS.motion.ease.ambient,
        }),
    };
  });
}
