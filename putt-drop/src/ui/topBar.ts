import Phaser from "phaser";
import { DEPTH } from "../game/theme.js";
import { sceneGo } from "../game/juice.js";
import { displayTextStyle } from "./fonts.js";
import { ensureUiTextures, faceImage, topBarTexture } from "./textures.js";
import { TOKENS } from "./tokens.js";
import { iconButton } from "./iconButton.js";

export interface TopBarOptions {
  title: string;
  backId?: string;
  onBack?: () => void;
  right?: Phaser.GameObjects.GameObject;
}

/**
 * Full-width top bar covering the safe area: surface gradient, 1px bottom border, small baked shadow.
 * The bar face swallows taps so scrolled content underneath can never be activated through it.
 * Returns the y where scroll content begins.
 */
export function topBar(scene: Phaser.Scene, opts: TopBarOptions): number {
  ensureUiTextures(scene);
  const top = TOKENS.layout.safeTop;
  const barH = TOKENS.component.topBar.h;
  const W = TOKENS.layout.logicalW;
  const cy = top + barH / 2;
  const faceH = top + barH;

  const bar = faceImage(scene, topBarTexture(scene, faceH), W, faceH, W / 2, faceH / 2).setDepth(DEPTH.hud - 1);
  const blocker = scene.add
    .rectangle(W / 2, faceH / 2, W, faceH, 0x000000, 0.001)
    .setInteractive()
    .setDepth(DEPTH.hud - 1);
  void bar;
  void blocker;

  if (opts.onBack) {
    iconButton(scene, TOKENS.component.topBar.gutter + TOKENS.component.topBar.slot / 2, cy, "back", () => opts.onBack?.(), opts.backId);
  }

  const title = scene.add
    .text(0, 0, opts.title, displayTextStyle(TOKENS.type.screen.size, TOKENS.type.screen.weight, TOKENS.textPrimary))
    .setOrigin(0, 0)
    .setDepth(DEPTH.hud);
  title.setPosition(Math.round(W / 2 - title.width / 2), Math.round(cy - title.height / 2));

  if (opts.right && "setPosition" in opts.right) {
    (opts.right as Phaser.GameObjects.Container).setPosition(
      W - TOKENS.component.topBar.gutter - TOKENS.component.topBar.slot / 2,
      cy
    );
    (opts.right as Phaser.GameObjects.Container).setDepth(DEPTH.hud + 1);
  }

  return top + barH + TOKENS.space.md;
}

export function topBarBackToMenu(scene: Phaser.Scene, title: string, backId: string): number {
  return topBar(scene, {
    title,
    backId,
    onBack: () => sceneGo(scene, "Menu", { nav: "back" }),
  });
}
