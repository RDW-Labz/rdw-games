import Phaser from "phaser";
import { TOKENS } from "../../ui/tokens.js";
import { DEPTH } from "../theme.js";
import type { CourseFrame } from "./frame.js";

/**
 * Root for every dynamic course sprite (ball, cup, movers, reactions, celebration).
 * Positioned at the course frame origin and uniformly scaled by q, so children use
 * raw simulation/world coordinates and line up with the baked board exactly.
 */
export class CourseWorld {
  readonly root: Phaser.GameObjects.Container;
  frame: CourseFrame;

  constructor(
    readonly scene: Phaser.Scene,
    frame: CourseFrame
  ) {
    this.frame = frame;
    this.root = scene.add.container(frame.ox, frame.oy);
    this.root.setScale(frame.q);
    this.root.setDepth(DEPTH.level + 1);
  }

  applyFrame(frame: CourseFrame): void {
    Object.assign(this.frame, frame);
    this.root.setPosition(frame.ox, frame.oy);
    this.root.setScale(frame.q);
  }

  /** Adds a child and keeps the container drawn in depth order (containers do not depth-sort themselves). */
  add<T extends Phaser.GameObjects.GameObject>(obj: T): T {
    this.root.add(obj);
    this.root.sort("depth");
    return obj;
  }

  destroy(): void {
    this.root.destroy();
  }
}

/** Depth order inside the course world (TOKENS.depth names, so art layering matches system.md). */
export const WD = {
  shimmer: TOKENS.depth.terrain + 1,
  track: TOKENS.depth.track,
  mover: TOKENS.depth.track + 1,
  railFx: TOKENS.depth.rail + 1,
  crown: TOKENS.depth.rail + 2,
  dropClone: TOKENS.depth.cup,
  cupLip: TOKENS.depth.cup + 1,
  ballShadow: TOKENS.depth.contactShadow,
  ball: TOKENS.depth.ball,
  flag: TOKENS.depth.flag,
  fx: TOKENS.depth.courseFx,
} as const;

/** Pooled particle sprites with a global live cap; overflow recycles the oldest decorative particle. */
export class ParticlePool {
  private free: Phaser.GameObjects.Image[] = [];
  private live: Phaser.GameObjects.Image[] = [];

  constructor(
    private world: CourseWorld,
    private cap: number = TOKENS.budget.liveParticles
  ) {}

  take(texture = "particle-dot"): Phaser.GameObjects.Image {
    let img: Phaser.GameObjects.Image | undefined;
    if (this.live.length >= this.cap) {
      img = this.live.shift();
      if (img) this.world.scene.tweens.killTweensOf(img);
    }
    if (!img) img = this.free.pop();
    if (!img) {
      img = this.world.add(this.world.scene.add.image(0, 0, texture).setDepth(WD.fx));
    }
    img.setTexture(texture);
    img.clearTint();
    img.setAlpha(1).setAngle(0).setVisible(true);
    this.live.push(img);
    return img;
  }

  release(img: Phaser.GameObjects.Image): void {
    const i = this.live.indexOf(img);
    if (i < 0) return;
    this.live.splice(i, 1);
    this.world.scene.tweens.killTweensOf(img);
    img.setVisible(false);
    this.free.push(img);
  }

  /** Removes every live particle immediately (skip, reduced-motion switch, new aim). */
  releaseAll(): void {
    for (const img of [...this.live]) this.release(img);
  }

  liveCount(): number {
    return this.live.length;
  }

  destroy(): void {
    for (const img of [...this.live, ...this.free]) {
      this.world.scene.tweens.killTweensOf(img);
      img.destroy();
    }
    this.live = [];
    this.free = [];
  }
}
