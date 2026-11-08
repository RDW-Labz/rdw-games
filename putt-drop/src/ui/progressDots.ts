import Phaser from "phaser";
import { DEPTH } from "../game/theme.js";
import { bodyTextStyleUi } from "./fonts.js";
import { TOKENS, cssColor } from "./tokens.js";

/**
 * Inert progress indicator centered on (x, y). Up to 5 dots (8px, gap 8, active 20x8 success pill,
 * row width 16n+4) followed by an "n of N" caption; more than 5 shows the caption only.
 * Static geometry drawn once.
 */
export function progressDots(
  scene: Phaser.Scene,
  x: number,
  y: number,
  current: number,
  total: number
): Phaser.GameObjects.Container {
  const { size, gap, activeW, activeH } = TOKENS.component.progressDots;
  const maxDots = 5;
  const caption = scene.add
    .text(0, 0, `${current} of ${total}`, bodyTextStyleUi(TOKENS.type.caption.size, TOKENS.type.caption.weight, cssColor("textMuted")))
    .setOrigin(0, 0);
  const parts: Phaser.GameObjects.GameObject[] = [];

  if (total > maxDots) {
    caption.setPosition(-Math.round(caption.width / 2), -Math.round(caption.height / 2));
    parts.push(caption);
  } else {
    const rowW = total * (size + gap) - gap + (activeW - size);
    const fullW = rowW + TOKENS.space.sm + caption.width;
    let cx = -fullW / 2;
    const g = scene.add.graphics();
    for (let i = 1; i <= total; i++) {
      if (i === current) {
        g.fillStyle(TOKENS.color.success, 1);
        g.fillRoundedRect(cx, -activeH / 2, activeW, activeH, activeH / 2);
        cx += activeW + gap;
      } else {
        g.fillStyle(TOKENS.color.surfaceTop, 1);
        g.fillCircle(cx + size / 2, 0, size / 2);
        g.lineStyle(TOKENS.stroke.border, TOKENS.color.controlEdge, 1);
        g.strokeCircle(cx + size / 2, 0, size / 2 - 0.5);
        cx += size + gap;
      }
    }
    caption.setPosition(Math.round(-fullW / 2 + rowW + TOKENS.space.sm), -Math.round(caption.height / 2));
    parts.push(g, caption);
  }

  const c = scene.add.container(x, y, parts);
  c.setDepth(DEPTH.hud);
  return c;
}
