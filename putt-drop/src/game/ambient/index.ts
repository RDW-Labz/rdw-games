import Phaser from "phaser";
import { TOKENS } from "../../ui/tokens.js";
import { addDriftingClouds, type AmbientItem } from "./clouds.js";
import { addLightShift } from "./light.js";
import { addTreeSwaySprites } from "./trees.js";

/**
 * Menu idle life (motion.md): tree sway, cloud drift, light shift, ball float. A handful of
 * shapes, one tween each (total ambient <= 8). Static at neutral poses under reduced motion;
 * paused while the page is hidden.
 */
export class MenuAmbient {
  private readonly scene: Phaser.Scene;
  private readonly root: Phaser.GameObjects.Container;
  private readonly items: AmbientItem[] = [];
  private tweens: Phaser.Tweens.Tween[] = [];
  private reduced = true;

  constructor(scene: Phaser.Scene, parent: Phaser.GameObjects.Container, islandY: number) {
    this.scene = scene;
    this.root = scene.add.container(0, 0);
    parent.add(this.root);

    this.items.push(...addDriftingClouds(scene, this.root));
    this.items.push(addLightShift(scene, this.root));

    const island = scene.add.ellipse(TOKENS.layout.logicalW / 2, islandY, 260, 120, TOKENS.color.turfTop, 0.35);
    this.root.add(island);

    this.items.push(
      ...addTreeSwaySprites(scene, this.root, [
        { x: 52, y: islandY - 40, scale: 0.9 },
        { x: 308, y: islandY - 52, scale: 1 },
      ])
    );

    // menuBallFloat: 4000 ms full cycle, y 0 -> -3, angle 0 -> 1 deg.
    const ballY = islandY + 12;
    const ball = scene.add.circle(TOKENS.layout.logicalW / 2 - 50, ballY, 10, TOKENS.color.ballMid);
    ball.setStrokeStyle(1, TOKENS.color.ballMark, 0.4);
    this.root.add(ball);
    this.items.push({
      target: ball,
      rest: { x: ball.x, y: ballY, angle: 0, alpha: 1 },
      start: (sc) =>
        sc.tweens.add({
          targets: ball,
          y: { from: ballY, to: ballY - 3 },
          angle: { from: 0, to: 1 },
          duration: 2000,
          yoyo: true,
          repeat: -1,
          ease: TOKENS.motion.ease.ambient,
        }),
    });
  }

  /** Reduced motion: stop every idle tween and snap to the neutral pose. */
  setReduced(on: boolean): void {
    if (on === this.reduced && (on || this.tweens.length > 0)) return;
    this.reduced = on;
    for (const t of this.tweens) t.remove();
    this.tweens = [];
    for (const it of this.items) {
      it.target.x = it.rest.x;
      it.target.y = it.rest.y;
      it.target.angle = it.rest.angle;
      it.target.alpha = it.rest.alpha;
    }
    if (!on) this.tweens = this.items.map((it) => it.start(this.scene));
  }

  setPaused(on: boolean): void {
    for (const t of this.tweens) {
      if (on) t.pause();
      else t.resume();
    }
  }

  destroy(): void {
    for (const t of this.tweens) t.remove();
    this.tweens = [];
    this.root.destroy(true);
  }
}
