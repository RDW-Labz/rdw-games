import Phaser from "phaser";
import { sfxUiTap } from "../audio/sfx.js";
import { DEPTH } from "../game/theme.js";
import { touchAudioUnlock } from "../game/theme.js";
import { registerControlCenter } from "./controls.js";
import { faceImage, iconButtonTexture } from "./textures.js";
import { TOKENS } from "./tokens.js";
import { appearFx, cancelPressFx, pressFx, releaseFx } from "./motion.js";

export type IconKind = "pause" | "back" | "settings" | "close";

function drawIcon(g: Phaser.GameObjects.Graphics, kind: IconKind): void {
  g.clear();
  const c = TOKENS.color.text;
  g.lineStyle(2, c, 1);
  if (kind === "pause") {
    g.fillStyle(c, 1);
    g.fillRect(-5, -8, 4, 16);
    g.fillRect(1, -8, 4, 16);
  } else if (kind === "back") {
    g.beginPath();
    g.moveTo(-2, -7);
    g.lineTo(-9, 0);
    g.lineTo(-2, 7);
    g.strokePath();
    g.beginPath();
    g.moveTo(-9, 0);
    g.lineTo(8, 0);
    g.strokePath();
  } else if (kind === "settings") {
    g.strokeCircle(0, 0, 5);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      g.lineBetween(Math.cos(a) * 7, Math.sin(a) * 7, Math.cos(a) * 10, Math.sin(a) * 10);
    }
  } else if (kind === "close") {
    g.lineBetween(-6, -6, 6, 6);
    g.lineBetween(6, -6, -6, 6);
  }
}

export function iconButton(
  scene: Phaser.Scene,
  x: number,
  y: number,
  kind: IconKind,
  onClick: () => void,
  id?: string
): Phaser.GameObjects.Container {
  const size = TOKENS.component.icon.size;
  const bg = faceImage(scene, iconButtonTexture(scene), size, size);
  const icon = scene.add.graphics();
  drawIcon(icon, kind);
  // Icon rides with the face so press feedback moves them together.
  const face = scene.add.container(0, 0, [bg, icon]);
  // Back gets a wider target reaching toward the screen edge (thumb reach); others are the 56 face.
  const hitW = kind === "back" ? TOKENS.component.topBar.slot + TOKENS.space.xxl : Math.max(TOKENS.minTouch, size);
  const hitH = Math.max(TOKENS.minTouch, size);
  const hit = scene.add
    .rectangle(0, 0, hitW, hitH, 0x000000, 0.001)
    .setInteractive({ useHandCursor: true });
  const visual = scene.add.container(x, y, [face, hit]);
  visual.setDepth(DEPTH.hud + 1);

  if (id) registerControlCenter(id, scene.scene.key, x, y, hitW, hitH, visual, "icon", hit);
  appearFx(scene, [face]);

  const fx = { scene, face };
  let pressed = false;
  hit.on("pointerdown", () => {
    pressed = true;
    pressFx(fx);
    touchAudioUnlock();
    sfxUiTap();
    onClick();
  });
  hit.on("pointerup", () => {
    if (!pressed) return;
    pressed = false;
    releaseFx(fx);
  });
  hit.on("pointerout", () => {
    pressed = false;
    cancelPressFx(fx);
  });

  return visual;
}
