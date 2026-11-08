import Phaser from "phaser";
import { TOKENS } from "../../ui/tokens.js";
import { reducedMotion } from "../../ui/motion.js";
import { bakeCanvasForScene } from "../../ui/textures.js";
import { sfxCupPlop, sfxStarNote, sfxCompletionQuiet } from "../../audio/sfx.js";
import { duckMusic } from "../../audio/music.js";
import { hapticImpact } from "../../platform/haptics.js";
import { CourseCupFx } from "../course/cup.js";
import { BALL_KEY, BALL_R, BALL_SHADOW_KEY, type CourseBall } from "../course/ball.js";
import { rgb } from "../course/canvas.js";
import { ParticlePool, WD, type CourseWorld } from "../course/world.js";

const LEAF_KEY = "course-leaf";
const C = TOKENS.color;
const D = TOKENS.motion.duration;
const E = TOKENS.motion.ease;

function ensureLeafTexture(scene: Phaser.Scene): void {
  bakeCanvasForScene(scene, LEAF_KEY, 8, 5, (ctx) => {
    ctx.fillStyle = rgb(C.highlight);
    ctx.beginPath();
    ctx.ellipse(4, 2.5, 4, 2.2, 0, 0, Math.PI * 2);
    ctx.fill();
  });
}

/**
 * Course half of the hole-complete reward (motion.md section 4): masked ball drop, flag wiggle,
 * twelve leaves near the cup, cup plop / star notes. The result card itself is built by PlayScene
 * and shown at F0. Everything here is skippable at any moment and owns its tweens/timers.
 */
export class HoleCelebration {
  private dropClone: Phaser.GameObjects.Image;
  private dropShadow: Phaser.GameObjects.Image;
  private leaves: Phaser.GameObjects.Image[] = [];
  private timers: Phaser.Time.TimerEvent[] = [];
  private running = false;
  private startedAt = 0;

  constructor(
    private scene: Phaser.Scene,
    world: CourseWorld,
    private cup: CourseCupFx,
    private ball: CourseBall,
    private particles: ParticlePool
  ) {
    ensureLeafTexture(scene);
    this.dropShadow = world.add(
      scene.add.image(0, 0, BALL_SHADOW_KEY).setDisplaySize(14, 5).setDepth(WD.dropClone).setVisible(false)
    );
    this.dropClone = world.add(
      scene.add.image(0, 0, BALL_KEY).setDisplaySize(BALL_R * 2, BALL_R * 2).setDepth(WD.dropClone).setVisible(false)
    );
  }

  isRunning(): boolean {
    return this.running;
  }

  /** ms since holed (for capture checks). */
  elapsed(): number {
    return this.running ? this.scene.time.now - this.startedAt : -1;
  }

  dropProgress(): number {
    if (!this.dropClone.visible) return -1;
    const s0 = (BALL_R * 2) / this.dropClone.frame.width;
    return 1 - (this.dropClone.scaleX / s0 - 0.2) / 0.8;
  }

  leavesVisible(): number {
    return this.leaves.filter((l) => l.visible && l.alpha > 0.05).length;
  }

  /**
   * F0 = authoritative `holed`. The real ball is hidden now; a clone sinks under the lip (160ms),
   * leaves launch at ~100ms, flag wiggles from 160ms, star notes at 240/320/400ms.
   */
  start(cx: number, cy: number, earnedStars: number, sound: boolean, vibration: boolean): void {
    this.skip();
    this.running = true;
    this.startedAt = this.scene.time.now;
    this.ball.setVisible(false);
    const reduce = reducedMotion();
    if (reduce) {
      this.cup.showDropLip(0);
      if (sound) sfxCompletionQuiet();
      this.after(D.instant, () => (this.running = false));
      return;
    }
    duckMusic(true);
    this.after(800, () => duckMusic(false));
    const tw = this.scene.tweens;

    const s0 = (BALL_R * 2) / this.dropClone.frame.width;
    this.dropClone.setPosition(cx, cy).setScale(s0).setAlpha(1).setVisible(true);
    this.dropShadow.setPosition(cx, cy + 3).setDisplaySize(14, 5).setAlpha(1).setVisible(true);
    const sh0 = this.dropShadow.scaleX;
    const shY0 = this.dropShadow.scaleY;
    this.cup.showDropLip(160);
    tw.add({
      targets: this.dropClone,
      y: cy + 4,
      scale: s0 * 0.2,
      alpha: 0,
      duration: 160,
      ease: E.drop,
      onComplete: () => this.dropClone.setVisible(false),
    });
    tw.add({
      targets: this.dropShadow,
      scaleX: sh0 * 0.5,
      scaleY: shY0 * 0.5,
      alpha: 0,
      duration: 160,
      ease: E.drop,
      onComplete: () => this.dropShadow.setVisible(false),
    });

    this.after(100, () => {
      if (sound) sfxCupPlop();
      hapticImpact(vibration, "light");
      this.spawnLeaves(cx, cy);
    });
    this.after(160, () => this.cup.wiggleFlag());
    const notes = [523, 659, 784];
    [240, 320, 400].forEach((t, i) => {
      if (i < earnedStars && sound) this.after(t, () => sfxStarNote(notes[i]));
    });
    this.after(800, () => (this.running = false));
  }

  /** Any action (Next/Retry/Holes) or an early tap: remove every remaining visual and queued sound now. */
  skip(): void {
    for (const t of this.timers) t.remove(false);
    this.timers = [];
    const tw = this.scene.tweens;
    tw.killTweensOf([this.dropClone, this.dropShadow]);
    this.dropClone.setVisible(false);
    this.dropShadow.setVisible(false);
    for (const l of this.leaves) this.particles.release(l);
    this.leaves = [];
    this.cup.settle();
    if (this.running) duckMusic(false);
    this.running = false;
  }

  private after(ms: number, fn: () => void): void {
    this.timers.push(this.scene.time.delayedCall(ms, fn));
  }

  /** holeReward leaves: 12 coral/gold/green, launch near the cup, travel <= 40px, life <= 640ms. */
  private spawnLeaves(cx: number, cy: number): void {
    const colors = [C.flower, C.star, C.secondary];
    const n = TOKENS.budget.celebrationParticles;
    const tw = this.scene.tweens;
    for (let i = 0; i < n; i++) {
      const leaf = this.particles.take(LEAF_KEY);
      const a = (i / n) * Math.PI * 2 + (i % 2) * 0.2;
      const dist = 24 + (i % 4) * 5;
      const life = 520 + (i % 3) * 60;
      leaf
        .setTint(colors[i % colors.length])
        // Launch from just outside the lip so the sinking ball stays readable inside the cup.
        .setPosition(cx + Math.cos(a) * 13, cy + Math.sin(a) * 13)
        .setDisplaySize(8, 5)
        .setRotation(a);
      this.leaves.push(leaf);
      tw.add({
        targets: leaf,
        x: cx + Math.cos(a) * dist,
        y: cy + Math.sin(a) * dist + 6,
        rotation: a + (i % 2 ? 1.2 : -1.2),
        alpha: { value: 0, ease: "Cubic.easeIn" },
        duration: life,
        ease: E.enter,
        onComplete: () => {
          this.particles.release(leaf);
          this.leaves = this.leaves.filter((l) => l !== leaf);
        },
      });
    }
  }

  destroy(): void {
    this.skip();
    this.dropClone.destroy();
    this.dropShadow.destroy();
  }
}
