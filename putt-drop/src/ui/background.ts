import Phaser from "phaser";
import { DEPTH } from "../game/theme.js";
import { ensureUiTextures } from "./textures.js";
import { TOKENS } from "./tokens.js";

export type BackgroundLayer = "sky" | "far" | "mid" | "near";

export class ScreenBackground {
  private readonly scene: Phaser.Scene;
  readonly layers: Record<BackgroundLayer, Phaser.GameObjects.Container>;
  private gradient: Phaser.GameObjects.Image;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    ensureUiTextures(scene);
    this.layers = {
      sky: scene.add.container(0, 0).setDepth(DEPTH.bg),
      far: scene.add.container(0, 0).setDepth(TOKENS.depth.ambient),
      mid: scene.add.container(0, 0).setDepth(TOKENS.depth.decoration),
      near: scene.add.container(0, 0).setDepth(TOKENS.depth.decoration + 1),
    };
    // Baked at texture DPR; display at exactly the logical screen size.
    this.gradient = scene.add
      .image(TOKENS.layout.logicalW / 2, TOKENS.layout.logicalH / 2, "ui-bg-gradient")
      .setDisplaySize(TOKENS.layout.logicalW, TOKENS.layout.logicalH)
      .setDepth(DEPTH.bg - 1);
    this.layers.sky.add(this.gradient);

    const blobFar = scene.add.ellipse(280, 120, 140, 100, TOKENS.color.bgLight, 0.25);
    const blobMid = scene.add.ellipse(80, 480, 120, 80, TOKENS.color.turfTop, 0.15);
    this.layers.far.add(blobFar);
    this.layers.mid.add(blobMid);
  }

  layer(name: BackgroundLayer): Phaser.GameObjects.Container {
    return this.layers[name];
  }

  update(dt: number): void {
    const t = this.scene.time.now / 1000;
    this.layers.far.x = Math.sin(t * 0.2) * 4;
    this.layers.mid.y = Math.cos(t * 0.15) * 2;
  }

  shutdown(): void {
    this.gradient.destroy();
    for (const l of Object.values(this.layers)) l.destroy();
  }
}
