import Phaser from "phaser";
import { DEPTH } from "./theme.js";
import type { Level } from "../sim/types.js";
import { LOGICAL_H, LOGICAL_W, R } from "./display.js";
import { acquireSceneTexture, markGlobalTexture } from "./textureCache.js";
import { bakeCourseBoard } from "./course/bakeStatic.js";
import type { CourseFrame } from "./course/frame.js";

export { LOGICAL_H, LOGICAL_W, R } from "./display.js";

export function applyLogicalCamera(scene: Phaser.Scene): void {
  const cam = scene.cameras.main;
  cam.setZoom(R);
  cam.setOrigin(0, 0);
  cam.setScroll(0, 0);
}

export function configureCrispCanvas(game: Phaser.Game): void {
  Phaser.Display.Canvas.CanvasInterpolation.setBicubic(game.canvas);
  game.canvas.style.touchAction = "none";
}

const GRID_STEP = 24;
const GRID_TILE_KEY = "ui-bg-grid-tile";

function ensureGridTile(scene: Phaser.Scene): void {
  if (scene.textures.exists(GRID_TILE_KEY)) return;
  const g = scene.add.graphics();
  g.fillStyle(0xfae0b9, 0.15);
  g.fillRect(0, 0, GRID_STEP, GRID_STEP);
  g.lineStyle(1, 0xd5c8a6, 0.2);
  g.lineBetween(0, 0, 0, GRID_STEP);
  g.lineBetween(0, 0, GRID_STEP, 0);
  g.generateTexture(GRID_TILE_KEY, GRID_STEP, GRID_STEP);
  g.destroy();
  markGlobalTexture(GRID_TILE_KEY);
}

export class BackgroundGrid extends Phaser.GameObjects.TileSprite {
  private t = 0;

  constructor(scene: Phaser.Scene) {
    ensureGridTile(scene);
    super(scene, 0, 0, LOGICAL_W, LOGICAL_H, GRID_TILE_KEY);
    scene.add.existing(this);
    this.setOrigin(0, 0);
    this.setDepth(DEPTH.bg);
    this.setTileScale(1, 1);
  }

  updateDrift(dt: number): void {
    this.t += dt * 0.02;
    this.setTilePosition(Math.sin(this.t) * 6, Math.cos(this.t * 0.7) * 4);
  }
}

/**
 * Static course board for one hole, baked at device resolution through the course frame and
 * displayed at its exact UI rectangle (never rescaled again by the camera zoom).
 */
export function bakeLevelStatic(
  scene: Phaser.Scene,
  level: Level,
  key: string,
  frame: CourseFrame
): Phaser.GameObjects.Image {
  const board = bakeCourseBoard(scene, level, key, frame, R);
  acquireSceneTexture(scene, key);
  return scene.add
    .image(board.x, board.y, key)
    .setOrigin(0)
    .setDisplaySize(board.w, board.h)
    .setDepth(DEPTH.level);
}
