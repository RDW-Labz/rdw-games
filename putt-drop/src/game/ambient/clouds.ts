import Phaser from "phaser";
import { TOKENS } from "../../ui/tokens.js";

export interface AmbientItem {
  target: Phaser.GameObjects.GameObject & { x: number; y: number; angle: number; alpha: number };
  /** Neutral (reduced-motion) pose. */
  rest: { x: number; y: number; angle: number; alpha: number };
  /** Builds the idle tween for this item. */
  start: (scene: Phaser.Scene) => Phaser.Tweens.Tween;
}

/** cloudDrift: 8000 ms full cycle, x -8 -> +8 -> -8, Sine.easeInOut, no wrap. Max 2 sprites. */
export function addDriftingClouds(
  scene: Phaser.Scene,
  parent: Phaser.GameObjects.Container
): AmbientItem[] {
  const specs = [
    { x: 70, y: 90, w: 64, h: 28 },
    { x: 280, y: 120, w: 72, h: 30 },
  ];
  return specs.map((s) => {
    const c = scene.add.ellipse(s.x, s.y, s.w, s.h, TOKENS.color.highlight, 0.55);
    parent.add(c);
    return {
      target: c,
      rest: { x: s.x, y: s.y, angle: 0, alpha: c.alpha },
      start: (sc) =>
        sc.tweens.add({
          targets: c,
          x: { from: s.x - 8, to: s.x + 8 },
          duration: 4000,
          yoyo: true,
          repeat: -1,
          ease: TOKENS.motion.ease.ambient,
        }),
    };
  });
}
