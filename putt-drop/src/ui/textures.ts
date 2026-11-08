import type Phaser from "phaser";
import { R } from "../game/display.js";
import { acquireSceneTexture, markGlobalTexture, releaseSceneTextures } from "../game/textureCache.js";
import { TOKENS, type ColorToken } from "./tokens.js";

/** Transparent padding baked around every face so stacked shadows are never cropped. */
export const TEXTURE_PAD = 24;

type ShadowKey = keyof typeof TOKENS.shadow;

function rgba(c: number, a = 1): string {
  return `rgba(${(c >> 16) & 0xff},${(c >> 8) & 0xff},${c & 0xff},${a})`;
}

/** Rounded rectangle with true circular corners (pills/circles read as real pills, not squircles). */
export function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arc(x + w - rr, y + rr, rr, -Math.PI / 2, 0);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arc(x + w - rr, y + h - rr, rr, 0, Math.PI / 2);
  ctx.lineTo(x + rr, y + h);
  ctx.arc(x + rr, y + h - rr, rr, Math.PI / 2, Math.PI);
  ctx.lineTo(x, y + rr);
  ctx.arc(x + rr, y + rr, rr, Math.PI, Math.PI * 1.5);
  ctx.closePath();
}

function drawShadowLayers(
  ctx: CanvasRenderingContext2D,
  fx: number,
  fy: number,
  w: number,
  h: number,
  r: number,
  recipe: ShadowKey
): void {
  for (const layer of TOKENS.shadow[recipe]) {
    const s = layer.spread;
    ctx.fillStyle = rgba(TOKENS.color[layer.color as ColorToken], layer.alpha);
    roundRectPath(ctx, fx - s + layer.dx, fy - s + layer.dy, w + s * 2, h + s * 2, r > 0 ? r + s : 0);
    ctx.fill();
  }
}

/** Canvas texture at min(R, textureDprMax) device pixels per logical px. Logical size in, display with setDisplaySize. */
function bakeCanvas(
  scene: Phaser.Scene,
  key: string,
  logicalW: number,
  logicalH: number,
  draw: (ctx: CanvasRenderingContext2D) => void,
  owner: "global" | "scene" = "global"
): string {
  if (scene.textures.exists(key)) {
    if (owner === "scene") acquireForScene(scene, key);
    return key;
  }
  const scale = Math.min(R, TOKENS.budget.textureDprMax);
  const created = scene.textures.createCanvas(key, Math.ceil(logicalW * scale), Math.ceil(logicalH * scale));
  if (created == null) return key;
  const canvas = created.getSourceImage() as HTMLCanvasElement;
  const ctx = canvas.getContext("2d");
  if (ctx == null) return key;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, logicalW, logicalH);
  draw(ctx);
  created.refresh();
  if (owner === "global") markGlobalTexture(key);
  else acquireForScene(scene, key);
  return key;
}

const releaseHooked = new WeakSet<Phaser.Scene>();
function acquireForScene(scene: Phaser.Scene, key: string): void {
  acquireSceneTexture(scene, key);
  if (releaseHooked.has(scene)) return;
  releaseHooked.add(scene);
  scene.events.once("shutdown", () => {
    releaseHooked.delete(scene);
    releaseSceneTextures(scene);
  });
}

export interface FaceSpec {
  w: number;
  h: number;
  r: number;
  top: ColorToken;
  bottom: ColorToken;
  shadow?: ShadowKey;
  /** One border, drawn fully inside the face. */
  border?: { color: ColorToken; width: number };
  /** Bottom edge only (top bar). */
  borderBottomOnly?: boolean;
  /** Top inset highlight; default 1px white at 0.65. */
  highlight?: { color: ColorToken; width: number; alpha: number } | null;
}

function drawFace(ctx: CanvasRenderingContext2D, s: FaceSpec): void {
  const fx = TEXTURE_PAD;
  const fy = TEXTURE_PAD;
  if (s.shadow) drawShadowLayers(ctx, fx, fy, s.w, s.h, s.r, s.shadow);
  const grad = ctx.createLinearGradient(0, fy, 0, fy + s.h);
  grad.addColorStop(0, rgba(TOKENS.color[s.top]));
  grad.addColorStop(1, rgba(TOKENS.color[s.bottom]));
  roundRectPath(ctx, fx, fy, s.w, s.h, s.r);
  ctx.fillStyle = grad;
  ctx.fill();

  const hl = s.highlight === undefined ? { color: "highlight" as ColorToken, width: 1, alpha: 0.65 } : s.highlight;
  if (hl) {
    // Inset highlight following the rounded top edge, limited to a thin top band.
    const bw = s.border?.width ?? 0;
    ctx.save();
    ctx.beginPath();
    ctx.rect(fx, fy, s.w, Math.min(s.h / 2, 7));
    ctx.clip();
    ctx.strokeStyle = rgba(TOKENS.color[hl.color], hl.alpha);
    ctx.lineWidth = hl.width;
    const inset = bw + hl.width / 2;
    roundRectPath(ctx, fx + inset, fy + inset, s.w - inset * 2, s.h - inset * 2, Math.max(0, s.r - inset));
    ctx.stroke();
    ctx.restore();
  }

  if (s.border) {
    const bw = s.border.width;
    ctx.strokeStyle = rgba(TOKENS.color[s.border.color]);
    ctx.lineWidth = bw;
    if (s.borderBottomOnly) {
      ctx.beginPath();
      ctx.moveTo(fx, fy + s.h - bw / 2);
      ctx.lineTo(fx + s.w, fy + s.h - bw / 2);
      ctx.stroke();
    } else {
      roundRectPath(ctx, fx + bw / 2, fy + bw / 2, s.w - bw, s.h - bw, Math.max(0, s.r - bw / 2));
      ctx.stroke();
    }
  }
}

/** Bake (once) a padded face texture for the given spec. Key encodes every input. */
export function bakeFaceTexture(scene: Phaser.Scene, name: string, spec: FaceSpec): string {
  const key = `ui-face-${name}-${spec.w}x${spec.h}`;
  return bakeCanvas(scene, key, spec.w + TEXTURE_PAD * 2, spec.h + TEXTURE_PAD * 2, (ctx) => drawFace(ctx, spec));
}

export type PanelVariant = "card" | "raised" | "sheet";

/** Card/sheet/toast panel. card = surface + card shadow R20; raised = raised gradient + card shadow (toast); sheet = raised + sheet shadow R28. */
export function bakePanelTexture(scene: Phaser.Scene, w: number, h: number, variant: PanelVariant = "card"): string {
  const card = variant === "card";
  return bakeFaceTexture(scene, `panel-${variant}`, {
    w,
    h,
    r: variant === "sheet" ? TOKENS.radius.sheet : TOKENS.radius.card,
    top: card ? "surfaceTop" : "raisedTop",
    bottom: card ? "surfaceBottom" : "raisedBottom",
    shadow: variant === "sheet" ? "sheet" : "card",
    border: { color: "border", width: TOKENS.stroke.border },
  });
}

export type PillTextureVariant = "primary" | "secondary" | "destructive";

export function pillTexture(scene: Phaser.Scene, variant: PillTextureVariant, w: number, h: number): string {
  const r = h / 2;
  if (variant === "primary") {
    return bakeFaceTexture(scene, "pill-primary", {
      w,
      h,
      r,
      top: "primaryTop",
      bottom: "primaryBottom",
      shadow: "primary",
      highlight: { color: "primaryHighlight", width: 2, alpha: 1 },
    });
  }
  if (variant === "destructive") {
    return bakeFaceTexture(scene, "pill-destructive", {
      w,
      h,
      r,
      top: "dangerTop",
      bottom: "dangerBottom",
      shadow: "small",
    });
  }
  return bakeFaceTexture(scene, "pill-secondary", {
    w,
    h,
    r,
    top: "surfaceTop",
    bottom: "surfaceBottom",
    shadow: "small",
    border: { color: "controlEdge", width: TOKENS.stroke.mechanic },
  });
}

export function disabledPillTexture(scene: Phaser.Scene, w: number, h: number): string {
  return bakeFaceTexture(scene, "pill-disabled", {
    w,
    h,
    r: h / 2,
    top: "disabledFill",
    bottom: "disabledFill",
    highlight: null,
  });
}

export function iconButtonTexture(scene: Phaser.Scene): string {
  const s = TOKENS.component.icon.size;
  return bakeFaceTexture(scene, "icon", {
    w: s,
    h: s,
    r: s / 2,
    top: "surfaceTop",
    bottom: "surfaceBottom",
    shadow: "small",
    border: { color: "controlEdge", width: TOKENS.stroke.border },
  });
}

export function chipTexture(scene: Phaser.Scene, w: number): string {
  const h = TOKENS.component.chip.h;
  return bakeFaceTexture(scene, "chip", {
    w,
    h,
    r: h / 2,
    top: "surfaceTop",
    bottom: "surfaceBottom",
    shadow: "small",
    border: { color: "border", width: TOKENS.stroke.border },
  });
}

export function lockBadgeTexture(scene: Phaser.Scene, w: number): string {
  const h = TOKENS.component.lockBadge.h;
  return bakeFaceTexture(scene, "lock", {
    w,
    h,
    r: h / 2,
    top: "raisedTop",
    bottom: "raisedBottom",
    border: { color: "border", width: TOKENS.stroke.border },
  });
}

/** Full-width bar from y=0 through the safe area to the bar bottom; bottom border only. */
export function topBarTexture(scene: Phaser.Scene, h: number): string {
  return bakeFaceTexture(scene, "topbar", {
    w: TOKENS.layout.logicalW,
    h,
    r: 0,
    top: "surfaceTop",
    bottom: "surfaceBottom",
    shadow: "small",
    border: { color: "border", width: TOKENS.stroke.border },
    borderBottomOnly: true,
    highlight: null,
  });
}

/** Offset of the face top-left inside the padded bake (logical px). */
export function bakedFaceOrigin(): { x: number; y: number } {
  return { x: TEXTURE_PAD, y: TEXTURE_PAD };
}

export function bakedFaceDisplaySize(faceW: number, faceH: number): { w: number; h: number } {
  return { w: faceW + TEXTURE_PAD * 2, h: faceH + TEXTURE_PAD * 2 };
}

/** Normalized origin so the visible face is centered on the sprite position. */
export function bakedFaceDisplayOrigin(faceW: number, faceH: number): { x: number; y: number } {
  const { w, h } = bakedFaceDisplaySize(faceW, faceH);
  return { x: (TEXTURE_PAD + faceW / 2) / w, y: (TEXTURE_PAD + faceH / 2) / h };
}

/** Size a padded face image so 1 texture face px = 1 logical px, centered on the face. */
export function applyBakedFaceImage(
  img: Phaser.GameObjects.Image,
  faceW: number,
  faceH: number
): Phaser.GameObjects.Image {
  const o = bakedFaceDisplayOrigin(faceW, faceH);
  const { w, h } = bakedFaceDisplaySize(faceW, faceH);
  return img.setOrigin(o.x, o.y).setDisplaySize(w, h);
}

export function faceImage(scene: Phaser.Scene, key: string, faceW: number, faceH: number, x = 0, y = 0): Phaser.GameObjects.Image {
  return applyBakedFaceImage(scene.add.image(x, y, key), faceW, faceH);
}

const STAR_BAKE = 28;

export function ensureUiTextures(scene: Phaser.Scene): void {
  if (scene.textures.exists("ui-bg-gradient")) return;
  const W = TOKENS.layout.logicalW;
  const H = TOKENS.layout.logicalH;

  bakeCanvas(scene, "ui-bg-gradient", W, H, (ctx) => {
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, rgba(TOKENS.color.bgTop));
    grad.addColorStop(1, rgba(TOKENS.color.bgBottom));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    const light = ctx.createRadialGradient(W * 0.85, H * 0.1, 0, W * 0.85, H * 0.1, 150);
    light.addColorStop(0, rgba(TOKENS.color.bgLight, 0.55));
    light.addColorStop(1, rgba(TOKENS.color.bgLight, 0));
    ctx.fillStyle = light;
    ctx.fillRect(0, 0, W, H);
  });

  for (const filled of [true, false]) {
    bakeCanvas(scene, filled ? "ui-star-filled" : "ui-star-empty", STAR_BAKE, STAR_BAKE, (ctx) => {
      const c = STAR_BAKE / 2;
      drawStarPath(ctx, c, c, c - 1.5);
      ctx.fillStyle = rgba(filled ? TOKENS.color.star : TOKENS.color.starEmpty);
      ctx.fill();
      ctx.strokeStyle = rgba(TOKENS.color.starEdge);
      ctx.lineJoin = "round";
      ctx.lineWidth = filled ? 1.5 : 1;
      ctx.stroke();
    });
  }
}

function drawStarPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  ctx.beginPath();
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / 5;
    const x1 = cx + Math.cos(a) * r;
    const y1 = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x1, y1);
    else ctx.lineTo(x1, y1);
    const a2 = a + Math.PI / 5;
    ctx.lineTo(cx + Math.cos(a2) * (r * 0.48), cy + Math.sin(a2) * (r * 0.48));
  }
  ctx.closePath();
}

/** Scene-owned bake: released automatically when the scene shuts down. */
export function bakeCanvasForScene(
  scene: Phaser.Scene,
  key: string,
  logicalW: number,
  logicalH: number,
  draw: (ctx: CanvasRenderingContext2D) => void
): string {
  return bakeCanvas(scene, key, logicalW, logicalH, draw, "scene");
}

export function releaseUiTextures(scene: Phaser.Scene): void {
  for (const key of scene.textures.getTextureKeys()) {
    if (key.startsWith("ui-")) scene.textures.remove(key);
  }
}
