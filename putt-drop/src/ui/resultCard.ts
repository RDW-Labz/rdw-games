import Phaser from "phaser";
import { DEPTH } from "../game/theme.js";
import { displayTextStyle, bodyTextStyleUi } from "./fonts.js";
import { chip } from "./chip.js";
import { panelImage } from "./panel.js";
import { pillButton } from "./pillButton.js";
import { starRow } from "./starRow.js";
import { TOKENS, cssColor } from "./tokens.js";

export interface ResultCardData {
  strokes: number;
  par: number;
  stars: number;
  best?: number;
  improved: boolean;
}

export function resultCard(
  scene: Phaser.Scene,
  x: number,
  y: number,
  data: ResultCardData,
  width: number = TOKENS.component.result.w,
  onNext?: () => void
): Phaser.GameObjects.Container {
  const { h } = TOKENS.component.result;
  const w = width;
  const panel = panelImage(scene, 0, 0, w, h, DEPTH.overlay, "sheet");
  const title = scene.add
    .text(0, -h / 2 + 36, "Nice putt!", displayTextStyle(TOKENS.type.display.size, TOKENS.type.display.weight, TOKENS.textPrimary))
    .setOrigin(0.5);
  const stars = starRow(scene, 0, -72, data.stars, "result");
  const strokeNum = scene.add
    .text(0, 0, `${data.strokes}`, displayTextStyle(TOKENS.type.number.size, TOKENS.type.number.weight, TOKENS.textPrimary))
    .setOrigin(0, 0.5);
  const strokeUnit = scene.add
    .text(strokeNum.width + 4, 0, data.strokes === 1 ? "stroke" : "strokes", bodyTextStyleUi(TOKENS.type.body.size, TOKENS.type.body.weight, cssColor("text")))
    .setOrigin(0, 0.5);
  const rowW = strokeUnit.x + strokeUnit.width;
  const strokeRow = scene.add.container(-rowW / 2, -8, [strokeNum, strokeUnit]);
  const parChip = chip(scene, 0, 24, `Par ${data.par}`);
  let badge: Phaser.GameObjects.Text | null = null;
  if (data.improved) {
    badge = scene.add
      .text(0, 54, data.best === undefined ? "First finish" : "Personal best", bodyTextStyleUi(TOKENS.type.caption.size, TOKENS.type.caption.weight, cssColor("success")))
      .setOrigin(0.5);
  } else if (data.best !== undefined) {
    badge = scene.add
      .text(0, 54, `Best ${data.best}`, bodyTextStyleUi(TOKENS.type.caption.size, TOKENS.type.caption.weight, cssColor("textMuted")))
      .setOrigin(0.5);
  }
  const parts: Phaser.GameObjects.GameObject[] = [panel, title, stars, strokeRow, parChip];
  if (badge) parts.push(badge);
  const c = scene.add.container(x, y, parts);
  c.setSize(w, h);
  c.setDepth(TOKENS.depth.sheet);
  if (onNext) {
    const pad = TOKENS.component.result.pad;
    const pillH = TOKENS.component.pill.primary.h;
    pillButton(scene, 0, h / 2 - pad - pillH / 2, "Next hole", onNext, { width: w - pad * 2, parent: c });
  }
  return c;
}
