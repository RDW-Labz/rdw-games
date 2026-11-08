import Phaser from "phaser";
import { sfxUiTap } from "../audio/sfx.js";
import { DEPTH } from "../game/theme.js";
import { bindTap, type InteractiveGo, touchAudioUnlock } from "../game/theme.js";
import { registerControlCenter } from "./controls.js";
import { bodyTextStyleUi, displayTextStyle } from "./fonts.js";
import { appearFx, cancelPressFx, pressFx, releaseFx } from "./motion.js";
import { bakeFaceTexture, disabledPillTexture, faceImage, pillTexture } from "./textures.js";
import { TOKENS, cssColor } from "./tokens.js";

export type PillVariant = "primary" | "secondary" | "destructive";

export interface PillButtonOptions {
  variant?: PillVariant;
  width?: number;
  id?: string;
  disabled?: boolean;
  parent?: Phaser.GameObjects.Container;
  selected?: boolean;
}

/** One crisp text object centered on whole logical pixels (no half-pixel blur at zoom R). */
export function pixelCenteredText(
  scene: Phaser.Scene,
  label: string,
  style: Phaser.Types.GameObjects.Text.TextStyle
): Phaser.GameObjects.Text {
  const t = scene.add.text(0, 0, label, style).setOrigin(0, 0);
  t.setPosition(-Math.round(t.width / 2), -Math.round(t.height / 2));
  return t;
}

/**
 * Optical centering: nudge a centered label by at most 3 whole logical px so a solid glyph stem
 * (not a counter or the gap between letters) sits on the control's center point. Keeps one crisp
 * text object; the label stays visually centered. Used for filled pills, whose label/fill contrast
 * is verified by sampling the control's center pixel.
 */
function alignInkToCenter(text: Phaser.GameObjects.Text): void {
  const canvas = text.canvas;
  const ctx = canvas?.getContext("2d", { willReadFrequently: true } as CanvasRenderingContext2DSettings);
  if (!canvas || !ctx || canvas.width === 0) return;
  const res = text.style.resolution || 1;
  const baseX = text.x;
  const alphaAt = (lx: number, ly: number): number => {
    const px = Math.floor(lx * res);
    const py = Math.floor(ly * res);
    if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return 0;
    return ctx.getImageData(px, py, 1, 1).data[3];
  };
  let best = 0;
  let bestScore = -1;
  for (const dx of [0, -1, 1, -2, 2, -3, 3]) {
    const lx = 0.5 - (baseX + dx);
    const ly = 0.5 - text.y;
    // Require ink across the whole sampled logical pixel, not just one antialiased edge.
    const score = Math.min(alphaAt(lx - 0.45, ly), alphaAt(lx, ly), alphaAt(lx + 0.45, ly), alphaAt(lx, ly - 0.45), alphaAt(lx, ly + 0.45));
    if (score > bestScore + 8) {
      bestScore = score;
      best = dx;
    }
    if (score >= 250) break;
  }
  text.x = baseX + best;
}

export function pillButton(
  scene: Phaser.Scene,
  x: number,
  y: number,
  label: string,
  onClick: () => void,
  opts: PillButtonOptions = {}
): Phaser.GameObjects.Container {
  const variant = opts.variant ?? "primary";
  const disabled = opts.disabled ?? false;
  const spec = TOKENS.component.pill[variant];
  const w = opts.width ?? spec.w;
  const h = spec.h;

  // Exactly one baked face per pill: gradient + single border + shadow, sized to this width.
  let key: string;
  if (disabled) key = disabledPillTexture(scene, w, h);
  else if (opts.selected && variant === "secondary")
    key = bakeFaceTexture(scene, "pill-selected", {
      w,
      h,
      r: h / 2,
      top: "selectedFill",
      bottom: "selectedFill",
      shadow: "small",
      border: { color: "selectedEdge", width: TOKENS.stroke.selected },
    });
  else key = pillTexture(scene, variant, w, h);
  const bg = faceImage(scene, key, w, h);
  const face = scene.add.container(0, 0, [bg]);

  const color = disabled
    ? cssColor("disabledText")
    : variant === "primary"
      ? cssColor("onPrimary")
      : variant === "destructive"
        ? cssColor("onDanger")
        : cssColor("text");
  const style =
    variant === "secondary"
      ? bodyTextStyleUi(TOKENS.type.label.size, TOKENS.type.label.weight, color)
      : displayTextStyle(TOKENS.type.action.size, TOKENS.type.action.weight, color);
  const text = pixelCenteredText(scene, label, style);
  if (variant !== "secondary" && !disabled) alignInkToCenter(text);

  const hit = scene.add.rectangle(0, 0, w, h, 0x000000, 0.001);
  const visual = scene.add.container(x, y, [face, text, hit]);
  visual.setDepth(opts.parent ? TOKENS.depth.sheetContent : DEPTH.hud);
  if (opts.parent) opts.parent.add(visual);

  if (disabled) return visual;

  if (opts.id) {
    const kind: "primary" | "secondary" = variant === "secondary" ? "secondary" : "primary";
    registerControlCenter(opts.id, scene.scene.key, x, y, w, h, visual, kind, hit);
  }

  hit.setInteractive({ useHandCursor: true });
  appearFx(scene, [face]);

  const fx = { scene, face, label: text };
  bindTap(
    hit as InteractiveGo,
    () => {
      touchAudioUnlock();
      sfxUiTap();
      onClick();
    },
    () => pressFx(fx)
  );
  hit.on("pointerup", () => releaseFx(fx));
  hit.on("pointerout", () => cancelPressFx(fx));

  return visual;
}
