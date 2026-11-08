import Phaser from "phaser";
import type { Level, OneWayGate, Vec2 } from "../../sim/types.js";
import { TOKENS } from "../../ui/tokens.js";
import { reducedMotion } from "../../ui/motion.js";
import { BALL_KEY, BALL_R } from "../course/ball.js";
import { pointInPoly } from "../course/bakeStatic.js";
import type { CourseFrame } from "../course/frame.js";
import { worldToUi } from "../course/frame.js";
import { DEPTH } from "../theme.js";
import { pocketLayout } from "../travel.js";

type HintKind = "fastTurf" | "wicket";
type HintKey = { at: Vec2; ms: number; ease: string };

/** Demo plays twice, with a short rest between, unless tapped away. */
const REPEATS = 2;
const PAUSE_MS = 420;
const REDUCED_HOLD_MS = 2400;

/**
 * One-time, text-free mechanic intro on the first hole of each paid world (13 and 25).
 * Skippable by tapping anywhere on the play area.
 */
export class WorldMechanicHint {
  private root: Phaser.GameObjects.Container | null = null;
  private ghost: Phaser.GameObjects.Image | null = null;
  private active = false;
  private onDone: (() => void) | null = null;
  private startedAt = -1;
  private durationMs = 1;
  private timers: Phaser.Time.TimerEvent[] = [];

  constructor(
    private scene: Phaser.Scene,
    private frame: CourseFrame
  ) {}

  show(kind: HintKind, level: Level, done: () => void): void {
    this.cancel();
    this.active = true;
    this.onDone = done;
    const reduce = reducedMotion();
    const { H } = pocketLayout();
    this.root = this.scene.add.container(0, 0).setDepth(DEPTH.overlay - 2).setAlpha(0);
    const dim = this.scene.add.rectangle(180, H / 2, 360, H, TOKENS.color.scrim, 0.22).setInteractive();
    dim.on("pointerdown", () => (this.isVisible() ? this.finish() : this.cancel()));
    this.root.add(dim);
    const keys = kind === "fastTurf" ? this.fastTurfKeys(level) : this.wicketKeys(level);
    if (!keys) return this.finish();
    this.ghost = this.scene.add
      .image(keys[0].at[0], keys[0].at[1], BALL_KEY)
      .setDisplaySize(BALL_R * 2, BALL_R * 2)
      .setAlpha(0.82);
    this.root.add(this.ghost);
    // Same settle delay as the first-putt hint, so park travel has finished before it starts.
    this.after(TOKENS.motion.duration.hintDelay, () => {
      this.root?.setAlpha(1);
      this.startedAt = this.scene.time.now;
      if (reduce) {
        // Reduced motion: one static key pose (the contact / the patch), held, no movement.
        const pose = keys[Math.min(1, keys.length - 1)].at;
        this.ghost?.setPosition(pose[0], pose[1]);
        this.durationMs = REDUCED_HOLD_MS;
        this.after(REDUCED_HOLD_MS, () => this.finish());
        return;
      }
      const once = keys.reduce((t, k) => t + k.ms, 0) + PAUSE_MS;
      this.durationMs = once * REPEATS;
      this.runDemo(keys, REPEATS);
    });
  }

  cancel(): void {
    this.active = false;
    this.startedAt = -1;
    for (const t of this.timers) t.remove(false);
    this.timers = [];
    if (this.ghost) this.scene.tweens.killTweensOf(this.ghost);
    this.root?.destroy();
    this.root = null;
    this.ghost = null;
    this.onDone = null;
  }

  isActive(): boolean {
    return this.active;
  }

  /** On screen (past the start delay). Before that a putt simply cancels it, unseen. */
  isVisible(): boolean {
    return this.active && this.startedAt >= 0;
  }

  /** 0..1 through the ghost demo once it has started (dev capture checks); 0 while waiting. */
  progress(): number {
    if (!this.active || this.startedAt < 0) return 0;
    return Math.min(1, (this.scene.time.now - this.startedAt) / this.durationMs);
  }

  /** Tap-to-skip: persists the seen flag via the completion callback. */
  dismiss(): void {
    this.finish();
  }

  private finish(): void {
    if (!this.active) return;
    const done = this.onDone;
    this.cancel();
    done?.();
  }

  private after(ms: number, fn: () => void): void {
    this.timers.push(this.scene.time.delayedCall(ms, fn));
  }

  /** Plays the key poses in order `left` times, then finishes. */
  private runDemo(keys: HintKey[], left: number): void {
    const ghost = this.ghost;
    if (!ghost || !this.active) return;
    ghost.setPosition(keys[0].at[0], keys[0].at[1]);
    const legs = keys.slice(1).map((k) => ({ x: k.at[0], y: k.at[1], duration: k.ms, ease: k.ease }));
    this.scene.tweens.chain({
      targets: ghost,
      tweens: legs,
      onComplete: () => {
        if (left > 1) this.after(PAUSE_MS, () => this.runDemo(keys, left - 1));
        else this.after(PAUSE_MS, () => this.finish());
      },
    });
  }

  /**
   * Ghost rolls onto the dew patch and keeps its speed across it. The path is local to the patch
   * (a chord through its centre, heading away from the tee), so it never crosses rails elsewhere.
   */
  private fastTurfKeys(level: Level): HintKey[] | null {
    const zone = level.fastTurf?.[0];
    if (!zone) return null;
    let cx = 0;
    let cy = 0;
    for (const [x, y] of zone.poly) {
      cx += x / zone.poly.length;
      cy += y / zone.poly.length;
    }
    const dx = cx - level.tee[0];
    const dy = cy - level.tee[1];
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const span = 400;
    const chord = this.lineThroughPoly(zone.poly, [cx - ux * span, cy - uy * span], [cx + ux * span, cy + uy * span]);
    if (chord.length < 4) return null;
    const enter = chord[1];
    const exit = chord[3];
    const start: Vec2 = [enter[0] - ux * 40, enter[1] - uy * 40];
    const ui = [start, enter, exit].map(([x, y]) => worldToUi(this.frame, x, y) as Vec2);
    return [
      { at: ui[0], ms: 0, ease: "Linear" },
      { at: ui[1], ms: 650, ease: "Cubic.easeOut" },
      { at: ui[2], ms: 360, ease: "Linear" },
    ];
  }

  /** Ghost rolls at the wicket's blocking face (+normal side), touches it and bounces back. */
  private wicketKeys(level: Level): HintKey[] | null {
    const gate = level.oneWayGates?.[0];
    if (!gate) return null;
    const [nx, ny] = gate.normal;
    const mid = [(gate.from[0] + gate.to[0]) / 2, (gate.from[1] + gate.to[1]) / 2];
    const approach = [mid[0] + nx * 48, mid[1] + ny * 48];
    // Ball centre at contact: one ball radius in front of the hoop line.
    const contact = [mid[0] + nx * BALL_R, mid[1] + ny * BALL_R];
    const retreat = [mid[0] + nx * 34, mid[1] + ny * 34];
    const [a, c, r] = [approach, contact, retreat].map(([x, y]) => worldToUi(this.frame, x, y) as Vec2);
    return [
      { at: a, ms: 0, ease: "Linear" },
      { at: c, ms: 520, ease: "Quad.easeIn" },
      { at: r, ms: 360, ease: "Cubic.easeOut" },
    ];
  }

  private lineThroughPoly(poly: Vec2[], a: Vec2, b: Vec2): Vec2[] {
    const ax = a[0];
    const ay = a[1];
    const bx = b[0];
    const by = b[1];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const hits: { t: number; p: Vec2 }[] = [];
    for (let t = 0; t <= len; t += 4) {
      const x = ax + ux * t;
      const y = ay + uy * t;
      if (pointInPoly(x, y, poly)) hits.push({ t, p: [x, y] });
    }
    if (hits.length < 2) return [a, [(ax + bx) / 2, (ay + by) / 2], b];
    const enter = hits[0].p;
    const exit = hits[hits.length - 1].p;
    const mid = hits[Math.floor(hits.length / 2)].p;
    return [a, enter, mid, exit];
  }
}
