import Phaser from "phaser";
import type { Level } from "../../sim/types.js";
import { TOKENS } from "../../ui/tokens.js";
import { reducedMotion } from "../../ui/motion.js";
import { bakeCanvasForScene } from "../../ui/textures.js";
import {
  sfxBumperPop,
  sfxLipOut,
  sfxRim,
  sfxSand,
  sfxSplash,
  sfxWallTick,
} from "../../audio/sfx.js";
import { hapticImpact } from "../../platform/haptics.js";
import { CourseCupFx } from "../course/cup.js";
import { BALL_KEY, BALL_R, type CourseBall } from "../course/ball.js";
import { rgb, polyPath } from "../course/canvas.js";
import { drawSlopeArrows } from "../course/bakeStatic.js";
import { ParticlePool, WD, type CourseWorld } from "../course/world.js";

// @ts-expect-error zzfx ships without TypeScript declarations
import { zzfx } from "zzfx/ZzFX.js";

function sfxWicketClack(speed: number): void {
  const v = Math.min(1, speed / 220);
  zzfx(...[0, , 520 + v * 80, 0.03, 0.04, 0.02, 1, 1.4, , , , , , , , 0.04, 0.01]);
}

const C = TOKENS.color;
const D = TOKENS.motion.duration;
const E = TOKENS.motion.ease;
const RAIL_CAP_KEY = "course-rail-cap";
const RING_KEY = "course-ring";
const RING_TEX = 48;

/** Contact on a wall segment, computed read-only from level geometry (the sim event has no position). */
export interface WallContact {
  /** Contact point on the rail centerline. */
  x: number;
  y: number;
  /** Unit normal from the rail toward the ball. */
  nx: number;
  ny: number;
  /** Stable id of the wall segment (cooldown key). */
  segment: string;
}

function ensureReactionTextures(scene: Phaser.Scene): void {
  bakeCanvasForScene(scene, RAIL_CAP_KEY, 24, 4, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 24, 0);
    g.addColorStop(0, rgb(C.railHighlight, 0));
    g.addColorStop(0.25, rgb(C.railHighlight, 1));
    g.addColorStop(0.75, rgb(C.railHighlight, 1));
    g.addColorStop(1, rgb(C.railHighlight, 0));
    ctx.strokeStyle = g;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(1, 2);
    ctx.lineTo(23, 2);
    ctx.stroke();
  });
  bakeCanvasForScene(scene, RING_KEY, RING_TEX, RING_TEX, (ctx) => {
    ctx.strokeStyle = rgb(C.waterRipple, 1);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(RING_TEX / 2, RING_TEX / 2, RING_TEX / 2 - 2, 0, Math.PI * 2);
    ctx.stroke();
  });
}

/** Particle-dot texture is 16 px; scale for a dot of the given radius in world units. */
const dotScale = (radius: number): number => (radius * 2) / 16;

export class CourseReactions {
  private caps: Phaser.GameObjects.Image[] = [];
  private capNext = 0;
  private segmentHitAt = new Map<string, number>();
  private crowns: Phaser.GameObjects.Image[] = [];
  private activeCrowns: number[] = [];
  private rings: Phaser.GameObjects.Image[] = [];
  private waterGhost: Phaser.GameObjects.Image;
  private shimmers: Phaser.GameObjects.Image[] = [];
  private shimmerKeys: string[] = [];
  private turfGlows: Phaser.GameObjects.Image[] = [];
  private wicketStrips: Phaser.GameObjects.Image[] = [];
  private lastSandAt = -1e9;
  private vibration = true;
  /** Ids of the decorative particles spawned by the last water contact (cancelled by a new aim). */
  private waterParticles: Phaser.GameObjects.Image[] = [];
  /** Last localized effect (world units, scene time) for the dev overlay / capture checks. */
  lastFx = { kind: "", x: 0, y: 0, at: -1e9 };
  /** Counters exposed to the dev overlay / capture checks. */
  readonly stats = { wallHits: 0, sandPuffs: 0, splashes: 0, boings: 0, rattles: 0, shimmers: 0, turfStreaks: 0, wicketHits: 0 };

  constructor(
    private scene: Phaser.Scene,
    private world: CourseWorld,
    private cup: CourseCupFx,
    private ball: CourseBall,
    private particles: ParticlePool
  ) {
    ensureReactionTextures(scene);
    for (let i = 0; i < TOKENS.budget.impactHighlights; i++) {
      this.caps.push(
        world.add(scene.add.image(0, 0, RAIL_CAP_KEY).setDisplaySize(24, 4).setDepth(WD.railFx).setVisible(false))
      );
    }
    for (let i = 0; i < TOKENS.budget.ringSprites; i++) {
      this.rings.push(world.add(scene.add.image(0, 0, RING_KEY).setDepth(WD.fx).setVisible(false)));
    }
    this.waterGhost = world.add(
      scene.add.image(0, 0, BALL_KEY).setDisplaySize(BALL_R * 2, BALL_R * 2).setDepth(WD.ball).setVisible(false)
    );
  }

  setVibration(on: boolean): void {
    this.vibration = on;
  }

  /** Per-hole objects: one crown sprite per bumper, one baked shimmer patch per slope. */
  bindLevel(level: Level): void {
    this.unbindLevel();
    for (const b of level.bumpers) {
      // Crown r=0.55*r at (-0.15r,-0.15r) with the tiny three-bar spring mark at the bumper centre.
      const cr = b.r * 0.55;
      const size = Math.ceil(cr * 2) + 2;
      const key = `course-crown-${Math.round(b.r * 10)}`;
      bakeCanvasForScene(this.scene, key, size, size, (ctx) => {
        const c = size / 2;
        ctx.fillStyle = rgb(C.bumperHighlight);
        ctx.beginPath();
        ctx.arc(c, c, cr, 0, Math.PI * 2);
        ctx.fill();
        const sx = c + b.r * 0.15;
        const sy = c + b.r * 0.15;
        const half = Math.min(cr * 0.5, 3);
        ctx.strokeStyle = rgb(C.bumperEdge, 0.55);
        ctx.lineWidth = 1;
        ctx.lineCap = "round";
        ctx.beginPath();
        for (const dy of [-2, 0, 2]) {
          ctx.moveTo(sx - half, sy + dy);
          ctx.lineTo(sx + half, sy + dy);
        }
        ctx.stroke();
      });
      const crown = this.scene.add
        .image(b.x - b.r * 0.15, b.y - b.r * 0.15, key)
        .setDisplaySize(size, size)
        .setDepth(WD.crown);
      crown.setData("rest", crown.scaleX);
      this.crowns.push(this.world.add(crown));
    }
    (level.fastTurf ?? []).forEach((z, i) => {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const p of z.poly) {
        minX = Math.min(minX, p[0]);
        minY = Math.min(minY, p[1]);
        maxX = Math.max(maxX, p[0]);
        maxY = Math.max(maxY, p[1]);
      }
      const key = `course-turf-glow-${level.id}-${i}`;
      const w = Math.ceil(maxX - minX) + 2;
      const h = Math.ceil(maxY - minY) + 2;
      bakeCanvasForScene(this.scene, key, w, h, (ctx) => {
        ctx.translate(1 - minX, 1 - minY);
        ctx.fillStyle = rgb(C.highlight, 0.35);
        polyPath(ctx, z.poly);
        ctx.fill();
      });
      this.turfGlows.push(
        this.world.add(
          this.scene.add.image(minX - 1, minY - 1, key).setOrigin(0).setDisplaySize(w, h).setDepth(WD.shimmer).setAlpha(0)
        )
      );
    });
    (level.oneWayGates ?? []).forEach((gate, i) => {
      const [ax, ay] = gate.from;
      const [bx, by] = gate.to;
      const len = Math.hypot(bx - ax, by - ay);
      const key = `course-wicket-strip-${level.id}-${i}`;
      const w = Math.ceil(len) + 8;
      const h = 12;
      bakeCanvasForScene(this.scene, key, w, h, (ctx) => {
        ctx.strokeStyle = rgb(C.primaryTop);
        ctx.lineWidth = 3;
        ctx.setLineDash([5, 4]);
        ctx.lineCap = "butt";
        ctx.beginPath();
        ctx.moveTo(2, h / 2);
        ctx.lineTo(w - 2, h / 2);
        ctx.stroke();
      });
      const img = this.scene.add
        .image(ax, ay, key)
        .setOrigin(0, 0.5)
        .setDisplaySize(w, h)
        .setRotation(Math.atan2(by - ay, bx - ax))
        .setDepth(WD.railFx)
        .setAlpha(0);
      this.wicketStrips.push(this.world.add(img));
    });
    level.slopes.forEach((s, i) => {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const p of s.poly) {
        minX = Math.min(minX, p[0]);
        minY = Math.min(minY, p[1]);
        maxX = Math.max(maxX, p[0]);
        maxY = Math.max(maxY, p[1]);
      }
      const key = `course-shimmer-${level.id}-${i}`;
      const w = Math.ceil(maxX - minX) + 2;
      const h = Math.ceil(maxY - minY) + 2;
      bakeCanvasForScene(this.scene, key, w, h, (ctx) => {
        ctx.translate(1 - minX, 1 - minY);
        polyPath(ctx, s.poly);
        ctx.fillStyle = rgb(C.highlight, 0.6);
        ctx.fill();
        drawSlopeArrows(ctx, s.poly, s.force, rgb(C.highlight, 1));
      });
      this.shimmerKeys.push(key);
      this.shimmers.push(
        this.world.add(
          this.scene.add
            .image(minX - 1, minY - 1, key)
            .setOrigin(0)
            .setDisplaySize(w, h)
            .setDepth(WD.shimmer)
            .setAlpha(0)
        )
      );
    });
  }

  private unbindLevel(): void {
    for (const c of this.crowns) {
      this.scene.tweens.killTweensOf(c);
      c.destroy();
    }
    for (const s of this.shimmers) {
      this.scene.tweens.killTweensOf(s);
      s.destroy();
    }
    for (const g of this.turfGlows) {
      this.scene.tweens.killTweensOf(g);
      g.destroy();
    }
    for (const w of this.wicketStrips) {
      this.scene.tweens.killTweensOf(w);
      w.destroy();
    }
    this.crowns = [];
    this.activeCrowns = [];
    this.shimmers = [];
    this.shimmerKeys = [];
    this.turfGlows = [];
    this.wicketStrips = [];
  }

  /** puttRelease: decorative 0.97 compression and up to 2 turf flecks (life 160ms). */
  onPutt(bx: number, by: number, angle: number): void {
    if (reducedMotion()) return;
    this.ball.compress();
    for (let i = 0; i < TOKENS.budget.launchParticles; i++) {
      const p = this.particles.take();
      const side = i === 0 ? -0.5 : 0.5;
      const a = angle + Math.PI + side;
      p.setTint(C.turfTop).setPosition(bx, by + 2).setScale(dotScale(1));
      this.scene.tweens.add({
        targets: p,
        x: bx + Math.cos(a) * 6,
        y: by + 2 + Math.sin(a) * 6,
        alpha: 0,
        duration: D.quick,
        ease: E.enter,
        onComplete: () => this.particles.release(p),
      });
    }
  }

  onWallHit(contact: WallContact | null, speed: number): void {
    sfxWallTick(speed);
    this.stats.wallHits++;
    const reduce = reducedMotion();
    if (contact == null) return;
    this.lastFx = { kind: "wall", x: contact.x, y: contact.y, at: this.scene.time.now };
    if (!reduce) this.ball.squash(contact.nx, contact.ny);
    const now = this.scene.time.now;
    const last = this.segmentHitAt.get(contact.segment) ?? -1e9;
    if (now - last < 80) return;
    this.segmentHitAt.set(contact.segment, now);
    this.railHit(contact, reduce);
  }

  /** railHit: 24-long cap at the contact; highlight flexes 1px outward (away from the ball), then returns and fades. */
  private railHit(c: WallContact, reduce: boolean): void {
    const cap = this.caps[this.capNext];
    this.capNext = (this.capNext + 1) % this.caps.length;
    const tw = this.scene.tweens;
    tw.killTweensOf(cap);
    cap.setPosition(c.x, c.y).setRotation(Math.atan2(c.ny, c.nx) + Math.PI / 2).setAlpha(0.5).setVisible(true);
    if (reduce) {
      this.scene.time.delayedCall(D.instant, () => cap.setVisible(false));
      return;
    }
    tw.chain({
      targets: cap,
      tweens: [
        { x: c.x - c.nx, y: c.y - c.ny, duration: D.contactIn, ease: E.enter },
        { x: c.x, y: c.y, alpha: 0, duration: D.contactOut, ease: E.fade },
      ],
      onComplete: () => cap.setVisible(false),
    });
  }

  /** bumperBoing on the identified bumper: crown 0.92 @48ms, 1.04 @160ms, 1 @240ms; max 2 active. */
  onBumperHit(index: number): void {
    sfxBumperPop();
    hapticImpact(this.vibration, "medium");
    this.stats.boings++;
    const crown = this.crowns[index];
    if (!crown) return;
    const rest = crown.getData("rest") as number;
    const tw = this.scene.tweens;
    if (reducedMotion()) {
      crown.setTint(C.highlight).setTintMode(Phaser.TintModes.FILL);
      this.scene.time.delayedCall(D.instant, () => crown.clearTint());
      return;
    }
    if (!this.activeCrowns.includes(index) && this.activeCrowns.length >= 2) {
      const oldest = this.activeCrowns.shift()!;
      const oc = this.crowns[oldest];
      tw.killTweensOf(oc);
      oc.setScale(oc.getData("rest") as number);
    }
    this.activeCrowns = this.activeCrowns.filter((i) => i !== index);
    this.activeCrowns.push(index);
    tw.killTweensOf(crown);
    tw.chain({
      targets: crown,
      tweens: [
        { scale: rest * 0.92, duration: 48, ease: E.enter },
        { scale: rest * 1.04, duration: 112, ease: E.enter },
        { scale: rest, duration: 80, ease: E.enter },
      ],
      onComplete: () => {
        this.activeCrowns = this.activeCrowns.filter((i) => i !== index);
      },
    });
  }

  crownScale(index: number): number {
    const c = this.crowns[index];
    return c ? c.scaleX / (c.getData("rest") as number) : 1;
  }

  /** sandPuff: 4 pooled dots move <=10px and fade, radius 1.5 -> 2.5, 240ms; cooldown 160ms. */
  onSandEnter(x: number, y: number): void {
    sfxSand();
    const now = this.scene.time.now;
    if (now - this.lastSandAt < 160) return;
    this.lastSandAt = now;
    this.stats.sandPuffs++;
    this.lastFx = { kind: "sand", x, y, at: now };
    if (reducedMotion()) {
      const p = this.particles.take();
      p.setTint(C.sandDot).setPosition(x, y).setScale(dotScale(2)).setAlpha(0.5);
      this.scene.time.delayedCall(D.instant, () => this.particles.release(p));
      return;
    }
    const n = TOKENS.budget.sandParticles;
    for (let i = 0; i < n; i++) {
      const p = this.particles.take();
      const a = (i / n) * Math.PI * 2 + Math.PI / 4;
      p.setTint(C.sandDot).setPosition(x, y).setScale(dotScale(1.5)).setAlpha(0.9);
      this.scene.tweens.add({
        targets: p,
        x: x + Math.cos(a) * 10,
        y: y + Math.sin(a) * 10,
        scale: dotScale(2.5),
        alpha: 0,
        duration: D.base,
        ease: E.enter,
        onComplete: () => this.particles.release(p),
      });
    }
  }

  /** slopeShimmer: first entry this shot; baked patch alpha 0 -> 0.12 -> 0 over 400ms. Static in reduced motion. */
  /** fast-turf-enter: brief speed streaks behind the ball; enter brightens the baked patch once. */
  onFastTurfEnter(index: number, bx: number, by: number, vx: number, vy: number): void {
    const glow = this.turfGlows[index];
    if (glow) {
      this.scene.tweens.killTweensOf(glow);
      glow.setAlpha(reducedMotion() ? 0.18 : 0);
      if (!reducedMotion()) {
        this.scene.tweens.add({ targets: glow, alpha: 0.22, duration: D.quick, yoyo: true, ease: E.enter });
      }
    }
    if (reducedMotion()) return;
    const speed = Math.hypot(vx, vy);
    if (speed < 40) return;
    this.stats.turfStreaks++;
    const ux = -vx / speed;
    const uy = -vy / speed;
    // Short white dashes aligned with travel, trailing the ball: reads as speed on turf and on dew.
    const rot = Math.atan2(vy, vx);
    for (let i = 0; i < 4; i++) {
      const side = (i % 2 === 0 ? 1 : -1) * (2 + (i >> 1) * 2);
      const ox = -uy * side;
      const oy = ux * side;
      const p = this.particles.take();
      p.setTint(C.highlight)
        .setAlpha(0.9)
        .setRotation(rot)
        .setPosition(bx + ux * (6 + i * 2) + ox, by + uy * (6 + i * 2) + oy)
        .setScale(dotScale(2.6), dotScale(0.7));
      this.scene.tweens.add({
        targets: p,
        x: bx + ux * (18 + i * 4) + ox,
        y: by + uy * (18 + i * 4) + oy,
        alpha: 0,
        duration: D.quick + i * 25,
        ease: E.enter,
        onComplete: () => this.particles.release(p),
      });
    }
  }

  onFastTurfExit(index: number): void {
    const glow = this.turfGlows[index];
    if (!glow) return;
    this.scene.tweens.killTweensOf(glow);
    glow.setAlpha(0);
  }

  /** one-way-hit: decorative strip wobble + soft clack; reduced motion uses a highlight only. */
  onOneWayHit(index: number, speed: number, x: number, y: number): void {
    sfxWicketClack(speed);
    this.stats.wicketHits++;
    this.lastFx = { kind: "wicket", x, y, at: this.scene.time.now };
    const strip = this.wicketStrips[index];
    if (!strip) return;
    const tw = this.scene.tweens;
    tw.killTweensOf(strip);
    if (reducedMotion()) {
      strip.setTint(C.highlight).setTintMode(Phaser.TintModes.FILL);
      this.scene.time.delayedCall(D.instant, () => strip.clearTint());
      return;
    }
    const a0 = strip.rotation;
    tw.chain({
      targets: strip,
      tweens: [
        { rotation: a0 + 0.08, duration: 40, ease: E.enter },
        { rotation: a0 - 0.05, duration: 50, ease: E.enter },
        { rotation: a0, duration: 30, ease: E.enter },
      ],
    });
  }

  onSlopeEnter(index: number): void {
    const s = this.shimmers[index];
    if (!s || reducedMotion()) return;
    this.stats.shimmers++;
    this.scene.tweens.killTweensOf(s);
    s.setAlpha(0);
    this.scene.tweens.add({
      targets: s,
      alpha: 0.12,
      duration: D.slow / 2,
      yoyo: true,
      ease: E.ambient,
    });
  }

  /**
   * waterReset at the captured entry point. Penalty is applied by the caller once; the live ball is
   * already at the shot origin. Entry clone fades 80ms, two rings r6 -> r24 over 400ms, 6 droplets 240ms.
   */
  onWater(entryX: number, entryY: number, originX: number, originY: number): void {
    sfxSplash();
    this.stats.splashes++;
    this.lastFx = { kind: "water", x: entryX, y: entryY, at: this.scene.time.now };
    this.ball.setPosition(originX, originY);
    if (reducedMotion()) {
      this.ball.setAlpha(1);
      return;
    }
    const tw = this.scene.tweens;
    this.ball.setAlpha(0.65);
    tw.add({ targets: this.ball.root, alpha: 1, duration: D.instant, ease: E.fade });

    tw.killTweensOf(this.waterGhost);
    this.waterGhost.setPosition(entryX, entryY).setAlpha(1).setVisible(true);
    tw.add({
      targets: this.waterGhost,
      alpha: 0,
      duration: D.instant,
      ease: E.fade,
      onComplete: () => this.waterGhost.setVisible(false),
    });

    this.rings.forEach((ring, i) => {
      tw.killTweensOf(ring);
      const s0 = 12 / RING_TEX;
      const s1 = (i === 0 ? 48 : 34) / RING_TEX;
      ring.setPosition(entryX, entryY).setScale(s0).setAlpha(0.85).setVisible(true);
      tw.add({
        targets: ring,
        scale: s1,
        alpha: 0,
        delay: i * 60,
        duration: D.slow - i * 60,
        ease: E.enter,
        onComplete: () => ring.setVisible(false),
      });
    });

    this.waterParticles = [];
    const n = TOKENS.budget.splashParticles;
    for (let i = 0; i < n; i++) {
      const p = this.particles.take();
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      const dist = 9 + (i % 2) * 4;
      p.setTint(C.waterRipple).setPosition(entryX, entryY).setScale(dotScale(1.6));
      this.waterParticles.push(p);
      tw.add({
        targets: p,
        x: entryX + Math.cos(a) * dist,
        y: entryY + Math.sin(a) * dist - 4,
        alpha: 0,
        duration: D.base,
        ease: E.enter,
        onComplete: () => this.particles.release(p),
      });
    }
  }

  /** Visible splash pieces right now (capture checks). */
  splashVisible(): { rings: number; droplets: number; ghost: boolean } {
    return {
      rings: this.rings.filter((r) => r.visible && r.alpha > 0.05).length,
      droplets: this.waterParticles.filter((p) => p.visible && p.alpha > 0.05).length,
      ghost: this.waterGhost.visible && this.waterGhost.alpha > 0.05,
    };
  }

  onLipOut(): void {
    sfxLipOut();
    this.stats.rattles++;
    this.cup.rimRattle();
  }

  onRim(): void {
    sfxRim();
    this.stats.rattles++;
    this.cup.rimRattle();
  }

  /** A new aim cancels water ghost/droplets and snaps the reset ball to opaque; slope shimmer fades out. */
  cancelForAim(): void {
    const tw = this.scene.tweens;
    tw.killTweensOf(this.waterGhost);
    this.waterGhost.setVisible(false);
    for (const r of this.rings) {
      tw.killTweensOf(r);
      r.setVisible(false);
    }
    for (const p of this.waterParticles) this.particles.release(p);
    this.waterParticles = [];
    this.ball.setAlpha(1);
    for (const s of this.shimmers) {
      tw.killTweensOf(s);
      s.setAlpha(0);
    }
  }

  /** Settle every decoration now (reduced-motion switch, pause, hole change). */
  settle(): void {
    this.cancelForAim();
    const tw = this.scene.tweens;
    for (const c of this.caps) {
      tw.killTweensOf(c);
      c.setVisible(false);
    }
    for (const c of this.crowns) {
      tw.killTweensOf(c);
      c.setScale(c.getData("rest") as number).clearTint();
    }
    this.activeCrowns = [];
    this.particles.releaseAll();
    this.ball.resetShape();
  }

  destroy(): void {
    this.settle();
    this.unbindLevel();
    for (const c of this.caps) c.destroy();
    for (const r of this.rings) r.destroy();
    this.waterGhost.destroy();
    this.caps = [];
    this.rings = [];
  }
}
