import Phaser from "phaser";
import { CUP_R } from "../../sim/physics.js";
import { TOKENS } from "../../ui/tokens.js";
import { bakeCanvasForScene } from "../../ui/textures.js";
import { reducedMotion } from "../../ui/motion.js";
import { rgb } from "./canvas.js";
import { WD, type CourseWorld } from "./world.js";

const CLOTH_KEY = "course-flag-cloth";
const LIP_KEY = "course-cup-lip";
const LIP_SIZE = CUP_R * 2 + 6;
const C = TOKENS.color;

function ensureCupTextures(scene: Phaser.Scene): void {
  bakeCanvasForScene(scene, CLOTH_KEY, 24, 16, (ctx) => {
    // Cloth 24x16 with a 2-wide fold stripe at the pole side.
    ctx.fillStyle = rgb(C.flag);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(24, 2);
    ctx.lineTo(22, 8);
    ctx.lineTo(24, 14);
    ctx.lineTo(0, 16);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = rgb(C.flagFold);
    ctx.fillRect(0, 0, 2, 16);
  });
  bakeCanvasForScene(scene, LIP_KEY, LIP_SIZE, LIP_SIZE, (ctx) => {
    const c = LIP_SIZE / 2;
    ctx.strokeStyle = rgb(C.railHighlight, 1);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(c, c, CUP_R, 0, Math.PI * 2);
    ctx.stroke();
  });
}

/** Cup overlays: lip highlight (rim rattle / drop mask edge) and the cloth flag (pivot at pole top). */
export class CourseCupFx {
  private cloth: Phaser.GameObjects.Image;
  private lip: Phaser.GameObjects.Image;
  private lastRattle = -1e9;
  cx = 0;
  cy = 0;

  constructor(
    private scene: Phaser.Scene,
    world: CourseWorld
  ) {
    ensureCupTextures(scene);
    this.lip = world.add(
      scene.add.image(0, 0, LIP_KEY).setDisplaySize(LIP_SIZE, LIP_SIZE).setDepth(WD.cupLip).setAlpha(0)
    );
    this.cloth = world.add(
      scene.add.image(0, 0, CLOTH_KEY).setOrigin(0, 0).setDisplaySize(24, 16).setDepth(WD.flag)
    );
  }

  bindCup(cx: number, cy: number): void {
    this.cx = cx;
    this.cy = cy;
    this.scene.tweens.killTweensOf([this.cloth, this.lip]);
    // Pole is at cx + CUP_R - 1, height 38 (baked); the cloth hangs from its top.
    this.cloth.setPosition(cx + CUP_R, cy - 38).setAngle(0);
    this.lip.setPosition(cx, cy).setAlpha(0);
  }

  clothAngle(): number {
    return this.cloth.angle;
  }

  lipAlpha(): number {
    return this.lip.alpha;
  }

  /** flagWiggle: 0 -> +3deg at 80ms -> -2deg at 200ms -> 0 at 400ms, Sine.easeInOut segments. */
  wiggleFlag(): void {
    if (reducedMotion()) return;
    const tw = this.scene.tweens;
    const ease = TOKENS.motion.ease.ambient;
    tw.killTweensOf(this.cloth);
    this.cloth.setAngle(0);
    tw.chain({
      targets: this.cloth,
      tweens: [
        { angle: 3, duration: 80, ease },
        { angle: -2, duration: 120, ease },
        { angle: 0, duration: 200, ease },
      ],
    });
  }

  /** rimRattle: lip alpha 0.6 -> 0 in 160ms; debounced 120ms; reduced motion: fixed 80ms highlight. */
  rimRattle(): void {
    const now = this.scene.time.now;
    if (now - this.lastRattle < 120) return;
    this.lastRattle = now;
    const tw = this.scene.tweens;
    tw.killTweensOf(this.lip);
    this.lip.setAlpha(0.6);
    if (reducedMotion()) {
      this.scene.time.delayedCall(TOKENS.motion.duration.instant, () => this.lip.setAlpha(0));
      return;
    }
    tw.add({ targets: this.lip, alpha: 0, duration: TOKENS.motion.duration.quick, ease: TOKENS.motion.ease.fade });
  }

  /** Lip drawn over the sinking clone during ballDrop, then faded. */
  showDropLip(holdMs: number): void {
    const tw = this.scene.tweens;
    tw.killTweensOf(this.lip);
    this.lip.setAlpha(0.9);
    tw.add({
      targets: this.lip,
      alpha: 0,
      delay: holdMs,
      duration: TOKENS.motion.duration.instant,
      ease: TOKENS.motion.ease.fade,
    });
  }

  settle(): void {
    this.scene.tweens.killTweensOf([this.cloth, this.lip]);
    this.cloth.setAngle(0);
    this.lip.setAlpha(0);
  }

  destroy(): void {
    this.settle();
    this.cloth.destroy();
    this.lip.destroy();
  }
}
