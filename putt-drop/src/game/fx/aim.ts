import Phaser from "phaser";
import type { Vec2 } from "../../sim/types.js";
import { TOKENS } from "../../ui/tokens.js";
import { reducedMotion } from "../../ui/motion.js";
import { powerColor } from "../theme.js";
import { worldToUi, type CourseFrame } from "../course/frame.js";

const MAX_MARKS = 64;

export interface AimState {
  /** Ball position in world units. */
  ballX: number;
  ballY: number;
  /** Pointer-down minus current pointer, UI px (the shot direction). */
  dragX: number;
  dragY: number;
  power: number;
  /** Simulation preview path in world units. */
  path: Vec2[];
}

/**
 * Aim guide in UI space (constant on-screen widths regardless of course scale): ring r20 at the ball,
 * power arc next to the ball, pull-back handle under the finger, and the real simulation preview as
 * dots (<50%), dashes (<85%) or solid. Redrawn only when drag input or preview data changes.
 */
export class AimFx {
  private g: Phaser.GameObjects.Graphics;
  private colorblind = false;
  private shown = false;
  private lastSig = "";
  powerShown = 0;

  constructor(
    private scene: Phaser.Scene,
    private frame: CourseFrame
  ) {
    this.g = scene.add.graphics().setDepth(TOKENS.depth.aim).setAlpha(0);
  }

  setColorblind(on: boolean): void {
    if (on !== this.colorblind) this.lastSig = "";
    this.colorblind = on;
  }

  /** aimAcquire: ring fades in over 80ms (static in reduced motion). */
  begin(): void {
    const tw = this.scene.tweens;
    tw.killTweensOf(this.g);
    this.shown = true;
    this.lastSig = "";
    if (reducedMotion()) {
      this.g.setAlpha(1);
      return;
    }
    this.g.setAlpha(0);
    tw.add({ targets: this.g, alpha: 1, duration: TOKENS.motion.duration.instant, ease: TOKENS.motion.ease.fade });
  }

  draw(s: AimState): void {
    if (!this.shown) return;
    const sig = `${s.ballX.toFixed(1)},${s.ballY.toFixed(1)},${s.dragX.toFixed(1)},${s.dragY.toFixed(1)},${s.path.length},${s.path[s.path.length - 1]?.join(",")}`;
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    this.powerShown = s.power;
    const g = this.g;
    g.clear();
    const [bx, by] = worldToUi(this.frame, s.ballX, s.ballY);
    const ink = this.colorblind ? TOKENS.color.aimAccessible : powerColor(s.power);
    const backing = TOKENS.color.aimBacking;

    // Preview path (actual simulation), pattern encodes the power band for colorblind players too.
    const dash = s.power < 0.5 ? 2 : s.power < 0.85 ? 7 : 0;
    const gap = s.power < 0.5 ? 6 : s.power < 0.85 ? 5 : 0;
    let marks = 0;
    for (let i = 0; i < s.path.length - 1 && marks < MAX_MARKS; i++) {
      const a = worldToUi(this.frame, s.path[i][0], s.path[i][1]);
      const b = worldToUi(this.frame, s.path[i + 1][0], s.path[i + 1][1]);
      marks += this.segment(a[0], a[1], b[0], b[1], ink, backing, dash, gap, MAX_MARKS - marks);
    }

    // Pull-back handle: from the ball toward the finger side (opposite the shot), knob at its end.
    const len = Math.hypot(s.dragX, s.dragY);
    if (len > 4) {
      const hl = Math.min(len, 160 * this.frame.q);
      const hx = bx - (s.dragX / len) * hl;
      const hy = by - (s.dragY / len) * hl;
      g.lineStyle(5, backing, 0.7);
      g.lineBetween(bx, by, hx, hy);
      g.lineStyle(2, ink, 0.9);
      g.lineBetween(bx, by, hx, hy);
      g.fillStyle(backing, 0.85);
      g.fillCircle(hx, hy, 7);
      g.fillStyle(ink, 1);
      g.fillCircle(hx, hy, 5);
    }

    // Ring r20 around the ball.
    g.lineStyle(5, backing, 0.85);
    g.strokeCircle(bx, by, 20);
    g.lineStyle(2, ink, 0.95);
    g.strokeCircle(bx, by, 20);

    // Power arc next to the ball (sweep = power), with a faint full track.
    const r = 27;
    g.lineStyle(6, backing, 0.55);
    g.strokeCircle(bx, by, r);
    if (s.power > 0.005) {
      g.lineStyle(4, ink, 1);
      g.beginPath();
      g.arc(bx, by, r, -Math.PI / 2, -Math.PI / 2 + s.power * Math.PI * 2, false);
      g.strokePath();
    }
  }

  private segment(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    ink: number,
    backing: number,
    dash: number,
    gap: number,
    budget: number
  ): number {
    const g = this.g;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 0.5) return 0;
    if (dash <= 0) {
      g.lineStyle(5, backing, 0.75);
      g.lineBetween(x1, y1, x2, y2);
      g.lineStyle(2.5, ink, 0.95);
      g.lineBetween(x1, y1, x2, y2);
      return 1;
    }
    const ux = dx / len;
    const uy = dy / len;
    let used = 0;
    for (let t = 0; t < len && used < budget; t += dash + gap) {
      const t2 = Math.min(len, t + dash);
      const ax = x1 + ux * t;
      const ay = y1 + uy * t;
      if (dash <= 2) {
        g.fillStyle(backing, 0.8);
        g.fillCircle(ax, ay, 2.6);
        g.fillStyle(ink, 1);
        g.fillCircle(ax, ay, 1.6);
      } else {
        g.lineStyle(5, backing, 0.75);
        g.lineBetween(ax, ay, x1 + ux * t2, y1 + uy * t2);
        g.lineStyle(2.5, ink, 0.95);
        g.lineBetween(ax, ay, x1 + ux * t2, y1 + uy * t2);
      }
      used++;
    }
    return used;
  }

  /** Valid release: guide fades in 80ms (off immediately in reduced motion). */
  release(): void {
    this.shown = false;
    this.lastSig = "";
    const tw = this.scene.tweens;
    tw.killTweensOf(this.g);
    if (reducedMotion()) {
      this.g.clear().setAlpha(0);
      return;
    }
    tw.add({
      targets: this.g,
      alpha: 0,
      duration: TOKENS.motion.duration.instant,
      ease: TOKENS.motion.ease.fade,
      onComplete: () => this.g.clear(),
    });
  }

  /** Cancel/pause: hide immediately. */
  cancel(): void {
    this.shown = false;
    this.lastSig = "";
    this.scene.tweens.killTweensOf(this.g);
    this.g.clear().setAlpha(0);
  }

  isShown(): boolean {
    return this.shown;
  }

  /** Current guide opacity (aimAcquire fade). */
  opacity(): number {
    return this.g.alpha;
  }

  destroy(): void {
    this.cancel();
    this.g.destroy();
  }
}
