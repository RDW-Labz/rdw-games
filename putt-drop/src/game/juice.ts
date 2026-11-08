import Phaser from "phaser";
import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";
import { COLORS, DEPTH } from "./theme.js";
import { hapticImpact } from "../platform/haptics.js";
import {
  sfxBumperPop,
  sfxHoledJingle,
  sfxLipOut,
  sfxSand,
  sfxSplash,
  sfxWallTick,
} from "../audio/sfx.js";
import { duckMusic } from "../audio/music.js";

const HARD_WALL_SPEED = 320;

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: number;
}

interface TrailDot {
  x: number;
  y: number;
  life: number;
}

export interface JuiceSettings {
  shake: boolean;
  vibration: boolean;
}

export class JuiceSystem {
  private scene: Phaser.Scene;
  private sparks: Spark[] = [];
  private trail: TrailDot[] = [];
  private settings: JuiceSettings;
  private ballSquash = 1;
  private ballSquashTarget = 1;
  private bumperPulse = new Map<number, number>();
  private floating: Phaser.GameObjects.Text[] = [];
  private trailPool: Phaser.GameObjects.Image[] = [];
  private sparkPool: Phaser.GameObjects.Image[] = [];

  constructor(scene: Phaser.Scene, settings: JuiceSettings) {
    this.scene = scene;
    this.settings = settings;
  }

  setSettings(s: JuiceSettings): void {
    this.settings = s;
  }

  update(dt: number, ballX: number, ballY: number, ballMoving: boolean): { squashX: number; squashY: number } {
    if (ballMoving) {
      if (this.trail.length < 12) {
        this.trail.push({ x: ballX, y: ballY, life: 1 });
      } else {
        const d = this.trail.shift()!;
        d.x = ballX;
        d.y = ballY;
        d.life = 1;
        this.trail.push(d);
      }
    }
    for (let i = this.trail.length - 1; i >= 0; i--) {
      this.trail[i].life -= dt * 2.5;
      if (this.trail[i].life <= 0) this.trail.splice(i, 1);
    }
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vy += 420 * dt;
      s.life -= dt;
      if (s.life <= 0) this.sparks.splice(i, 1);
    }
    for (const [k, v] of this.bumperPulse) {
      const nv = v - dt * 3;
      if (nv <= 0) this.bumperPulse.delete(k);
      else this.bumperPulse.set(k, nv);
    }
    this.ballSquash += (this.ballSquashTarget - this.ballSquash) * Math.min(1, dt * 14);
    if (Math.abs(this.ballSquash - 1) < 0.01) {
      this.ballSquashTarget = 1;
      this.ballSquash = 1;
    }
    this.syncFxSprites();
    const sx = this.ballSquash;
    const sy = 2 - this.ballSquash;
    return { squashX: sx, squashY: sy };
  }

  getBumperScale(index: number): number {
    const t = this.bumperPulse.get(index);
    if (!t) return 1;
    return 1 + Math.sin(t * Math.PI) * 0.22;
  }

  onWallHit(x: number, y: number, speed: number): void {
    sfxWallTick(speed);
    const n = Math.min(8, 2 + Math.floor(speed / 120));
    const angle = Math.random() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      const a = angle + (i / n) * Math.PI * 2;
      this.sparks.push({
        x,
        y,
        vx: Math.cos(a) * (80 + speed * 0.15),
        vy: Math.sin(a) * (80 + speed * 0.15),
        life: 0.25 + Math.random() * 0.15,
        color: COLORS.wall,
      });
    }
    if (speed >= HARD_WALL_SPEED && this.settings.shake) {
      this.scene.cameras.main.shake(120, 0.004 + speed * 0.000008);
    }
    if (speed >= HARD_WALL_SPEED) {
      this.ballSquashTarget = 0.65;
    }
  }

  onBumperHit(x: number, y: number, index: number): void {
    sfxBumperPop();
    hapticImpact(this.settings.vibration, "medium");
    this.bumperPulse.set(index, 1);
    this.ringBurst(x, y, COLORS.lime);
  }

  ringBurst(x: number, y: number, color: number): void {
    const ring = this.scene.add.circle(x, y, 8, color, 0.35).setDepth(DEPTH.fx);
    this.scene.tweens.add({
      targets: ring,
      scaleX: 5,
      scaleY: 5,
      alpha: 0,
      duration: 280,
      ease: "Cubic.easeOut",
      onComplete: () => ring.destroy(),
    });
  }

  onSandEnter(x: number, y: number): void {
    sfxSand();
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * Math.PI * 2;
      this.sparks.push({
        x,
        y,
        vx: Math.cos(a) * 40,
        vy: Math.sin(a) * 40,
        life: 0.35,
        color: COLORS.sand,
      });
    }
  }

  onWater(x: number, y: number): void {
    sfxSplash();
    this.ringBurst(x, y, COLORS.water);
    this.floatText(x, y - 20, "+1", "#7ec8ff");
  }

  onLipOut(): void {
    sfxLipOut();
    if (this.settings.shake) {
      this.scene.cameras.main.shake(90, 0.003);
    }
  }

  onHoled(x: number, y: number): void {
    sfxHoledJingle();
    duckMusic(true);
    hapticImpact(this.settings.vibration, "heavy");
    this.ringBurst(x, y, COLORS.lime);
    this.confetti(x, y);
    setTimeout(() => duckMusic(false), 1200);
  }

  floatText(x: number, y: number, text: string, color: string): void {
    const t = this.scene.add
      .text(x, y, text, { fontFamily: "system-ui", fontSize: "20px", color })
      .setOrigin(0.5)
      .setDepth(DEPTH.fx);
    this.floating.push(t);
    this.scene.tweens.add({
      targets: t,
      y: y - 36,
      alpha: 0,
      duration: 900,
      ease: "Cubic.easeOut",
      onComplete: () => {
        t.destroy();
        const i = this.floating.indexOf(t);
        if (i >= 0) this.floating.splice(i, 1);
      },
    });
  }

  private confetti(cx: number, cy: number): void {
    const colors = [COLORS.lime, COLORS.magenta, COLORS.wall, COLORS.amber];
    for (let i = 0; i < 24; i++) {
      const c = colors[i % colors.length];
      const dot = this.scene.add.rectangle(cx, cy, 4, 7, c).setDepth(DEPTH.fx);
      const a = Math.random() * Math.PI * 2;
      const dist = 40 + Math.random() * 80;
      this.scene.tweens.add({
        targets: dot,
        x: cx + Math.cos(a) * dist,
        y: cy + Math.sin(a) * dist + 30,
        angle: Math.random() * 360,
        alpha: 0,
        duration: 700 + Math.random() * 400,
        ease: "Cubic.easeOut",
        onComplete: () => dot.destroy(),
      });
    }
  }

  clear(): void {
    this.sparks.length = 0;
    this.trail.length = 0;
    for (const s of this.trailPool) s.setVisible(false);
    for (const s of this.sparkPool) s.setVisible(false);
    for (const t of this.floating) t.destroy();
    this.floating.length = 0;
  }

  private borrowTrailSprite(): Phaser.GameObjects.Image {
    const free = this.trailPool.find((s) => !s.visible);
    if (free) return free;
    const img = this.scene.add
      .image(0, 0, "particle-dot")
      .setTint(COLORS.ball)
      .setDepth(DEPTH.fx);
    this.trailPool.push(img);
    return img;
  }

  private borrowSparkSprite(): Phaser.GameObjects.Image {
    const free = this.sparkPool.find((s) => !s.visible);
    if (free) return free;
    const img = this.scene.add.image(0, 0, "particle-dot").setDepth(DEPTH.fx);
    this.sparkPool.push(img);
    return img;
  }

  private syncFxSprites(): void {
    let ti = 0;
    for (const d of this.trail) {
      const s = this.borrowTrailSprite();
      s.setVisible(true);
      s.setPosition(d.x, d.y);
      s.setAlpha(d.life * 0.35);
      s.setScale(0.25 * d.life);
      ti++;
    }
    for (let i = ti; i < this.trailPool.length; i++) this.trailPool[i].setVisible(false);

    let si = 0;
    for (const sp of this.sparks) {
      const s = this.borrowSparkSprite();
      s.setVisible(true);
      s.setPosition(sp.x, sp.y);
      s.setTint(sp.color);
      s.setAlpha(Math.min(1, sp.life * 2));
      s.setScale(0.12 + sp.life * 0.12);
      si++;
    }
    for (let i = si; i < this.sparkPool.length; i++) this.sparkPool[i].setVisible(false);
  }
}

import { beginSceneTravel, pocketLayout, sceneFadeIn as playArrival } from "./travel.js";
import { showToast, type ToastSeverity } from "../ui/toast.js";
import { TOKENS } from "../ui/tokens.js";
import { reducedMotion } from "../ui/motion.js";

export function sceneFadeIn(scene: Phaser.Scene): void {
  playArrival(scene);
}

export function sceneGo(scene: Phaser.Scene, key: string, data?: object): void {
  const payload = data ? { ...data } : {};
  if ("nav" in payload) delete (payload as { nav?: string }).nav;
  beginSceneTravel(scene, key);
  scene.scene.start(key, payload);
}

export function bindBackKey(scene: Phaser.Scene, onBack: () => void, allowOnMenu = false): void {
  const handler = (): void => {
    if (!allowOnMenu && scene.scene.key === "Menu") return;
    onBack();
  };
  scene.input.keyboard?.on("keydown-ESC", handler);
  scene.input.keyboard?.on("keydown-BACK", handler);
  if (Capacitor.getPlatform() === "android") {
    void App.addListener("backButton", handler).then((handle) => {
      scene.events.once("shutdown", () => void handle.remove());
    });
  }
}

const activeToasts = new WeakMap<Phaser.Scene, Phaser.GameObjects.Container>();

/**
 * screens.md section 12: one toast at a time, placed above the screen's first footer action
 * (toastY = max(Y, footerTop - 12 - toastH)) so it never covers the footer buttons.
 */
export function showScreenToast(
  scene: Phaser.Scene,
  message: string,
  severity: ToastSeverity,
  footerTop: number,
  onRetry?: () => void
): Phaser.GameObjects.Container {
  activeToasts.get(scene)?.destroy();
  const root = showToast(scene, message, severity, onRetry);
  const h = root.height;
  const top = Math.max(pocketLayout().Y, footerTop - 12 - h);
  const restY = top + h / 2;
  scene.tweens.killTweensOf(root);
  root.setPosition(root.x, restY);
  root.setAlpha(0.7);
  scene.tweens.add({
    targets: root,
    alpha: 1,
    duration: reducedMotion() ? TOKENS.motion.duration.instant : TOKENS.motion.duration.quick,
    ease: TOKENS.motion.ease.enter,
  });
  activeToasts.set(scene, root);
  if (import.meta.env.MODE !== "production") {
    scene.game.registry.set("pdLastToast", { message, at: Date.now() });
  }
  return root;
}
