import Phaser from "phaser";
import type { Level } from "../../sim/types.js";
import { moverCenter } from "../../sim/physics.js";
import { TOKENS } from "../../ui/tokens.js";
import { bakeCanvasForScene, roundRectPath } from "../../ui/textures.js";
import { rgb } from "./canvas.js";
import { WD, type CourseWorld } from "./world.js";

const C = TOKENS.color;

function moverKey(w: number, t: number): string {
  return `course-mover-${Math.round(w * 10)}x${Math.round(t * 10)}`;
}

/** Bakes one body texture per mover size: underbody, face, 1px highlight, two inset end dots. */
function ensureMoverTexture(scene: Phaser.Scene, w: number, t: number): string {
  const key = moverKey(w, t);
  bakeCanvasForScene(scene, key, w, t, (ctx) => {
    const r = Math.min(4, t / 2);
    roundRectPath(ctx, 0, 0, w, t, r);
    ctx.fillStyle = rgb(C.moverEdge);
    ctx.fill();
    roundRectPath(ctx, 1, 0.5, w - 2, t - 2, Math.max(0, r - 1));
    ctx.fillStyle = rgb(C.mover);
    ctx.fill();
    ctx.strokeStyle = rgb(C.moverHighlight);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(r + 1, 1.5);
    ctx.lineTo(w - r - 1, 1.5);
    ctx.stroke();
    ctx.fillStyle = rgb(C.moverEdge);
    for (const x of [r + 2, w - r - 2]) {
      ctx.beginPath();
      ctx.arc(x, t / 2, 1, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  return key;
}

/** moverTravel: one body + attached shadow per mover, transforms only from authoritative sim time. */
export class CourseMovers {
  private bodies: Phaser.GameObjects.Image[] = [];
  private shadows: Phaser.GameObjects.Image[] = [];

  constructor(
    scene: Phaser.Scene,
    world: CourseWorld,
    private level: Level
  ) {
    for (const m of level.movers) {
      const key = ensureMoverTexture(scene, m.width, m.thickness);
      const shadow = world.add(
        scene.add
          .image(0, 0, key)
          .setDisplaySize(m.width, m.thickness)
          .setTint(C.shadow)
          .setTintMode(Phaser.TintModes.FILL)
          .setAlpha(0.2)
          .setDepth(WD.track)
      );
      const body = world.add(scene.add.image(0, 0, key).setDisplaySize(m.width, m.thickness).setDepth(WD.mover));
      this.shadows.push(shadow);
      this.bodies.push(body);
    }
  }

  sync(simTime: number): void {
    this.level.movers.forEach((m, i) => {
      const c = moverCenter(m, simTime);
      const angle = Math.atan2(m.to[1] - m.from[1], m.to[0] - m.from[0]);
      this.bodies[i].setPosition(c[0], c[1]).setRotation(angle);
      this.shadows[i].setPosition(c[0] + 1, c[1] + 2).setRotation(angle);
    });
  }

  destroy(): void {
    for (const b of this.bodies) b.destroy();
    for (const s of this.shadows) s.destroy();
    this.bodies = [];
    this.shadows = [];
  }
}
