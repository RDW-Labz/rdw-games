import Phaser from "phaser";
import type { Level, Vec2 } from "../sim/types.js";
import { DEPTH } from "../game/theme.js";
import { bindTap, type InteractiveGo } from "../game/theme.js";
import { registerControlCenter } from "./controls.js";
import { bodyTextStyleUi, displayTextStyle } from "./fonts.js";
import { chip } from "./chip.js";
import { lockBadge } from "./lockBadge.js";
import { starRow } from "./starRow.js";
import { courseOutline, starRowWidth } from "./geometry.js";

export { courseOutline } from "./geometry.js";
import { appearFx, cancelPressFx, pressFx, releaseFx } from "./motion.js";
import { bakeCanvasForScene, bakeFaceTexture, bakePanelTexture, faceImage, roundRectPath } from "./textures.js";
import { TOKENS, cssColor } from "./tokens.js";
import { drawFastTurfZones, drawOneWayGates } from "../game/course/mechanicsArt.js";

function levelBounds(level: Level): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (p: Vec2): void => {
    minX = Math.min(minX, p[0]);
    minY = Math.min(minY, p[1]);
    maxX = Math.max(maxX, p[0]);
    maxY = Math.max(maxY, p[1]);
  };
  for (const w of level.walls ?? []) w.points.forEach(add);
  add(level.tee);
  add(level.cup);
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 360, maxY: 640 };
  return { minX, minY, maxX, maxY };
}

function rgb(c: number, a = 1): string {
  return `rgba(${(c >> 16) & 0xff},${(c >> 8) & 0xff},${c & 0xff},${a})`;
}

function polyPath(ctx: CanvasRenderingContext2D, pts: Vec2[], closed = true): void {
  ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])));
  if (closed) ctx.closePath();
}

/**
 * Bake the hole thumbnail (tw x th logical) from level data: turf island filled from the course
 * outline with a turfEdge extrusion, sand, water, slopes, rails, bumpers, tee ring and cup.
 * Portrait holes are rotated a quarter turn (tee left, cup right) so they fill a landscape thumb.
 * Scene-owned: released when the scene shuts down, so no thumbnail cache outlives its screen.
 */
export function bakeHoleMiniTexture(scene: Phaser.Scene, level: Level, tw = 134, th = 56): string {
  const key = `hole-mini-${level.id}-${tw}x${th}`;
  return bakeCanvasForScene(scene, key, tw, th, (ctx) => {
    const b = levelBounds(level);
    const lw = b.maxX - b.minX;
    const lh = b.maxY - b.minY;
    const rotate = lh > lw && tw > th;
    const srcW = rotate ? lh : lw;
    const srcH = rotate ? lw : lh;
    const inset = Math.max(2, Math.min(6, Math.floor(Math.min(tw, th) / 8)));
    const s = Math.min((tw - inset * 2) / srcW, (th - inset * 2) / srcH);

    // Thumbnail well.
    roundRectPath(ctx, 0, 0, tw, th, TOKENS.radius.small);
    const well = ctx.createLinearGradient(0, 0, 0, th);
    well.addColorStop(0, rgb(TOKENS.color.bgTop));
    well.addColorStop(1, rgb(TOKENS.color.bgBottom));
    ctx.fillStyle = well;
    ctx.fill();
    ctx.save();
    ctx.clip();

    // Level space -> thumbnail: center, uniform scale, optional -90deg rotation (tee ends up left).
    ctx.translate(tw / 2, th / 2);
    ctx.scale(s, s);
    if (rotate) ctx.rotate(Math.PI / 2);
    ctx.translate(-(b.minX + lw / 2), -(b.minY + lh / 2));
    const px = 1 / s; // one logical thumbnail pixel in level units

    const outline = courseOutline(level);
    if (outline) {
      // Extrusion edge, then turf gradient.
      ctx.save();
      ctx.translate(rotate ? 2.5 * px : 0, rotate ? 0 : 2.5 * px);
      polyPath(ctx, outline);
      ctx.fillStyle = rgb(TOKENS.color.turfEdge, 0.4);
      ctx.fill();
      ctx.restore();
      polyPath(ctx, outline);
      const g = rotate
        ? ctx.createLinearGradient(b.minX, 0, b.maxX, 0)
        : ctx.createLinearGradient(0, b.minY, 0, b.maxY);
      g.addColorStop(0, rgb(TOKENS.color.turfTop));
      g.addColorStop(1, rgb(TOKENS.color.turfBottom));
      ctx.fillStyle = g;
      ctx.fill();
    }
    drawFastTurfZones(ctx, level, true);
    for (const z of level.slopes ?? []) {
      polyPath(ctx, z.poly);
      ctx.fillStyle = rgb(TOKENS.color.slope, 0.75);
      ctx.fill();
    }
    for (const z of level.sand ?? []) {
      polyPath(ctx, z.poly);
      ctx.fillStyle = rgb(TOKENS.color.sand);
      ctx.fill();
    }
    for (const z of level.water ?? []) {
      polyPath(ctx, z.poly);
      ctx.fillStyle = rgb(TOKENS.color.waterTop);
      ctx.fill();
      ctx.strokeStyle = rgb(TOKENS.color.waterEdge);
      ctx.lineWidth = px;
      ctx.stroke();
    }
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (const m of level.movers ?? []) {
      ctx.beginPath();
      ctx.moveTo(m.from[0], m.from[1]);
      ctx.lineTo(m.to[0], m.to[1]);
      ctx.strokeStyle = rgb(TOKENS.color.moverEdge, 0.5);
      ctx.lineWidth = px;
      ctx.stroke();
    }
    for (const w of level.walls ?? []) {
      polyPath(ctx, w.points, w.closed);
      ctx.strokeStyle = rgb(TOKENS.color.railUnder);
      ctx.lineWidth = Math.max(TOKENS.course.railBacking, 2.6 * px);
      ctx.stroke();
      ctx.strokeStyle = rgb(TOKENS.color.rail);
      ctx.lineWidth = Math.max(TOKENS.course.railCore, 1.4 * px);
      ctx.stroke();
    }
    drawOneWayGates(ctx, level, px);
    for (const bm of level.bumpers ?? []) {
      ctx.beginPath();
      ctx.arc(bm.x, bm.y, bm.r, 0, Math.PI * 2);
      ctx.fillStyle = rgb(TOKENS.color.bumper);
      ctx.fill();
      ctx.strokeStyle = rgb(TOKENS.color.bumperEdge);
      ctx.lineWidth = px;
      ctx.stroke();
    }
    // Tee ring and cup with flag-tint ring, kept legible at thumbnail scale.
    const teeR = Math.max(10, 3 * px);
    ctx.beginPath();
    ctx.arc(level.tee[0], level.tee[1], teeR, 0, Math.PI * 2);
    ctx.strokeStyle = rgb(TOKENS.color.tee, 0.7);
    ctx.lineWidth = px;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(level.tee[0], level.tee[1], Math.max(7, 1.6 * px), 0, Math.PI * 2);
    ctx.fillStyle = rgb(TOKENS.color.ballLight);
    ctx.fill();
    const cupR = Math.max(TOKENS.course.cupR, 2.4 * px);
    ctx.beginPath();
    ctx.arc(level.cup[0], level.cup[1], cupR + 1.2 * px, 0, Math.PI * 2);
    ctx.fillStyle = rgb(TOKENS.color.flag, 0.35);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(level.cup[0], level.cup[1], cupR, 0, Math.PI * 2);
    ctx.fillStyle = rgb(TOKENS.color.cupDeep);
    ctx.fill();
    ctx.restore();
  });
}

export interface HoleCardOptions {
  highlighted?: boolean;
  locked?: boolean;
  stars: number;
  par: number;
  holeNum: number;
  level: Level;
  id?: string;
  onPick?: () => void;
  /** Defaults to stars > 0. */
  completed?: boolean;
  best?: number;
}

/**
 * Hole card centered on (x, y), face w x h (spec 158 x 152). States: available ("Play"),
 * current (selectedEdge 2 + "Next"), completed (stars + best), locked (lock badge, never launches).
 */
export function holeCard(
  scene: Phaser.Scene,
  x: number,
  y: number,
  w: number,
  h: number,
  opts: HoleCardOptions
): Phaser.GameObjects.Container {
  const pad = TOKENS.component.holeCard.pad;
  const completed = !opts.locked && (opts.completed ?? opts.stars > 0);
  const current = !!opts.highlighted && !opts.locked;

  // One face texture per state: current cards bake the 2px selectedEdge into the face (no overlay outline).
  const key = current
    ? bakeFaceTexture(scene, "holecard-current", {
        w,
        h,
        r: TOKENS.radius.card,
        top: "surfaceTop",
        bottom: "surfaceBottom",
        shadow: "card",
        border: { color: "selectedEdge", width: TOKENS.stroke.selected },
      })
    : bakePanelTexture(scene, w, h, "card");
  const face = faceImage(scene, key, w, h);

  const left = -w / 2 + pad;
  const top = -h / 2 + pad;
  const headerCy = top + 12;

  const numT = scene.add
    .text(Math.round(left), 0, `${opts.holeNum}`, displayTextStyle(TOKENS.type.hole.size, TOKENS.type.hole.weight, TOKENS.textPrimary))
    .setOrigin(0, 0);
  numT.y = Math.round(headerCy - numT.height / 2);

  // Par as a chip when it fits beside the number; narrow cards fall back to a caption (no overlap).
  let parChip: Phaser.GameObjects.Container | Phaser.GameObjects.Text = chip(scene, 0, headerCy, `Par ${opts.par}`);
  if (numT.width + TOKENS.space.xs + parChip.width > w - pad * 2) {
    parChip.destroy();
    const t = scene.add
      .text(0, 0, `Par ${opts.par}`, bodyTextStyleUi(TOKENS.type.caption.size, TOKENS.type.caption.weight, cssColor("textMuted")))
      .setOrigin(0, 0);
    t.setPosition(Math.round(w / 2 - pad - t.width), Math.round(headerCy - t.height / 2));
    t.setSize(t.width, t.height);
    parChip = t;
  } else {
    parChip.x = Math.round(w / 2 - pad - parChip.width / 2);
  }
  const parLeft = parChip instanceof Phaser.GameObjects.Text ? parChip.x : parChip.x - parChip.width / 2;

  // Footer band: 28 high when it holds a badge/stars, 18 for a caption.
  const footerH = opts.locked || completed ? TOKENS.component.lockBadge.h : TOKENS.type.caption.lineHeight;
  const footerCy = h / 2 - pad - footerH / 2;
  const thumbTop = top + 28;
  const thumbW = w - pad * 2;
  const thumbH = Math.floor(
    Math.max(16, Math.min(TOKENS.component.holeCard.thumbH, footerCy - footerH / 2 - TOKENS.space.sm - thumbTop))
  );
  const mini = scene.add
    .image(0, Math.round(thumbTop + thumbH / 2), bakeHoleMiniTexture(scene, opts.level, thumbW, thumbH))
    .setDisplaySize(thumbW, thumbH)
    .setAlpha(opts.locked ? 0.42 : 1);

  const parts: Phaser.GameObjects.GameObject[] = [face, mini, numT, parChip];
  const caption = (txt: string, color: string): Phaser.GameObjects.Text =>
    scene.add.text(0, 0, txt, bodyTextStyleUi(TOKENS.type.caption.size, TOKENS.type.caption.weight, color)).setOrigin(0, 0);

  if (opts.locked) {
    parts.push(lockBadge(scene, 0, footerCy));
  } else if (completed) {
    const stars = starRow(scene, 0, footerCy, opts.stars, "small");
    stars.x = left + starRowWidth("small") / 2;
    const best = caption(opts.best !== undefined ? `Best ${opts.best}` : "Done", cssColor("textMuted"));
    if (starRowWidth("small") + TOKENS.space.sm + best.width <= w - pad * 2) {
      best.setPosition(Math.round(w / 2 - pad - best.width), Math.round(footerCy - best.height / 2));
      parts.push(stars, best);
    } else {
      // Narrow card: stars only, centered (best score stays on the result/select detail).
      stars.x = 0;
      best.destroy();
      parts.push(stars);
    }
  } else {
    const t = caption(current ? "Next" : "Play", current ? cssColor("success") : cssColor("text"));
    t.setPosition(-Math.round(t.width / 2), Math.round(footerCy - t.height / 2));
    parts.push(t);
  }

  if (current && completed) {
    // "Next" in the header between number and par chip, only when it fits.
    const t = caption("Next", cssColor("success"));
    const room = parLeft - (left + numT.width);
    if (room >= t.width + 8) {
      const mid = (left + numT.width + parLeft) / 2;
      t.setPosition(Math.round(mid - t.width / 2), Math.round(headerCy - t.height / 2));
      parts.push(t);
    } else t.destroy();
  }

  const c = scene.add.container(x, y, parts);
  c.setSize(w, h);
  c.setDepth(DEPTH.hud);
  appearFx(scene, [face], { card: true });

  if (opts.onPick) {
    const hit = scene.add.rectangle(0, 0, w, h, 0x000000, 0.001).setInteractive({ useHandCursor: true });
    c.add(hit);
    if (opts.id) registerControlCenter(opts.id, scene.scene.key, x, y, w, h, c, "card", hit);
    const fx = { scene, face };
    bindTap(hit as InteractiveGo, () => opts.onPick?.(), () => pressFx(fx));
    hit.on("pointerup", () => releaseFx(fx));
    hit.on("pointerout", () => cancelPressFx(fx));
  }

  return c;
}
