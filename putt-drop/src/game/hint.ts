import Phaser from "phaser";
import { TOKENS } from "../ui/tokens.js";
import { reducedMotion } from "../ui/motion.js";
import { bakeCanvasForScene } from "../ui/textures.js";
import { rgb } from "./course/canvas.js";
import type { CourseFrame } from "./course/frame.js";

const HAND_KEY = "course-ghost-hand";
const HAND_W = 36;
const HAND_H = 48;
const TRAVEL = 48;
const C = TOKENS.color;

function ensureHandTexture(scene: Phaser.Scene): void {
  // Text-free pointing hand, fingertip at the top centre of the texture (origin set there).
  bakeCanvasForScene(scene, HAND_KEY, HAND_W, HAND_H, (ctx) => {
    const fill = rgb(C.highlight, 0.95);
    const edge = rgb(C.text, 0.85);
    ctx.lineJoin = "round";
    ctx.lineWidth = 2;
    ctx.strokeStyle = edge;
    ctx.fillStyle = fill;
    ctx.beginPath();
    // index finger
    ctx.moveTo(13, 22);
    ctx.lineTo(13, 6);
    ctx.arc(17, 6, 4, Math.PI, 0);
    ctx.lineTo(21, 20);
    // knuckles
    ctx.arc(24.5, 21, 3.5, Math.PI, 0);
    ctx.arc(31, 23, 3.2, Math.PI, 0);
    ctx.lineTo(34.2, 34);
    ctx.quadraticCurveTo(34, 45, 24, 46);
    ctx.lineTo(16, 46);
    ctx.quadraticCurveTo(9, 44, 5, 34);
    ctx.lineTo(3, 28);
    ctx.quadraticCurveTo(3, 24, 7, 25);
    ctx.lineTo(13, 31);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  });
}

/**
 * First-time ghost hand (motion.md ghostHand): after 1800ms idle, a hand presses on the real ball and
 * drags 48px back (opposite the demonstrative aim), 2400ms cycle, at most 2 cycles. Any play-area touch
 * cancels it at once. Reduced motion: static hand + dotted arrow. Never shoots, scores or blocks input.
 */
export class FirstPuttHint {
  private hand: Phaser.GameObjects.Image | null = null;
  private pathGfx: Phaser.GameObjects.Graphics | null = null;
  private cycles = 0;
  private timers: Phaser.Time.TimerEvent[] = [];
  private active = false;

  constructor(
    private scene: Phaser.Scene,
    private frame: CourseFrame
  ) {}

  /** (bx, by) ball in UI px; (dx, dy) unit drag-back direction. */
  schedule(bx: number, by: number, dx: number, dy: number): void {
    this.cancel();
    this.active = true;
    this.cycles = 0;
    this.after(TOKENS.motion.duration.hintDelay, () => this.startCycle(bx, by, dx, dy));
  }

  isVisible(): boolean {
    return this.hand != null && this.hand.visible && this.hand.alpha > 0.5;
  }

  /** Hand travel progress 0..1 along the drag-back path (capture checks). */
  progress(): number {
    if (!this.hand) return -1;
    const d = this.hand.getData("start") as [number, number] | undefined;
    if (!d) return -1;
    return Math.hypot(this.hand.x - d[0], this.hand.y - d[1]) / TRAVEL;
  }

  cancel(): void {
    this.active = false;
    for (const t of this.timers) t.remove(false);
    this.timers = [];
    if (this.hand) this.scene.tweens.killTweensOf(this.hand);
    this.hand?.destroy();
    this.pathGfx?.destroy();
    this.hand = null;
    this.pathGfx = null;
  }

  private after(ms: number, fn: () => void): void {
    this.timers.push(this.scene.time.delayedCall(ms, fn));
  }

  /** Clip the 48px travel so the hand path stays inside the course viewport. */
  private travelFor(bx: number, by: number, dx: number, dy: number): number {
    const f = this.frame;
    let t = TRAVEL;
    const ex = bx + dx * t;
    const ey = by + dy * t;
    if (ey > f.top + f.height) t = Math.min(t, (f.top + f.height - by) / (dy || 1));
    if (ey < f.top) t = Math.min(t, (f.top - by) / (dy || -1));
    if (ex > f.left + f.width) t = Math.min(t, (f.left + f.width - bx) / (dx || 1));
    if (ex < f.left) t = Math.min(t, (f.left - bx) / (dx || -1));
    return Math.max(16, t);
  }

  private startCycle(bx: number, by: number, dx: number, dy: number): void {
    if (!this.active) return;
    if (this.cycles >= 2) {
      // After two cycles only the power-card instruction remains.
      this.hand?.destroy();
      this.pathGfx?.destroy();
      this.hand = null;
      this.pathGfx = null;
      return;
    }
    this.cycles++;
    ensureHandTexture(this.scene);
    const travel = this.travelFor(bx, by, dx, dy);
    if (!this.hand) {
      this.hand = this.scene.add
        .image(bx, by, HAND_KEY)
        .setOrigin(17 / HAND_W, 2 / HAND_H)
        .setDisplaySize(HAND_W, HAND_H)
        .setDepth(TOKENS.depth.aim + 1);
      this.pathGfx = this.scene.add.graphics().setDepth(TOKENS.depth.aim);
      // Dotted backward path with an arrow head (static; drawn once).
      const g = this.pathGfx;
      g.fillStyle(C.text, 0.55);
      for (let t = 8; t <= travel; t += 6) g.fillCircle(bx + dx * t, by + dy * t, 1.6);
      const ex = bx + dx * travel;
      const ey = by + dy * travel;
      const nx = -dy;
      const ny = dx;
      g.lineStyle(2, C.text, 0.55);
      g.lineBetween(ex, ey, ex - dx * 6 + nx * 5, ey - dy * 6 + ny * 5);
      g.lineBetween(ex, ey, ex - dx * 6 - nx * 5, ey - dy * 6 - ny * 5);
    }
    const hand = this.hand;
    hand.setData("start", [bx, by]);
    hand.setPosition(bx, by);
    if (reducedMotion()) {
      hand.setAlpha(0.9);
      return;
    }
    const tw = this.scene.tweens;
    hand.setAlpha(0);
    // fade 80, hold 160, drag 640 Cubic.easeInOut, release 80, rest 1440 (2400 total).
    tw.chain({
      targets: hand,
      tweens: [
        { alpha: 0.95, duration: 80, ease: "Linear" },
        { alpha: 0.95, duration: 160 },
        { x: bx + dx * travel, y: by + dy * travel, duration: 640, ease: "Cubic.easeInOut" },
        { alpha: 0, duration: 80, ease: "Linear" },
      ],
    });
    this.after(TOKENS.motion.duration.hintCycle, () => this.startCycle(bx, by, dx, dy));
  }
}
