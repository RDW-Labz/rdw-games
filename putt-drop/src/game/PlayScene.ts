import Phaser from "phaser";
import { loadLevels } from "../levels.js";
import { BALL_R, DT, createSim, simulateShot, trimPathByTime } from "../sim/physics.js";
import type { Level, Shot, SimEvent, Vec2 } from "../sim/types.js";
import { bakeLevelStatic } from "./render.js";
import { R } from "./display.js";
import { releaseSceneTextures, releaseTexture } from "./textureCache.js";
import { DEPTH, powerColor, safeTopInset, touchAudioUnlock } from "./theme.js";
import { clearSceneControls, registerControl, unregisterIdPrefix } from "../ui/controls.js";
import { bodyTextStyleUi, displayTextStyle } from "../ui/fonts.js";
import { iconButton } from "../ui/iconButton.js";
import { openBottomSheet } from "../ui/bottomSheet.js";
import { panelImage } from "../ui/panel.js";
import { pillButton } from "../ui/pillButton.js";
import { starRow } from "../ui/starRow.js";
import { ScreenBackground } from "../ui/background.js";
import { bakePanelTexture, ensureUiTextures, pillTexture } from "../ui/textures.js";
import { TOKENS, cssColor } from "../ui/tokens.js";
import {
  FREE_HOLE_COUNT,
  markFirstPuttTutorialSeen,
  onHoleAttemptStart,
  onHoleComplete,
  personalBestOutcome,
  previewDurationSeconds,
  rating,
  scoreLabel,
  setAssistEnabled,
  shouldOfferAssist,
  shouldShowFirstPuttHint,
  strokesLabel,
} from "../progress.js";
import { bindBackKey, sceneFadeIn, sceneGo } from "./juice.js";
import { pocketLayout } from "./travel.js";
import { getSave, updateSave } from "./BootScene.js";
import { hapticImpact } from "../platform/haptics.js";
import { sfxPutt } from "../audio/sfx.js";
import { bindReducedMotionListener, reducedMotion, setReducedMotionPreference } from "../ui/motion.js";
import { courseFrame, powerPanelTop, uiToWorld, worldToUi, type CourseFrame } from "./course/frame.js";
import { chip } from "../ui/chip.js";
import { CourseWorld, ParticlePool } from "./course/world.js";
import { CourseBall } from "./course/ball.js";
import { CourseMovers } from "./course/movers.js";
import { CourseCupFx } from "./course/cup.js";
import { distToSegment, pointInPoly } from "./course/bakeStatic.js";
import { CourseReactions, type WallContact } from "./fx/reactions.js";
import { AimFx } from "./fx/aim.js";
import { HoleCelebration } from "./fx/celebration.js";
import { FirstPuttHint } from "./hint.js";
import { WorldMechanicHint } from "./fx/worldMechanicHint.js";
import type { SaveData } from "../progress.js";

/** Drag-power scale and minimum shot distance, both in WORLD units (screens.md section 6). */
const DRAG_POWER_SCALE = 160;
const MIN_DRAG = 8;

interface PlayData {
  holeIndex?: number;
}

type Phase = "play" | "card";

export class PlayScene extends Phaser.Scene {
  /** Test-only hooks; attached only outside production builds (see constructor). */
  declare isPausedForTest: () => boolean;
  declare openPauseForTest: () => void;
  declare forceResultForTest: (strokes: number) => void;

  private levels: Level[] = [];
  private holeIndex = 0;
  private strokeCount = 0;
  private frame: CourseFrame = courseFrame(
    TOKENS.layout.safeTop,
    TOKENS.layout.safeBottom,
    TOKENS.layout.logicalH
  );
  private world!: CourseWorld;
  private particles!: ParticlePool;
  private courseBall!: CourseBall;
  private movers: CourseMovers | null = null;
  private cupFx!: CourseCupFx;
  private reactions!: CourseReactions;
  private aimFx!: AimFx;
  private celebration!: HoleCelebration;
  private hint!: FirstPuttHint;
  private worldHint!: WorldMechanicHint;
  private hudHoleText!: Phaser.GameObjects.Text;
  private hudNameText!: Phaser.GameObjects.Text;
  private hudStrokesText!: Phaser.GameObjects.Text;
  private hudParText!: Phaser.GameObjects.Text;
  private powerHintText!: Phaser.GameObjects.Text;
  private powerPctText!: Phaser.GameObjects.Text;
  private powerMeterGfx!: Phaser.GameObjects.Graphics;
  private powerSig = "";
  private pauseClose: (() => void) | null = null;
  private sim = createSim(emptyLevel());
  private accum = 0;
  private aiming = false;
  private dragStart = new Phaser.Math.Vector2();
  private dragEnd = new Phaser.Math.Vector2();
  private aimPreview: Vec2[] = [];
  private phase: Phase = "play";
  private levelImage: Phaser.GameObjects.Image | null = null;
  private levelKey = "";
  private lastPowerStep = -1;
  private resultRoot: Phaser.GameObjects.Container | null = null;
  private resultFinish: (() => void) | null = null;
  private resultShownAt = 0;
  private assistBtn: Phaser.GameObjects.Container | null = null;
  private processedEvents = 0;
  private attemptStarted = false;
  private lastAimAngle = 0;
  private lastAimPower = -1;
  private lastAimPreviewAt = 0;
  private waterMsgUntil = 0;
  private slopeEntered: boolean[] = [];
  private unbindMotion: (() => void) | null = null;
  private reduced = false;
  private reducedNow = false;
  private reducedCheckedAt = -1e9;

  constructor() {
    super("Play");
    // Dead-code eliminated from production builds (MODE is a build-time constant).
    if (import.meta.env.MODE !== "production") {
      this.isPausedForTest = () => this.pauseClose !== null;
      this.openPauseForTest = () => {
        if (this.scene.isActive()) this.showPauseSheet();
      };
      this.forceResultForTest = (strokes: number) => {
        if (!this.scene.isActive()) return;
        this.hidePauseSheet();
        this.clearResult();
        this.phase = "play";
        this.strokeCount = strokes;
        this.showResultCard(false);
      };
    }
  }

  getStrokeCount(): number {
    return this.strokeCount;
  }

  init(data: PlayData): void {
    this.holeIndex = data.holeIndex ?? 0;
    this.phase = "play";
    this.strokeCount = 0;
    this.attemptStarted = false;
    this.processedEvents = 0;
    this.levelKey = "";
    this.levelImage = null;
    this.pauseClose = null;
    this.resultRoot = null;
    this.assistBtn = null;
    this.aiming = false;
    this.powerSig = "";
  }

  create(): void {
    clearSceneControls(this.scene.key);
    ensureUiTextures(this);
    sceneFadeIn(this);
    const { T, B, H } = pocketLayout();
    this.frame = courseFrame(T, B, H);

    const save = getSave(this);
    setReducedMotionPreference(save.settings.reducedMotion);
    this.unbindMotion = bindReducedMotionListener();
    this.reduced = reducedMotion();
    this.reducedNow = this.reduced;
    this.reducedCheckedAt = -1e9;

    // Result card faces are global, cached textures: bake them now so the reward frame never bakes.
    bakePanelTexture(this, TOKENS.component.result.w, TOKENS.component.result.h, "sheet");
    pillTexture(this, "primary", TOKENS.component.result.w - TOKENS.component.result.pad * 2, 56);
    pillTexture(this, "secondary", 142, 56);

    this.levels = loadLevels();
    new ScreenBackground(this);
    this.world = new CourseWorld(this, this.frame);
    this.particles = new ParticlePool(this.world);
    this.courseBall = new CourseBall(this, this.world);
    this.cupFx = new CourseCupFx(this, this.world);
    this.reactions = new CourseReactions(this, this.world, this.cupFx, this.courseBall, this.particles);
    this.aimFx = new AimFx(this, this.frame);
    this.celebration = new HoleCelebration(this, this.world, this.cupFx, this.courseBall, this.particles);
    this.hint = new FirstPuttHint(this, this.frame);
    this.worldHint = new WorldMechanicHint(this, this.frame);

    this.buildHud();
    this.buildPowerPanel();
    this.bindInput();

    this.loadHole(this.holeIndex);
    bindBackKey(this, () => {
      if (this.phase === "card") this.leave(() => this.goHoles());
      else sceneGo(this, "Menu", { nav: "back" });
    });
    this.events.once("shutdown", () => this.teardown());

    if (import.meta.env.MODE !== "production") attachCourseProbe(this);
  }

  private teardown(): void {
    clearSceneControls(this.scene.key);
    this.unbindMotion?.();
    this.unbindMotion = null;
    this.hint.cancel();
    this.worldHint.cancel();
    this.celebration.destroy();
    this.reactions.destroy();
    this.aimFx.destroy();
    this.movers?.destroy();
    this.movers = null;
    this.cupFx.destroy();
    this.courseBall.destroy();
    this.particles.destroy();
    this.world.destroy();
    if (this.levelKey) releaseTexture(this, this.levelKey);
    releaseSceneTextures(this);
    this.levelKey = "";
    this.levelImage = null;
  }

  // ---------------------------------------------------------------- input

  private bindInput(): void {
    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
      touchAudioUnlock();
      if (this.pauseClose || this.phase !== "play") return;
      const ux = p.x / R;
      const uy = p.y / R;
      if (uy < safeTopInset() + 64) return;
      if (this.assistBtn?.visible) {
        const b = this.assistBtn.getBounds();
        if (b.contains(ux, uy)) return;
      }
      if (!this.sim.atRest || this.sim.holed) return;
      if (this.worldHint.isVisible()) {
        this.worldHint.dismiss();
        return;
      }
      // Not shown yet: aiming cancels it without marking it seen, so it plays on the next visit.
      this.worldHint.cancel();
      this.hint.cancel();
      this.reactions.cancelForAim();
      this.waterMsgUntil = 0;
      this.aiming = true;
      this.dragStart.set(ux, uy);
      this.dragEnd.set(ux, uy);
      this.aimPreview = [];
      this.lastPowerStep = -1;
      this.lastAimPower = -1;
      this.aimFx.begin();
      this.assistBtn?.setVisible(false);
      this.redrawAim();
      this.refreshPowerPanel();
    });

    this.input.on("pointermove", (p: Phaser.Input.Pointer) => {
      if (!this.aiming) return;
      this.dragEnd.set(p.x / R, p.y / R);
      this.updateAimPreview();
      this.tickPowerHaptics();
      this.redrawAim();
      this.refreshPowerPanel();
    });

    const release = (p: Phaser.Input.Pointer): void => {
      if (!this.aiming) return;
      this.aiming = false;
      this.dragEnd.set(p.x / R, p.y / R);
      const fired = this.fireShot();
      this.aimPreview = [];
      if (fired) this.aimFx.release();
      else this.aimFx.cancel();
      this.lastPowerStep = -1;
      this.refreshAssistUi();
      this.refreshPowerPanel();
    };
    this.input.on("pointerup", release);
    this.input.on("pointerupoutside", release);
    this.input.on("gameout", () => {
      /* capture is kept outside the canvas until release */
    });
  }

  /** Cancels a partial aim without a stroke (pause, hide, pointer cancel). */
  private cancelAim(): void {
    if (!this.aiming) return;
    this.aiming = false;
    this.aimPreview = [];
    this.aimFx.cancel();
    this.refreshAssistUi();
    this.refreshPowerPanel();
  }

  /** Drag vector (shot direction) in world units: (pointer-down - current) / q. */
  private dragWorld(): [number, number] {
    const q = this.frame.q;
    return [(this.dragStart.x - this.dragEnd.x) / q, (this.dragStart.y - this.dragEnd.y) / q];
  }

  private currentDragPower(): number {
    const [dx, dy] = this.dragWorld();
    return Math.min(1, Math.hypot(dx, dy) / DRAG_POWER_SCALE);
  }

  private redrawAim(): void {
    this.aimFx.draw({
      ballX: this.sim.ball.x,
      ballY: this.sim.ball.y,
      dragX: this.dragStart.x - this.dragEnd.x,
      dragY: this.dragStart.y - this.dragEnd.y,
      power: this.currentDragPower(),
      path: this.aimPreview,
    });
  }

  private fireShot(): boolean {
    const [dx, dy] = this.dragWorld();
    const len = Math.hypot(dx, dy);
    if (len < MIN_DRAG) return false;
    const angle = Math.atan2(dy, dx);
    const power = Math.min(1, len / DRAG_POWER_SCALE);
    this.strokeCount++;
    this.updateHud();
    const save = getSave(this);
    if (!save.firstPuttTutorialSeen) {
      void updateSave(this, markFirstPuttTutorialSeen(save));
    }
    this.hint.cancel();
    this.worldHint.cancel();
    this.slopeEntered = this.currentLevel().slopes.map(() => false);
    this.sim.shoot({ angle, power });
    this.processedEvents = 0;
    this.accum = 0;
    sfxPutt();
    this.reactions.onPutt(this.sim.ball.x, this.sim.ball.y, angle);
    return true;
  }

  private updateAimPreview(): void {
    const level = this.currentLevel();
    const [dx, dy] = this.dragWorld();
    const len = Math.hypot(dx, dy);
    if (len < 4) {
      this.aimPreview = [];
      return;
    }
    const angle = Math.atan2(dy, dx);
    const power = Math.min(1, len / DRAG_POWER_SCALE);
    const now = this.time.now;
    if (
      Math.abs(angle - this.lastAimAngle) < (0.5 * Math.PI) / 180 &&
      Math.abs(power - this.lastAimPower) < 0.01 &&
      now - this.lastAimPreviewAt < 1000 / 30
    ) {
      return;
    }
    this.lastAimAngle = angle;
    this.lastAimPower = power;
    this.lastAimPreviewAt = now;
    const shot: Shot = { angle, power };
    const result = simulateShot(level, this.sim.ball, shot, { recordPath: true });
    this.aimPreview = trimPathByTime(result.path ?? [], result.steps, previewDurationSeconds(this.assistActive()));
  }

  private tickPowerHaptics(): void {
    const step = Math.floor(this.currentDragPower() * 10);
    if (step !== this.lastPowerStep && step > 0) {
      this.lastPowerStep = step;
      hapticImpact(getSave(this).settings.vibration, "light");
    }
  }

  // ---------------------------------------------------------------- frame loop

  update(_time: number, delta: number): void {
    if (!this.scene.isActive()) return;
    // Effective motion policy (OS media query) is polled at 4 Hz, not per frame (matchMedia is not free).
    if (this.time.now - this.reducedCheckedAt > 250) {
      this.reducedCheckedAt = this.time.now;
      this.reducedNow = reducedMotion();
    }
    const reduce = this.reducedNow;
    if (reduce !== this.reduced) {
      this.reduced = reduce;
      // Switched mid-effect: settle all decoration now, keep simulation and input state.
      if (reduce) {
        this.reactions.settle();
        if (this.phase === "card") this.resultFinish?.();
      }
    }
    const save = getSave(this);
    this.reactions.setVibration(save.settings.vibration);
    this.aimFx.setColorblind(save.settings.colorblindAim);

    if (this.phase !== "play" || this.pauseClose) {
      if (this.time.now >= this.waterMsgUntil && this.waterMsgUntil > 0) this.refreshPowerPanel();
      return;
    }

    if (!this.sim.atRest && !this.sim.holed) {
      const level = this.currentLevel();
      const fromX = this.sim.ball.x;
      const fromY = this.sim.ball.y;
      this.accum += Math.min(delta, 100) / 1000;
      while (this.accum >= DT) {
        this.accum -= DT;
        const preX = this.sim.ball.x;
        const preY = this.sim.ball.y;
        const preVx = this.sim.vx;
        const preVy = this.sim.vy;
        this.sim.step();
        this.processSimEvents(level, preX, preY, preVx, preVy);
        if (!this.sim.atRest && !this.sim.holed) this.checkSlopeEntry(level);
        if (this.sim.atRest || this.sim.holed) {
          this.accum = 0;
          break;
        }
      }
      this.courseBall.integrateRoll(this.sim.ball.x - fromX, this.sim.ball.y - fromY, reduce);
      if (this.sim.holed) {
        this.courseBall.setPosition(level.cup[0], level.cup[1]);
        this.beginHoled();
        return;
      }
      this.courseBall.setPosition(this.sim.ball.x, this.sim.ball.y);
      if (this.sim.atRest) {
        this.refreshAssistUi();
      }
      this.refreshPowerPanel();
    } else if (this.waterMsgUntil > 0 && this.time.now >= this.waterMsgUntil) {
      this.waterMsgUntil = 0;
      this.refreshPowerPanel();
    }
    this.movers?.sync(this.sim.ball.t);
  }

  private processSimEvents(level: Level, preX: number, preY: number, preVx: number, preVy: number): void {
    const ev = this.sim.events;
    while (this.processedEvents < ev.length) {
      this.handleEvent(ev[this.processedEvents++], level, preX, preY, preVx, preVy);
    }
  }

  private handleEvent(e: SimEvent, level: Level, preX: number, preY: number, preVx: number, preVy: number): void {
    const bx = this.sim.ball.x;
    const by = this.sim.ball.y;
    switch (e.type) {
      case "wall-hit":
        this.reactions.onWallHit(wallContact(level, preX, preY, bx, by), e.speed);
        break;
      case "bumper-hit": {
        const idx = bumperContact(level, bx, by);
        if (idx >= 0) this.reactions.onBumperHit(idx);
        break;
      }
      case "sand-enter":
        this.reactions.onSandEnter(bx, by);
        break;
      case "water": {
        // One penalty, once; the sim has already reset the ball to the shot origin.
        this.strokeCount++;
        this.updateHud();
        this.waterMsgUntil = this.time.now + 2400;
        const [ex, ey] = waterEntry(level, preX, preY, preVx, preVy);
        this.reactions.onWater(ex, ey, this.sim.shotStart.x, this.sim.shotStart.y);
        break;
      }
      case "lip-out":
        this.reactions.onLipOut();
        break;
      case "rim":
        this.reactions.onRim();
        break;
      case "fast-turf-enter":
        this.reactions.onFastTurfEnter(e.index, bx, by, preVx, preVy);
        break;
      case "fast-turf-exit":
        this.reactions.onFastTurfExit(e.index);
        break;
      case "one-way-hit":
        this.reactions.onOneWayHit(e.index, e.speed, e.x, e.y);
        break;
      case "holed":
        break;
    }
  }

  private checkSlopeEntry(level: Level): void {
    const { x, y } = this.sim.ball;
    level.slopes.forEach((s, i) => {
      if (this.slopeEntered[i]) return;
      if (pointInPoly(x, y, s.poly)) {
        this.slopeEntered[i] = true;
        this.reactions.onSlopeEnter(i);
      }
    });
  }

  // ---------------------------------------------------------------- hole complete

  private beginHoled(): void {
    const level = this.currentLevel();
    const save = getSave(this);
    const stars = rating(this.strokeCount, level.par);
    this.celebration.start(level.cup[0], level.cup[1], stars, save.settings.sound, save.settings.vibration);
    this.showResultCard(true);
  }

  /**
   * Result card at F0 (motion.md section 4): every value and action is final and usable now.
   * Decoration: sheet face rise 240ms, star accents 240/320/400ms, stroke underline 480ms,
   * best badge 560ms. Tapping anywhere skips to the final state; actions skip and navigate.
   */
  private showResultCard(fromHoled: boolean): void {
    this.phase = "card";
    this.cancelAim();
    this.refreshPowerPanel();
    if (!fromHoled) this.celebration.skip();
    const level = this.currentLevel();
    const save = getSave(this);
    const priorBest = save.holes[this.holeIndex]?.best;
    const pb = personalBestOutcome(priorBest, this.strokeCount);
    const stars = rating(this.strokeCount, level.par);
    void updateSave(this, onHoleComplete(save, this.holeIndex, this.strokeCount, level.par));
    const endOfCatalog = this.holeIndex + 1 >= this.levels.length && !(this.isLastFree() && !save.unlocked);

    const { w: panelW, h: panelH, pad } = TOKENS.component.result;
    const A = this.frame.bottomEdge;
    const top = A - panelH;
    const cx = 180;
    const cy = top + panelH / 2;
    // Local recipe coordinates (screens.md section 8) are from the panel's top-left.
    const lx = (x: number): number => x - panelW / 2;
    const ly = (y: number): number => y - panelH / 2;

    const dim = this.add.rectangle(180, 320, 360, 640, TOKENS.color.scrim, 1).setAlpha(0);
    dim.setInteractive();
    const card = this.add.container(cx, cy);
    const face = panelImage(this, 0, 0, panelW, panelH, DEPTH.overlay, "sheet");
    card.add(face);

    const heading = this.add
      .text(0, ly(16 + 20), scoreLabel(this.strokeCount, level.par), displayTextStyle(TOKENS.type.display.size, TOKENS.type.display.weight))
      .setOrigin(0.5);
    const caption = this.add
      .text(0, ly(58 + 11), "Hole complete", bodyTextStyleUi(TOKENS.type.caption.size, TOKENS.type.caption.weight, cssColor("textMuted")))
      .setOrigin(0.5);
    const starsC = starRow(this, 0, ly(92), stars, "result");
    const strokeRowY = ly(128);
    const strokeNum = this.add
      .text(0, 0, `${this.strokeCount}`, displayTextStyle(TOKENS.type.number.size, TOKENS.type.number.weight))
      .setOrigin(0, 0.5);
    const strokeUnit = this.add
      .text(strokeNum.width + 4, 0, this.strokeCount === 1 ? "stroke" : "strokes", bodyTextStyleUi(TOKENS.type.body.size, TOKENS.type.body.weight, cssColor("text")))
      .setOrigin(0, 0.5);
    const rowW = strokeUnit.x + strokeUnit.width;
    const strokeRow = this.add.container(-rowW / 2, strokeRowY, [strokeNum, strokeUnit]);
    const parChip = chip(this, 0, ly(158), `Par ${level.par}`);
    const underline = this.add
      .rectangle(0, strokeRowY + 22, Math.max(48, rowW), 3, TOKENS.color.primaryTop, 1)
      .setOrigin(0.5, 0.5)
      .setAlpha(0);
    const badgeText = endOfCatalog ? "All available holes complete" : pb.badge;
    const badge = this.add
      .text(0, ly(166 + 14), badgeText, bodyTextStyleUi(TOKENS.type.caption.size, TOKENS.type.caption.weight, pb.improved ? cssColor("success") : cssColor("textMuted")))
      .setOrigin(0.5);
    card.add([heading, caption, starsC, strokeRow, parChip, underline, badge]);

    pillButton(this, 0, ly(200 + 28), this.nextButtonLabel(), () => this.leave(() => this.onResultNext()), {
      variant: "primary",
      width: panelW - pad * 2,
      id: "result.next",
      parent: card,
    });
    pillButton(this, lx(16 + 71), ly(268 + 28), "Retry", () => this.leave(() => sceneGo(this, "Play", { holeIndex: this.holeIndex })), {
      variant: "secondary",
      width: 142,
      id: "result.retry",
      parent: card,
    });
    pillButton(this, lx(170 + 71), ly(268 + 28), "Holes", () => this.leave(() => this.goHoles()), {
      variant: "secondary",
      width: 142,
      id: "result.holes",
      parent: card,
    });

    this.resultRoot = this.add.container(0, 0, [dim, card]);
    this.resultRoot.setDepth(DEPTH.overlay);
    this.resultShownAt = this.time.now;

    // ---- decoration (never gates input) ----
    const tw = this.tweens;
    const timers: Phaser.Time.TimerEvent[] = [];
    const accents: Phaser.GameObjects.Image[] = [];
    const reduce = reducedMotion();
    const instant = TOKENS.motion.duration.instant;
    tw.add({ targets: dim, alpha: 0.32, duration: instant, ease: TOKENS.motion.ease.fade });
    card.setAlpha(0.75);
    if (reduce) {
      tw.add({ targets: card, alpha: 1, duration: instant, ease: TOKENS.motion.ease.fade });
    } else {
      card.y = cy + 16;
      tw.add({ targets: card, y: cy, alpha: 1, duration: TOKENS.motion.duration.base, ease: TOKENS.motion.ease.enter });
      const { size, gap } = TOKENS.component.starRow.result;
      [240, 320, 400].forEach((t, i) => {
        if (i >= stars) return;
        timers.push(
          this.time.delayedCall(t, () => {
            const accent = this.add
              .image((i - 1) * (size + gap), ly(92), "ui-star-filled")
              .setDisplaySize(size, size);
            const s1 = accent.scaleX;
            accent.setScale(s1 * 0.86);
            card.add(accent);
            accents.push(accent);
            tw.add({
              targets: accent,
              scale: s1,
              duration: TOKENS.motion.duration.quick,
              ease: TOKENS.motion.ease.pop,
              easeParams: [0.6],
              onComplete: () => accent.destroy(),
            });
          })
        );
      });
      timers.push(
        this.time.delayedCall(480, () => {
          tw.add({ targets: underline, alpha: 1, duration: 40, yoyo: true, ease: TOKENS.motion.ease.fade });
        })
      );
      if (pb.beatRecord) {
        badge.setAlpha(0.7);
        timers.push(
          this.time.delayedCall(560, () => {
            tw.add({ targets: badge, alpha: 1, duration: TOKENS.motion.duration.quick, ease: TOKENS.motion.ease.enter });
          })
        );
      }
    }

    this.resultFinish = () => {
      for (const t of timers) t.remove(false);
      tw.killTweensOf([dim, card, underline, badge, ...accents]);
      for (const a of accents) a.destroy();
      accents.length = 0;
      dim.setAlpha(0.32);
      card.setAlpha(1);
      card.y = cy;
      underline.setAlpha(0);
      badge.setAlpha(1);
      this.celebration.skip();
    };
    // Tapping anywhere early skips the decoration to its final state (the scrim never dismisses).
    dim.on("pointerdown", () => this.resultFinish?.());
  }

  /** Any result action: skip remaining visuals/sounds now, then act. */
  private leave(go: () => void): void {
    this.resultFinish?.();
    this.celebration.skip();
    go();
  }

  private isLastFree(): boolean {
    return this.holeIndex === FREE_HOLE_COUNT - 1;
  }

  private nextButtonLabel(): string {
    const save = getSave(this);
    if (this.isLastFree() && !save.unlocked) return "Continue";
    if (this.holeIndex + 1 >= this.levels.length) return "Back to holes";
    return "Next hole";
  }

  private onResultNext(): void {
    const save = getSave(this);
    if (this.isLastFree() && !save.unlocked) {
      const registered = Object.prototype.hasOwnProperty.call(this.game.scene.keys, "Unlock");
      if (registered) sceneGo(this, "Unlock", { from: "hole12" });
      else sceneGo(this, "LevelSelect");
      return;
    }
    const next = this.holeIndex + 1;
    if (next < this.levels.length) sceneGo(this, "Play", { holeIndex: next });
    else sceneGo(this, "LevelSelect");
  }

  private goHoles(): void {
    sceneGo(this, "LevelSelect");
  }

  private clearResult(): void {
    this.resultFinish?.();
    this.resultFinish = null;
    this.resultRoot?.destroy();
    this.resultRoot = null;
    unregisterIdPrefix("result.");
  }

  // ---------------------------------------------------------------- hole setup

  private currentLevel(): Level {
    return this.levels[this.holeIndex];
  }

  private loadHole(index: number): void {
    this.hidePauseSheet();
    this.holeIndex = index;
    this.strokeCount = 0;
    this.phase = "play";
    this.waterMsgUntil = 0;
    this.clearResult();
    this.reactions.settle();
    this.hint.cancel();
    this.worldHint.cancel();

    const level = this.currentLevel();
    const { T, B, H } = pocketLayout();
    Object.assign(this.frame, courseFrame(T, B, H, level));
    this.world.applyFrame(this.frame);
    (this.aimFx as unknown as { frame: CourseFrame }).frame = this.frame;
    (this.hint as unknown as { frame: CourseFrame }).frame = this.frame;
    (this.worldHint as unknown as { frame: CourseFrame }).frame = this.frame;
    this.sim = createSim(level);
    this.accum = 0;
    this.processedEvents = 0;
    this.slopeEntered = level.slopes.map(() => false);
    this.courseBall.setPosition(level.tee[0], level.tee[1]);
    this.courseBall.setVisible(true);
    this.courseBall.setAlpha(1);

    if (!this.attemptStarted) {
      void updateSave(this, onHoleAttemptStart(getSave(this), this.holeIndex));
      this.attemptStarted = true;
    }

    const key = `level-${level.id}-${R}-${this.frame.q.toFixed(5)}`;
    if (this.levelKey !== key) {
      this.levelImage?.destroy();
      if (this.levelKey) releaseTexture(this, this.levelKey);
      this.levelImage = bakeLevelStatic(this, level, key, this.frame);
      this.levelKey = key;
      this.movers?.destroy();
      this.movers = level.movers.length ? new CourseMovers(this, this.world, level) : null;
      this.movers?.sync(this.sim.ball.t);
    }
    this.reactions.bindLevel(level);
    this.cupFx.bindCup(level.cup[0], level.cup[1]);
    this.updateHud();
    this.refreshAssistUi();
    this.refreshPowerPanel();
    this.scheduleHint(level);
    this.scheduleWorldMechanicHint(level);
  }

  private scheduleWorldMechanicHint(level: Level): void {
    const save = getSave(this) as SaveData & { fastTurfIntroSeen?: boolean; wicketIntroSeen?: boolean };
    const mark = (patch: Partial<SaveData & { fastTurfIntroSeen?: boolean; wicketIntroSeen?: boolean }>) =>
      void updateSave(this, { ...getSave(this), ...patch });
    if (this.holeIndex === FREE_HOLE_COUNT && !save.fastTurfIntroSeen && (level.fastTurf?.length ?? 0) > 0) {
      this.worldHint.show("fastTurf", level, () => mark({ fastTurfIntroSeen: true }));
      return;
    }
    if (this.holeIndex === FREE_HOLE_COUNT * 2 && !save.wicketIntroSeen && (level.oneWayGates?.length ?? 0) > 0) {
      this.worldHint.show("wicket", level, () => mark({ wicketIntroSeen: true }));
    }
  }

  private scheduleHint(level: Level): void {
    if (!shouldShowFirstPuttHint(getSave(this))) return;
    const dx = level.cup[0] - level.tee[0];
    const dy = level.cup[1] - level.tee[1];
    const len = Math.hypot(dx, dy) || 1;
    const [bx, by] = worldToUi(this.frame, level.tee[0], level.tee[1]);
    // Demonstrative aim toward the cup; the hand drags back, opposite to it.
    this.hint.schedule(bx, by, -dx / len, -dy / len);
  }

  private refreshAssistUi(): void {
    this.assistBtn?.destroy();
    this.assistBtn = null;
    unregisterIdPrefix("play.assist");
    if (this.phase !== "play" || this.aiming) return;
    const save = getSave(this);
    const hole = save.holes[this.holeIndex];
    if (!hole || !shouldOfferAssist(hole, this.strokeCount)) return;
    const moving = !this.sim.atRest && !this.sim.holed;
    if (moving) return;
    const on = hole.assistEnabled;
    // Rightmost 112px of the power card, 56 high.
    this.assistBtn = pillButton(
      this,
      344 - 56 - 4,
      powerPanelTop(this.frame) + 24,
      on ? "Assist On" : "Assist Off",
      () => {
        const s = getSave(this);
        void updateSave(this, setAssistEnabled(s, this.holeIndex, !s.holes[this.holeIndex].assistEnabled));
        this.refreshAssistUi();
        this.refreshPowerPanel();
      },
      { variant: "secondary", width: 104, id: "play.assist" }
    );
    this.powerSig = "";
  }

  private assistActive(): boolean {
    return getSave(this).holes[this.holeIndex]?.assistEnabled ?? false;
  }

  // ---------------------------------------------------------------- HUD

  private buildHud(): void {
    const top = safeTopInset();
    const bar = this.add.graphics().setDepth(DEPTH.hud);
    bar.fillGradientStyle(TOKENS.panelBg, TOKENS.panelBg, TOKENS.panelBgBottom, TOKENS.panelBgBottom, 1);
    bar.fillRect(0, top, 360, 64);
    bar.lineStyle(1, TOKENS.panelBorder, 1);
    bar.lineBetween(0, top + 64, 360, top + 64);
    if (top > 0) {
      bar.fillStyle(TOKENS.panelBg, 1);
      bar.fillRect(0, 0, 360, top);
    }

    iconButton(this, 16 + 28, top + 4 + 28, "pause", () => this.showPauseSheet(), "play.pause");

    this.hudHoleText = this.add
      .text(80, top + 6, "", bodyTextStyleUi(TOKENS.type.caption.size, TOKENS.type.caption.weight, cssColor("textMuted")))
      .setDepth(DEPTH.hud);
    this.hudNameText = this.add
      .text(80, top + 26, "", displayTextStyle(TOKENS.type.hole.size, TOKENS.type.hole.weight))
      .setDepth(DEPTH.hud);
    this.hudStrokesText = this.add
      .text(344, top + 8, "", bodyTextStyleUi(22, 600))
      .setOrigin(1, 0)
      .setDepth(DEPTH.hud);
    this.hudParText = this.add
      .text(344, top + 34, "", bodyTextStyleUi(TOKENS.type.caption.size, TOKENS.type.caption.weight, cssColor("textMuted")))
      .setOrigin(1, 0)
      .setDepth(DEPTH.hud);
  }

  private buildPowerPanel(): void {
    const top = this.powerPanelTop();
    panelImage(this, 180, top + 24, TOKENS.component.pill.primary.w, 48, DEPTH.hud, "card");
    this.powerHintText = this.add
      .text(16 + 12, top + 8, "", bodyTextStyleUi(TOKENS.type.body.size, TOKENS.type.body.weight))
      .setDepth(DEPTH.hud + 1);
    this.powerPctText = this.add
      .text(16 + 260 + 56, top + 8, "0%", bodyTextStyleUi(TOKENS.type.body.size, TOKENS.type.body.weight))
      .setOrigin(1, 0)
      .setDepth(DEPTH.hud + 1);
    this.powerMeterGfx = this.add.graphics().setDepth(DEPTH.hud + 1);
  }

  private powerPanelTop(): number {
    return powerPanelTop(this.frame);
  }

  private showPauseSheet(): void {
    if (this.pauseClose) return;
    this.cancelAim();
    this.accum = 0;
    unregisterIdPrefix("result.");
    const level = this.currentLevel();
    const panelH = 368;
    const innerW = TOKENS.component.sheet.w - TOKENS.component.sheet.pad * 2;
    const half = panelH / 2;
    const sheet = openBottomSheet(this, panelH, (root) => {
      // screens.md section 7 local recipe, from the panel's top-left (16 inset).
      const title = this.add
        .text(-164 + 16, -half + 24, "Paused", displayTextStyle(TOKENS.type.screen.size, TOKENS.type.screen.weight))
        .setOrigin(0, 0);
      const info = this.add
        .text(-164 + 16, -half + 66, `Hole ${this.holeIndex + 1} · Par ${level.par}`, bodyTextStyleUi(TOKENS.type.caption.size, TOKENS.type.caption.weight, cssColor("textMuted")))
        .setOrigin(0, 0);
      const close = iconButton(this, -164 + 256 + 28, -half + 12 + 28, "close", () => this.hidePauseSheet(), "pause.close");
      root.add([title, info, close]);
      pillButton(this, 0, -half + 100 + 28, "Restart hole", () => {
        this.hidePauseSheet();
        sceneGo(this, "Play", { holeIndex: this.holeIndex });
      }, { variant: "secondary", width: innerW, id: "pause.restart", parent: root });
      pillButton(this, 0, -half + 164 + 28, "Holes", () => sceneGo(this, "LevelSelect"), {
        variant: "secondary",
        width: innerW,
        id: "pause.holes",
        parent: root,
      });
      pillButton(this, 0, -half + 228 + 28, "Settings", () => {
        sceneGo(this, "Settings", { from: "pause", holeIndex: this.holeIndex });
      }, { variant: "secondary", width: innerW, id: "pause.settings", parent: root });
      pillButton(this, 0, -half + 292 + 28, "Resume", () => this.hidePauseSheet(), {
        variant: "primary",
        width: innerW,
        id: "pause.resume",
        parent: root,
      });
    });
    registerControl({ id: "pause.sheet", scene: this.scene.key, x: 0, y: 0, w: sheet.panelW, h: sheet.panelH }, sheet.content);
    this.pauseClose = sheet.close;
  }

  private hidePauseSheet(): void {
    this.pauseClose?.();
    this.pauseClose = null;
    unregisterIdPrefix("pause.");
  }

  private updateHud(): void {
    const level = this.currentLevel();
    this.hudHoleText.setText(`Hole ${this.holeIndex + 1}`);
    const name = level.name || `Par ${level.par}`;
    this.hudNameText.setText(name);
    // Ellipsize to the 152px title region.
    let n = name.length;
    while (this.hudNameText.width > 152 && n > 1) {
      n--;
      this.hudNameText.setText(`${name.slice(0, n).trimEnd()}…`);
    }
    this.hudStrokesText.setText(strokesLabel(this.strokeCount));
    this.hudParText.setText(`Par ${level.par}`);
    this.powerSig = "";
  }

  /** Power card text/meter; redrawn only when its content changes. */
  private refreshPowerPanel(): void {
    const moving = !this.sim.atRest && !this.sim.holed;
    const save = getSave(this);
    let hint: string;
    if (this.waterMsgUntil > 0 && this.time.now < this.waterMsgUntil) hint = "Water · +1 penalty";
    else if (moving) hint = "Ball rolling…";
    else if (this.aiming) hint = this.assistActive() ? "Release · Assist On" : "Release to putt";
    else if (!save.firstPuttTutorialSeen && shouldShowFirstPuttHint(save)) hint = "Drag back, release to putt";
    else hint = "Drag back to aim";
    const p = this.aiming ? this.currentDragPower() : 0;
    const pct = Math.round(p * 100);
    const filled = Math.floor(p * 10);
    const showPct = !(this.assistBtn?.visible ?? false);
    const sig = `${hint}|${pct}|${filled}|${showPct}|${powerColor(p)}`;
    if (sig === this.powerSig) return;
    this.powerSig = sig;
    this.powerHintText.setText(hint);
    this.powerPctText.setText(`${pct}%`).setVisible(showPct);
    const g = this.powerMeterGfx;
    g.clear();
    const segY = this.powerPanelTop() + 32;
    const segCount = showPct ? 10 : 6;
    for (let i = 0; i < segCount; i++) {
      const x = 16 + 12 + i * (26.8 + 4);
      const on = i < filled;
      g.fillStyle(on ? powerColor(p) : TOKENS.color.border, on ? 1 : 0.35);
      g.fillRect(x, segY, 26.8, 8);
    }
  }
}

/**
 * Contact on the rail the ball touched during the last step (read-only geometry adapter; the event has
 * no position). The step may span several substeps, so the ball path pre -> post is sampled and the rail
 * segment closest to that path (within ball radius + 2) is the contact.
 */
function wallContact(level: Level, x0: number, y0: number, x1: number, y1: number): WallContact | null {
  let best: WallContact | null = null;
  let bestD = BALL_R + 2;
  const samples = 6;
  level.walls.forEach((w, wi) => {
    const n = w.points.length;
    const segs = w.closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = w.points[i];
      const b = w.points[(i + 1) % n];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const l2 = dx * dx + dy * dy || 1;
      for (let k = 0; k <= samples; k++) {
        const bx = x0 + ((x1 - x0) * k) / samples;
        const by = y0 + ((y1 - y0) * k) / samples;
        const d = distToSegment(bx, by, a[0], a[1], b[0], b[1]);
        if (d >= bestD) continue;
        const t = Math.max(0, Math.min(1, ((bx - a[0]) * dx + (by - a[1]) * dy) / l2));
        const px = a[0] + dx * t;
        const py = a[1] + dy * t;
        const dl = Math.hypot(bx - px, by - py) || 1;
        bestD = d;
        best = { x: px, y: py, nx: (bx - px) / dl, ny: (by - py) / dl, segment: `${wi}:${i}` };
      }
    }
  });
  return best;
}

/** The bumper actually in contact: |distance - (r + ball r)| within 2.5 world units. */
function bumperContact(level: Level, bx: number, by: number): number {
  let idx = -1;
  let best = 2.5;
  level.bumpers.forEach((b, i) => {
    const gap = Math.abs(Math.hypot(bx - b.x, by - b.y) - (b.r + BALL_R));
    if (gap < best) {
      best = gap;
      idx = i;
    }
  });
  return idx;
}

/** Water entry along the last step's travel (the sim has already moved the ball back to the shot origin). */
function waterEntry(level: Level, x0: number, y0: number, vx: number, vy: number): Vec2 {
  for (let k = 0; k <= 16; k++) {
    const x = x0 + (vx * DT * k) / 16;
    const y = y0 + (vy * DT * k) / 16;
    if (level.water.some((z) => pointInPoly(x, y, z.poly))) return [x, y];
  }
  return [x0 + vx * DT, y0 + vy * DT];
}

function emptyLevel(): Level {
  return {
    id: "",
    name: "",
    par: 2,
    tee: [0, 0],
    cup: [0, 0],
    walls: [],
    bumpers: [],
    sand: [],
    water: [],
    slopes: [],
    movers: [],
  };
}

// ---------------------------------------------------------------- dev/test probe
/**
 * Read-only observation + frame-freeze probe for capture/course-check scripts. Only referenced inside an
 * `import.meta.env.MODE !== "production"` branch, so production builds tree-shake it away entirely.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function attachCourseProbe(play: PlayScene): void {
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const scene = play as any;
const game = play.game;
  let frozenWhy = "";
  let pending: { name: string; fn: () => boolean } | null = null;
  const onPostRender = (): void => {
    if (!pending || !scene.scene.isActive()) return;
    if (pending.fn()) {
      frozenWhy = pending.name;
      pending = null;
      game.loop.sleep();
    }
  };
  game.events.on(Phaser.Core.Events.POST_RENDER, onPostRender);
  play.events.once("shutdown", () => game.events.off(Phaser.Core.Events.POST_RENDER, onPostRender));

  const conditions: Record<string, () => boolean> = {
    aim70: () => scene.aimFx.isShown() && scene.aimFx.opacity() > 0.99 && Math.abs(scene.aimFx.powerShown - 0.7) < 0.03,
    squash: () => scene.courseBall.squashAmount() > 0.045 && !scene.sim.atRest,
    splash: () => {
      const s = scene.reactions.splashVisible();
      const age = scene.time.now - scene.reactions.lastFx.at;
      return scene.reactions.lastFx.kind === "water" && age >= 110 && s.rings >= 2 && s.droplets >= 4;
    },
    sandPuff: () => {
      const age = scene.time.now - scene.reactions.lastFx.at;
      return scene.reactions.lastFx.kind === "sand" && age >= 90 && age <= 200 && scene.particles.liveCount() >= 3;
    },
    cupDrop: () => {
      const d = scene.celebration.dropProgress();
      return d > 0.15 && d < 0.9;
    },
    flagWiggle: () => Math.abs(scene.cupFx.clothAngle()) > 2,
    celebration: () =>
      scene.phase === "card" && scene.time.now - scene.resultShownAt > 300 && scene.celebration.leavesVisible() >= 8,
    hint: () => scene.hint.isVisible() && scene.hint.progress() > 0.5 && scene.hint.progress() < 0.95,
    mechanicHint: () => scene.worldHint.isActive() && scene.worldHint.progress() > 0.55 && scene.worldHint.progress() < 0.95,
    turfStreak: () => scene.reactions.stats.turfStreaks > 0 && scene.particles.liveCount() > 0,
    wicketHit: () => scene.reactions.stats.wicketHits > 0,
    cardSettled: () => scene.phase === "card" && scene.time.now - scene.resultShownAt > 260,
  };

  (window as unknown as { __pdCourse?: unknown }).__pdCourse = {
    frame: (): CourseFrame => ({ ...scene.frame }),
    renderScale: (): number => R,
    level: (): Level => scene.currentLevel(),
    ball: () => ({ ...scene.sim.ball, atRest: scene.sim.atRest, holed: scene.sim.holed }),
    ballUi: (): Vec2 => worldToUi(scene.frame, scene.sim.ball.x, scene.sim.ball.y),
    toWorld: (ux: number, uy: number): Vec2 => uiToWorld(scene.frame, ux, uy),
    state: () => ({
      phase: scene.phase,
      strokes: scene.strokeCount,
      hudStrokes: scene.hudStrokesText.text,
      powerText: scene.powerPctText.text,
      powerHint: scene.powerHintText.text,
      aimShown: scene.aimFx.isShown(),
      aimPower: scene.aimFx.powerShown,
      squash: scene.courseBall.squashAmount(),
      splash: scene.reactions.splashVisible(),
      stats: { ...scene.reactions.stats },
      liveParticles: scene.particles.liveCount(),
      dropProgress: scene.celebration.dropProgress(),
      flagAngle: scene.cupFx.clothAngle(),
      leaves: scene.celebration.leavesVisible(),
      hintVisible: scene.hint.isVisible(),
      reduced: reducedMotion(),
      nextLabel: scene.phase === "card" ? scene.nextButtonLabel() : null,
      lastFx: { ...scene.reactions.lastFx, age: scene.time.now - scene.reactions.lastFx.at },
      lastFxUi: worldToUi(scene.frame, scene.reactions.lastFx.x, scene.reactions.lastFx.y),
      ballUi: worldToUi(scene.frame, scene.courseBall.x, scene.courseBall.y),
      cupUi: worldToUi(scene.frame, scene.currentLevel().cup[0], scene.currentLevel().cup[1]),
    }),
    /** Read-only preview of a shot from the current ball state (same function as the aim preview). */
    simulate: (angle: number, power: number) => {
    const sim = createSim(scene.currentLevel(), scene.sim.ball);
    sim.shoot({ angle, power });
    for (let i = 0; i < 12 / DT && !sim.atRest && !sim.holed; i++) sim.step();
    return { holed: sim.holed, inWater: sim.inWater, end: { ...sim.ball }, events: sim.events.map((e: SimEvent) => e.type) };
  },
  /** Stop every other running scene, as real navigation does (the harness `__pd.play` leaves Menu running). */
  isolate: (): void => {
    for (const other of game.scene.getScenes(true)) if (other !== play) other.scene.stop();
  },
  /** Pause the game loop right after the first rendered frame where the named state is visible. */
    freezeOn: (name: string): void => {
      const fn = conditions[name];
      if (!fn) throw new Error(`unknown state ${name}`);
      frozenWhy = "";
      pending = { name, fn };
    },
    frozen: (): string => frozenWhy,
    wake: (): void => {
      frozenWhy = "";
      pending = null;
      game.loop.wake(true);
    },
  };
}

