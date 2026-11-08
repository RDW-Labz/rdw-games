import Phaser from "phaser";
import { bindBackKey, sceneFadeIn, sceneGo } from "./juice.js";
import { touchAudioUnlock } from "./theme.js";
import { getSave } from "./BootScene.js";
import { FREE_HOLE_COUNT, isHoleAvailable, nextHole } from "../progress.js";
import { loadLevels } from "../levels.js";
import { setSfxMuted } from "../audio/sfx.js";
import { setMusicMuted } from "../audio/music.js";
import { pauseMusicOnHide } from "../audio/music.js";
import { ScreenBackground } from "../ui/background.js";
import { clearSceneControls } from "../ui/controls.js";
import { bodyTextStyleUi, displayTextStyle } from "../ui/fonts.js";
import { iconButton } from "../ui/iconButton.js";
import { pillButton } from "../ui/pillButton.js";
import { bakeCanvasForScene, ensureUiTextures } from "../ui/textures.js";
import { TOKENS, cssColor } from "../ui/tokens.js";
import { MenuAmbient } from "./ambient/index.js";
import { rgb } from "./course/canvas.js";
import { markGlobalTexture } from "./textureCache.js";
import { isTraveling, pocketLayout, registerSceneBackground } from "./travel.js";
import {
  bindReducedMotionListener,
  reducedMotion,
  setReducedMotionPreference,
} from "../ui/motion.js";

const MENU_HERO_KEY = "menu-hero-island";
const MENU_HERO_W = 300;
const MENU_HERO_H = 160;

export class MenuScene extends Phaser.Scene {
  private bg!: ScreenBackground;
  private ambient?: MenuAmbient;
  private titleContainer!: Phaser.GameObjects.Container;
  private unbindMotion?: () => void;
  private titleTween?: Phaser.Tweens.Tween;
  private flagCloth?: Phaser.GameObjects.Image;
  private flagTween?: Phaser.Tweens.Tween;

  constructor() {
    super("Menu");
  }

  create(): void {
    clearSceneControls(this.scene.key);
    ensureUiTextures(this);
    this.bg = new ScreenBackground(this);
    registerSceneBackground(this, this.bg);
    sceneFadeIn(this);

    const save = getSave(this);
    setReducedMotionPreference(save.settings.reducedMotion);
    this.unbindMotion?.();
    this.unbindMotion = bindReducedMotionListener(() => this.applyMotionPolicy());

    const { T, A, G, CX } = pocketLayout();
    const holeCount = this.registry.get("holeCount") as number;
    const levels = loadLevels();
    setSfxMuted(!save.settings.sound);
    setMusicMuted(!save.settings.music);

    const settingsCx = 288 + TOKENS.component.icon.size / 2;
    const settingsCy = T + 8 + TOKENS.component.icon.size / 2;
    iconButton(this, settingsCx, settingsCy, "settings", () => sceneGo(this, "Settings"), "menu.settings");

    // Wordmark box (32, T+76, 260, 104): "Putt" then "Drop" one line (52) lower and 32 px right,
    // fixed -4 deg tilt about the box center.
    const wordmark = this.add.container(32 + 130, T + 76 + 52);
    wordmark.setAngle(-4);
    const logoStyle = displayTextStyle(TOKENS.type.logo.size, TOKENS.type.logo.weight, cssColor("text"));
    // Phaser text boxes carry ~14 px of font padding above the caps; offset so the visible caps
    // start at the box top and the "p" descender clears the tagline at T+184.
    const putt = this.add.text(-130, -52 - 14, "Putt", logoStyle).setOrigin(0, 0).setPadding(0, 0, 0, 18);
    // Bottom padding: Fredoka's "p" descender extends below the measured text box and was clipped.
    const drop = this.add.text(-130 + 32, -14, "Drop", logoStyle).setOrigin(0, 0).setPadding(0, 0, 0, 18);
    wordmark.add([putt, drop]);
    wordmark.setDepth(TOKENS.depth.hud);
    this.titleContainer = wordmark;

    this.add
      .text(32, T + 184, "A tiny course. A happy place.", bodyTextStyleUi(TOKENS.type.body.size, TOKENS.type.body.weight, cssColor("textMuted")))
      .setDepth(TOKENS.depth.hud);

    const heroTop = T + 222;
    const heroH = Math.max(0, A - 172 - heroTop);
    const islandY = heroH > 0 ? (heroTop + A - 172) / 2 : heroTop;
    this.ambient = new MenuAmbient(this, this.bg.layers.mid, islandY);
    this.buildMenuHero(CX, islandY);

    this.applyMotionPolicy();

    const hasProgress = save.holes.some((h) => h.attempts > 0 || h.best !== undefined);
    const nextIdx = nextHole(save, holeCount);
    let allFinished = true;
    for (let i = 0; i < holeCount; i++) {
      if (!isHoleAvailable(i, save.unlocked)) continue;
      if (save.holes[i]?.best === undefined) {
        allFinished = false;
        break;
      }
    }
    const showAllFinished = hasProgress && allFinished;
    let playLabel = "Play";
    if (hasProgress && !showAllFinished) {
      playLabel = `Continue — Hole ${nextIdx + 1}`;
    } else if (showAllFinished) {
      playLabel = "Play again";
    }

    let statusLine = "Start with hole 1";
    if (hasProgress && !showAllFinished) {
      const name = levels[nextIdx]?.name ?? `Hole ${nextIdx + 1}`;
      statusLine = `Hole ${nextIdx + 1} · ${name}`;
    } else if (showAllFinished) {
      statusLine = "All available holes finished";
    }

    const primaryTop = A - 156;
    const holesTop = A - 84;
    const primaryCy = primaryTop + TOKENS.component.pill.primary.h / 2;
    const holesCy = holesTop + TOKENS.component.pill.secondary.h / 2;

    this.add
      .text(G, primaryTop - 28, statusLine, bodyTextStyleUi(TOKENS.type.caption.size, TOKENS.type.caption.weight, cssColor("textMuted")))
      .setDepth(TOKENS.depth.hud);

    pillButton(
      this,
      CX,
      primaryCy,
      playLabel,
      () => {
        sceneGo(this, "Play", { holeIndex: nextIdx });
      },
      { variant: "primary", id: "menu.play" }
    );

    pillButton(
      this,
      CX,
      holesCy,
      "Holes",
      () => sceneGo(this, "LevelSelect"),
      { variant: "secondary", id: "menu.holes" }
    );

    const caption =
      holeCount > FREE_HOLE_COUNT
        ? "12 free holes · One unlock for the rest"
        : "12 free holes · Play offline";
    this.add
      .text(G, A - 20, caption, bodyTextStyleUi(TOKENS.type.caption.size, TOKENS.type.caption.weight, cssColor("textMuted")))
      .setOrigin(0, 0)
      .setDepth(TOKENS.depth.hud);

    this.input.once("pointerdown", () => touchAudioUnlock());
    bindBackKey(this, () => {}, true);

    const onVisibility = (): void => {
      pauseMusicOnHide(document.hidden);
      this.ambient?.setPaused(document.hidden);
    };
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);

    this.events.once("shutdown", () => {
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
      clearSceneControls(this.scene.key);
      this.titleTween?.remove();
      this.titleTween = undefined;
      this.flagTween?.remove();
      this.flagTween = undefined;
      this.flagCloth = undefined;
      this.ambient?.destroy();
      this.ambient = undefined;
      this.unbindMotion?.();
      this.unbindMotion = undefined;
    });
  }

  /** Effective reduced motion (saved toggle OR OS) decides idle motion; re-run on OS change. */
  private buildMenuHero(cx: number, islandY: number): void {
    ensureMenuHeroTexture(this);
    const hero = this.add
      .image(cx, islandY, MENU_HERO_KEY)
      .setDisplaySize(MENU_HERO_W, MENU_HERO_H)
      .setDepth(TOKENS.depth.island);
    this.bg.layers.mid.add(hero);

    // Flag cloth (baked once); pole is in the island texture. Gentle flagWiggle when motion allowed.
    const clothKey = "menu-hero-flag";
    if (!this.textures.exists(clothKey)) {
      bakeCanvasForScene(this, clothKey, 28, 18, (ctx) => {
        const g = ctx.createLinearGradient(0, 0, 28, 18);
        g.addColorStop(0, rgb(TOKENS.color.flag));
        g.addColorStop(1, rgb(TOKENS.color.flagFold));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(2, 2);
        ctx.lineTo(26, 6);
        ctx.lineTo(24, 16);
        ctx.lineTo(2, 12);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = rgb(TOKENS.color.flagFold, 0.5);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(10, 4);
        ctx.lineTo(10, 14);
        ctx.stroke();
      });
      markGlobalTexture(clothKey);
    }
    const flagX = cx + 38;
    const flagY = islandY - 18;
    this.flagCloth = this.add.image(flagX, flagY, clothKey).setOrigin(0, 0).setDepth(TOKENS.depth.flag);
    this.bg.layers.mid.add(this.flagCloth);
  }

  private applyMotionPolicy(): void {
    const reduce = reducedMotion();
    this.ambient?.setReduced(reduce);
    this.flagTween?.remove();
    this.flagTween = undefined;
    if (this.flagCloth) this.flagCloth.setAngle(0);
    if (reduce) {
      this.titleTween?.remove();
      this.titleTween = undefined;
      this.titleContainer.setAlpha(1);
    } else if (!this.titleTween) {
      // titleBreathing: 4000 ms full cycle, alpha 0.94 -> 1 -> 0.94.
      this.titleTween = this.tweens.add({
        targets: this.titleContainer,
        alpha: { from: 0.94, to: 1 },
        duration: 2000,
        yoyo: true,
        repeat: -1,
        ease: TOKENS.motion.ease.ambient,
      });
    }
    if (!reduce && this.flagCloth) {
      this.flagTween = this.tweens.add({
        targets: this.flagCloth,
        angle: { from: -2, to: 2 },
        duration: 2000,
        yoyo: true,
        repeat: -1,
        ease: TOKENS.motion.ease.ambient,
      });
    }
  }

  update(_t: number, dt: number): void {
    if (!this.scene.isActive()) return;
    if (!isTraveling(this) && !reducedMotion()) this.bg.update(dt / 1000);
  }
}

function ensureMenuHeroTexture(scene: Phaser.Scene): void {
  if (scene.textures.exists(MENU_HERO_KEY)) return;
  const C = TOKENS.color;
  bakeCanvasForScene(scene, MENU_HERO_KEY, MENU_HERO_W, MENU_HERO_H, (ctx) => {
    const sx = MENU_HERO_W / 390;
    const sy = MENU_HERO_H / 280;
    const t = (x: number, y: number): [number, number] => [x * sx, y * sy];

    ctx.save();
    ctx.translate(MENU_HERO_W / 2 - 195 * sx, MENU_HERO_H / 2 - 140 * sy);

    const shadow = t(199, 224);
    ctx.fillStyle = rgb(C.shadow, 0.14);
    ctx.beginPath();
    ctx.ellipse(shadow[0], shadow[1], 144 * sx, 22 * sy, 0, 0, Math.PI * 2);
    ctx.fill();

    const clay = new Path2D(
      "M50 148Q54 75 153 91Q226 35 312 110Q361 158 306 211Q273 253 183 227Q72 239 50 178z"
    );
    ctx.save();
    ctx.scale(sx, sy);
    ctx.fillStyle = rgb(C.turfEdge, 0.55);
    ctx.fill(clay);
    ctx.restore();

    const grass = new Path2D(
      "M65 137Q64 78 158 95Q226 42 301 108Q342 147 294 190Q271 225 184 203Q80 216 65 163z"
    );
    ctx.save();
    ctx.scale(sx, sy);
    const g = ctx.createLinearGradient(0, 80, 0, 220);
    g.addColorStop(0, rgb(C.turfTop));
    g.addColorStop(1, rgb(C.turfBottom));
    ctx.fillStyle = g;
    ctx.fill(grass);
    ctx.strokeStyle = rgb(C.rail);
    ctx.lineWidth = 4 * sx;
    ctx.stroke(grass);
    ctx.clip(grass);
    ctx.save();
    ctx.rotate((-24 * Math.PI) / 180);
    ctx.fillStyle = rgb(C.highlight, 0.065);
    for (let x = -200; x < 500; x += 32) ctx.fillRect(x, -80, 16, 400);
    ctx.restore();
    ctx.restore();

    const pond = t(240, 145);
    ctx.fillStyle = rgb(C.waterTop, 0.85);
    ctx.beginPath();
    ctx.ellipse(pond[0], pond[1], 34 * sx, 22 * sy, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = rgb(C.rail);
    ctx.lineWidth = 4 * sx;
    ctx.stroke();

    const cup = t(240, 145);
    ctx.fillStyle = rgb(C.cupDeep);
    ctx.beginPath();
    ctx.ellipse(cup[0], cup[1], 11 * sx, 7 * sy, 0, 0, Math.PI * 2);
    ctx.fill();
    const pole = t(240, 145);
    ctx.strokeStyle = rgb(C.trunk);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pole[0], pole[1]);
    ctx.lineTo(pole[0], pole[1] - 38 * sy);
    ctx.stroke();

    const ball = t(105, 166);
    ctx.fillStyle = rgb(C.text, 0.22);
    ctx.beginPath();
    ctx.ellipse(ball[0], ball[1] + 10 * sy, 14 * sx, 5 * sy, 0, 0, Math.PI * 2);
    ctx.fill();
    const ballGrad = ctx.createRadialGradient(ball[0] - 4, ball[1] - 4, 2, ball[0], ball[1], 14 * sx);
    ballGrad.addColorStop(0, rgb(C.ballLight));
    ballGrad.addColorStop(0.6, rgb(C.ballMid));
    ballGrad.addColorStop(1, rgb(C.ballShade));
    ctx.fillStyle = ballGrad;
    ctx.beginPath();
    ctx.arc(ball[0], ball[1], 10 * sx, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  });
  markGlobalTexture(MENU_HERO_KEY);
}
