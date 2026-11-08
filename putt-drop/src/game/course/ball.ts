import Phaser from "phaser";
import { BALL_R } from "../../sim/physics.js";
import { TOKENS } from "../../ui/tokens.js";
import { bakeCanvasForScene } from "../../ui/textures.js";
import { rgb } from "./canvas.js";
import { WD, type CourseWorld } from "./world.js";

export const BALL_KEY = "course-ball";
export const BALL_SHADOW_KEY = "course-ball-shadow";
const SEAM_KEY = "course-ball-seam";
const C = TOKENS.color;

export function ensureBallTextures(scene: Phaser.Scene): void {
  // Textures are baked at texture DPR; every sprite sets its display size in world units.
  bakeCanvasForScene(scene, BALL_KEY, BALL_R * 2, BALL_R * 2, (ctx) => {
    const r = BALL_R;
    const g = ctx.createRadialGradient(r - 0.3 * r, r - 0.3 * r, 0, r, r, r);
    g.addColorStop(0, rgb(C.ballLight));
    g.addColorStop(0.6, rgb(C.ballMid));
    g.addColorStop(1, rgb(C.ballShade));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(r, r, r, 0, Math.PI * 2);
    ctx.fill();
  });
  bakeCanvasForScene(scene, BALL_SHADOW_KEY, 14, 5, (ctx) => {
    ctx.fillStyle = rgb(C.text, 0.22);
    ctx.beginPath();
    ctx.ellipse(7, 2.5, 7, 2.5, 0, 0, Math.PI * 2);
    ctx.fill();
  });
  bakeCanvasForScene(scene, SEAM_KEY, BALL_R * 2, BALL_R * 2, (ctx) => {
    // Roll indicator: arc stroke 1, radius 4, length 4, ballMark alpha 0.5.
    ctx.strokeStyle = rgb(C.ballMark, 0.5);
    ctx.lineWidth = 1;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(BALL_R, BALL_R, 4, -0.5, 0.5);
    ctx.stroke();
  });
}

/**
 * The ball: shadow + shaded body + seam. Squash is applied along the contact normal via a rotated
 * wrapper (wrapper rotation = normal, inner counter-rotation keeps shading upright); the collision
 * radius is never touched.
 */
export class CourseBall {
  readonly root: Phaser.GameObjects.Container;
  private shadow: Phaser.GameObjects.Image;
  private squashWrap: Phaser.GameObjects.Container;
  private inner: Phaser.GameObjects.Container;
  private seam: Phaser.GameObjects.Image;
  private seamAngle = 0;

  constructor(
    private scene: Phaser.Scene,
    world: CourseWorld
  ) {
    ensureBallTextures(scene);
    this.shadow = scene.add.image(0, 3, BALL_SHADOW_KEY).setDisplaySize(14, 5);
    const body = scene.add.image(0, 0, BALL_KEY).setDisplaySize(BALL_R * 2, BALL_R * 2);
    this.seam = scene.add.image(0, 0, SEAM_KEY).setDisplaySize(BALL_R * 2, BALL_R * 2);
    this.inner = scene.add.container(0, 0, [body, this.seam]);
    this.squashWrap = scene.add.container(0, 0, [this.inner]);
    this.root = scene.add.container(0, 0, [this.shadow, this.squashWrap]);
    this.root.setDepth(WD.ball);
    world.add(this.root);
  }

  get x(): number {
    return this.root.x;
  }

  get y(): number {
    return this.root.y;
  }

  setPosition(x: number, y: number): void {
    this.root.setPosition(x, y);
  }

  setVisible(v: boolean): void {
    this.root.setVisible(v);
  }

  setAlpha(a: number): void {
    this.scene.tweens.killTweensOf(this.root);
    this.root.setAlpha(a);
  }

  /** ballWallSquash: 48ms to normal 0.94 / tangent 1.03, 112ms back; latest contact replaces. */
  squash(nx: number, ny: number): void {
    const tw = this.scene.tweens;
    const angle = Math.atan2(ny, nx);
    tw.killTweensOf(this.squashWrap);
    this.squashWrap.setRotation(angle);
    this.inner.setRotation(-angle);
    this.squashWrap.setScale(1, 1);
    const { contactIn, contactOut } = TOKENS.motion.duration;
    tw.add({
      targets: this.squashWrap,
      scaleX: 0.94,
      scaleY: 1.03,
      duration: contactIn,
      ease: TOKENS.motion.ease.enter,
      onComplete: () => {
        tw.add({
          targets: this.squashWrap,
          scaleX: 1,
          scaleY: 1,
          duration: contactOut,
          ease: TOKENS.motion.ease.release,
        });
      },
    });
  }

  /** puttRelease: uniform 0.97 for 48ms, back to 1 over 112ms. A collision squash supersedes it. */
  compress(): void {
    const tw = this.scene.tweens;
    tw.killTweensOf(this.squashWrap);
    this.squashWrap.setRotation(0);
    this.inner.setRotation(0);
    this.squashWrap.setScale(0.97);
    tw.add({
      targets: this.squashWrap,
      scaleX: 1,
      scaleY: 1,
      delay: TOKENS.motion.duration.contactIn,
      duration: TOKENS.motion.duration.contactOut,
      ease: TOKENS.motion.ease.release,
    });
  }

  /** Current squash deformation (1 = none). */
  squashAmount(): number {
    return Math.max(Math.abs(1 - this.squashWrap.scaleX), Math.abs(1 - this.squashWrap.scaleY));
  }

  resetShape(): void {
    this.scene.tweens.killTweensOf(this.squashWrap);
    this.squashWrap.setScale(1).setRotation(0);
    this.inner.setRotation(0);
  }

  /** ballRoll: seam angle integrates travelled distance / r. Disabled in reduced motion. */
  integrateRoll(dx: number, dy: number, reduced: boolean): void {
    if (reduced) return;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-6) return;
    this.seamAngle += dist / BALL_R;
    this.seam.setRotation(this.seamAngle);
  }

  destroy(): void {
    this.scene.tweens.killTweensOf([this.root, this.squashWrap]);
    this.root.destroy();
  }
}

export { BALL_R };
