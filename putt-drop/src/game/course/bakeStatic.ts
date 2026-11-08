import Phaser from "phaser";
import type { Level, Vec2 } from "../../sim/types.js";
import { courseOutline } from "../../ui/geometry.js";
import { LOGICAL_H, LOGICAL_W } from "../display.js";
import { C, CR, polyPath, rgb, seeded, strokePolyline } from "./canvas.js";
import { CUP_R } from "../../sim/physics.js";
import { bakeRect, type CourseFrame } from "./frame.js";
import { drawFastTurfZones, drawOneWayGates } from "./mechanicsArt.js";

function drawIslandShadow(ctx: CanvasRenderingContext2D, outline: Vec2[]): void {
  // Outside shadow silhouettes (0,10)/(0,14), spread 4/8, alpha 0.10/0.05.
  for (const [dy, spread, alpha] of [
    [14, 8, 0.05],
    [10, 4, 0.1],
  ] as const) {
    ctx.save();
    ctx.translate(0, dy);
    polyPath(ctx, outline);
    ctx.fillStyle = rgb(C.shadow, alpha);
    ctx.fill();
    ctx.lineJoin = "round";
    ctx.lineWidth = spread * 2;
    ctx.strokeStyle = rgb(C.shadow, alpha);
    ctx.stroke();
    ctx.restore();
  }
}

function drawTurf(ctx: CanvasRenderingContext2D, outline: Vec2[]): void {
  // Raised edge: extrude downward 9 in turfEdge alpha 0.40, only outside the original polygon.
  ctx.save();
  ctx.beginPath();
  ctx.rect(-40, -40, LOGICAL_W + 80, LOGICAL_H + 80);
  outline.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])));
  ctx.closePath();
  ctx.clip("evenodd");
  ctx.translate(0, CR.islandExtrude);
  polyPath(ctx, outline);
  ctx.fillStyle = rgb(C.turfEdge, 0.4);
  ctx.fill();
  ctx.restore();

  polyPath(ctx, outline);
  const g = ctx.createLinearGradient(0, 0, 0, LOGICAL_H);
  g.addColorStop(0, rgb(C.turfTop));
  g.addColorStop(1, rgb(C.turfBottom));
  ctx.fillStyle = g;
  ctx.fill();

  ctx.save();
  polyPath(ctx, outline);
  ctx.clip();
  // Mowing: alternating 32-wide strips on a 64 repeat, rotated -24 deg, highlight alpha 0.065.
  ctx.save();
  const strip = CR.mowingStrip;
  const rot = (CR.mowingRotation * Math.PI) / 180;
  ctx.translate(LOGICAL_W / 2, LOGICAL_H / 2);
  ctx.rotate(rot);
  ctx.translate(-LOGICAL_W / 2, -LOGICAL_H / 2);
  ctx.fillStyle = rgb(C.highlight, 0.065);
  for (let x = -LOGICAL_W; x < LOGICAL_W * 2; x += CR.mowingRepeat) {
    ctx.fillRect(x, -LOGICAL_H, strip, LOGICAL_H * 3);
  }
  ctx.restore();
  // Deterministic 17x19 grain tile: dots r0.7 at (3,4), r0.6 at (12,14), alpha 0.08.
  ctx.fillStyle = rgb(C.turfGrain, 0.08);
  ctx.beginPath();
  for (let ty = 0; ty < LOGICAL_H; ty += 19) {
    for (let tx = 0; tx < LOGICAL_W; tx += 17) {
      ctx.moveTo(tx + 3 + 0.7, ty + 4);
      ctx.arc(tx + 3, ty + 4, 0.7, 0, Math.PI * 2);
      ctx.moveTo(tx + 12 + 0.6, ty + 14);
      ctx.arc(tx + 12, ty + 14, 0.6, 0, Math.PI * 2);
    }
  }
  ctx.fill();
  ctx.restore();
}

function polyBounds(poly: Vec2[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p[0]);
    minY = Math.min(minY, p[1]);
    maxX = Math.max(maxX, p[0]);
    maxY = Math.max(maxY, p[1]);
  }
  return { minX, minY, maxX, maxY };
}

/** Chevron arrows (stroke 2, length 10, grid 26x27) aligned with the slope force. Shared with the shimmer patch. */
export function drawSlopeArrows(ctx: CanvasRenderingContext2D, poly: Vec2[], force: Vec2, color: string): void {
  const [fx, fy] = force;
  const fl = Math.hypot(fx, fy);
  if (fl < 1e-6) return;
  const ux = fx / fl;
  const uy = fy / fl;
  const nx = -uy;
  const ny = ux;
  const b = polyBounds(poly);
  ctx.save();
  polyPath(ctx, poly);
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  for (let oy = cy - Math.ceil((cy - b.minY) / 27) * 27; oy <= b.maxY; oy += 27) {
    for (let ox = cx - Math.ceil((cx - b.minX) / 26) * 26; ox <= b.maxX; ox += 26) {
      if (!pointInPoly(ox, oy, poly)) continue;
      ctx.beginPath();
      ctx.moveTo(ox - ux * 5, oy - uy * 5);
      ctx.lineTo(ox + ux * 5, oy + uy * 5);
      ctx.moveTo(ox + ux * 1 - nx * 4, oy + uy * 1 - ny * 4);
      ctx.lineTo(ox + ux * 5, oy + uy * 5);
      ctx.lineTo(ox + ux * 1 + nx * 4, oy + uy * 1 + ny * 4);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawSlopes(ctx: CanvasRenderingContext2D, level: Level): void {
  for (const s of level.slopes) {
    polyPath(ctx, s.poly);
    ctx.fillStyle = rgb(C.slope, 0.75);
    ctx.fill();
    // Highlight at the upstream edge, alpha 0.10.
    const fl = Math.hypot(s.force[0], s.force[1]);
    if (fl > 1e-6) {
      const b = polyBounds(s.poly);
      const ux = s.force[0] / fl;
      const uy = s.force[1] / fl;
      const cx = (b.minX + b.maxX) / 2;
      const cy = (b.minY + b.maxY) / 2;
      const half = Math.max(b.maxX - b.minX, b.maxY - b.minY) / 2;
      const g = ctx.createLinearGradient(cx - ux * half, cy - uy * half, cx, cy);
      g.addColorStop(0, rgb(C.highlight, 0.1));
      g.addColorStop(1, rgb(C.highlight, 0));
      polyPath(ctx, s.poly);
      ctx.fillStyle = g;
      ctx.fill();
    }
    drawSlopeArrows(ctx, s.poly, s.force, rgb(C.slopeArrow, 1));
  }
}

function drawSand(ctx: CanvasRenderingContext2D, level: Level, rnd: () => number): void {
  for (const z of level.sand) {
    const b = polyBounds(z.poly);
    polyPath(ctx, z.poly);
    const g = ctx.createLinearGradient(0, b.minY, 0, b.maxY);
    g.addColorStop(0, rgb(C.sand));
    g.addColorStop(1, rgb(C.sandLight));
    ctx.fillStyle = g;
    ctx.fill();
    ctx.save();
    polyPath(ctx, z.poly);
    ctx.clip();
    // Inner 2px soft band (drawn as a 4px stroke clipped to the polygon).
    ctx.strokeStyle = rgb(C.sandLight, 0.35);
    ctx.lineWidth = 4;
    polyPath(ctx, z.poly);
    ctx.stroke();
    // Deterministic dots radius 0.8, minimum spacing 6, never outside the polygon.
    const placed: Vec2[] = [];
    ctx.fillStyle = rgb(C.sandDot, 0.25);
    for (let i = 0; i < 400 && placed.length < 40; i++) {
      const x = b.minX + 2 + rnd() * (b.maxX - b.minX - 4);
      const y = b.minY + 2 + rnd() * (b.maxY - b.minY - 4);
      if (!pointInPoly(x, y, z.poly) || minDistToOutline(x, y, z.poly) < 2) continue;
      if (placed.some((p) => Math.hypot(p[0] - x, p[1] - y) < 6)) continue;
      placed.push([x, y]);
      ctx.beginPath();
      ctx.arc(x, y, 0.8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

function drawWater(ctx: CanvasRenderingContext2D, level: Level): void {
  for (const z of level.water) {
    const b = polyBounds(z.poly);
    polyPath(ctx, z.poly);
    const g = ctx.createLinearGradient(0, b.minY, 0, b.maxY);
    g.addColorStop(0, rgb(C.waterTop));
    g.addColorStop(1, rgb(C.waterBottom));
    ctx.fillStyle = g;
    ctx.fill();
    ctx.save();
    polyPath(ctx, z.poly);
    ctx.clip();
    // Broken ripple tile 32x26, line 1.4, alpha 0.27.
    ctx.strokeStyle = rgb(C.waterRipple, 0.27);
    ctx.lineWidth = 1.4;
    ctx.lineCap = "round";
    ctx.beginPath();
    for (let y = Math.floor(b.minY / 26) * 26 + 13; y < b.maxY; y += 26) {
      const shift = (Math.round(y / 26) % 2) * 16;
      for (let x = Math.floor(b.minX / 32) * 32 + shift; x < b.maxX; x += 32) {
        ctx.moveTo(x + 4, y);
        ctx.quadraticCurveTo(x + 10, y - 3, x + 16, y);
      }
    }
    ctx.stroke();
    // Inner 2 waterEdge contour.
    ctx.strokeStyle = rgb(C.waterEdge);
    ctx.lineWidth = 4;
    polyPath(ctx, z.poly);
    ctx.stroke();
    ctx.restore();
  }
}

function drawMoverTracks(ctx: CanvasRenderingContext2D, level: Level): void {
  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = rgb(C.moverEdge, 0.5);
  ctx.lineWidth = 2;
  for (const m of level.movers) {
    ctx.beginPath();
    ctx.moveTo(m.from[0], m.from[1]);
    ctx.lineTo(m.to[0], m.to[1]);
    ctx.stroke();
  }
  ctx.restore();
}

function drawRails(ctx: CanvasRenderingContext2D, level: Level, outline: Vec2[] | undefined): void {
  // Shadow first (offset 0,2, alpha 0.18) so it reads as a drop shadow under the rail.
  for (const wall of level.walls) {
    if (wall.points.length < 2) continue;
    ctx.save();
    ctx.translate(0, 2);
    strokePolyline(ctx, wall.points, wall.closed, CR.railBacking, rgb(C.shadow, 0.18));
    ctx.restore();
  }
  for (const wall of level.walls) {
    const pts = wall.points;
    if (pts.length < 2) continue;
    const interior = wall.points !== outline;
    strokePolyline(ctx, pts, wall.closed, interior ? 10 : CR.railBacking, rgb(C.railUnder));
    strokePolyline(ctx, pts, wall.closed, CR.railCore, rgb(C.rail));
    ctx.save();
    ctx.translate(0, -1);
    strokePolyline(ctx, pts, wall.closed, 1, rgb(C.railHighlight));
    ctx.restore();
    // Wood seams every 32, length 2, alpha 0.15.
    ctx.strokeStyle = rgb(C.railUnder, 0.15);
    ctx.lineWidth = 1;
    const n = pts.length;
    const segs = wall.closed ? n : n - 1;
    let carry = 0;
    ctx.beginPath();
    for (let i = 0; i < segs; i++) {
      const a = pts[i];
      const bb = pts[(i + 1) % n];
      const dx = bb[0] - a[0];
      const dy = bb[1] - a[1];
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      const ux = dx / len;
      const uy = dy / len;
      for (let t = 32 - carry; t < len; t += 32) {
        const px = a[0] + ux * t;
        const py = a[1] + uy * t;
        ctx.moveTo(px - uy * 2, py + ux * 2);
        ctx.lineTo(px + uy * 2, py - ux * 2);
      }
      carry = (carry + len) % 32;
    }
    ctx.stroke();
  }
}

function drawBumpers(ctx: CanvasRenderingContext2D, level: Level): void {
  // Puck only: contact rim + body. The crown is a separate sprite (bumperBoing animates it).
  for (const b of level.bumpers) {
    ctx.beginPath();
    ctx.arc(b.x, b.y + 2, b.r, 0, Math.PI * 2);
    ctx.fillStyle = rgb(C.shadow, 0.18);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fillStyle = rgb(C.bumperEdge);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r - 2, 0, Math.PI * 2);
    ctx.fillStyle = rgb(C.bumper);
    ctx.fill();
  }
}

function drawCupBase(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
  // Flag-tint target ring r14 alpha 0.24, cupDeep well, inner crescent offset (0,2), rail lip 1.5 at r11.
  ctx.beginPath();
  ctx.arc(cx, cy, CUP_R + 3, 0, Math.PI * 2);
  ctx.fillStyle = rgb(C.flag, 0.24);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, CUP_R, 0, Math.PI * 2);
  ctx.fillStyle = rgb(C.cupDeep);
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, CUP_R, 0, Math.PI * 2);
  ctx.clip();
  ctx.beginPath();
  ctx.arc(cx, cy + 2, CUP_R - 1, Math.PI * 0.2, Math.PI * 0.8);
  ctx.strokeStyle = rgb(C.cup);
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
  ctx.strokeStyle = rgb(C.rail);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, CUP_R, 0, Math.PI * 2);
  ctx.stroke();
  // Fixed pole width 2 / height 38 with a soft shadow.
  const poleX = cx + CUP_R - 1;
  ctx.strokeStyle = rgb(C.shadow, 0.2);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(poleX + 2, cy + 1);
  ctx.lineTo(poleX + 8, cy - 4);
  ctx.stroke();
  ctx.strokeStyle = rgb(C.railUnder);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(poleX, cy);
  ctx.lineTo(poleX, cy - 38);
  ctx.stroke();
}

function drawTee(ctx: CanvasRenderingContext2D, tx: number, ty: number): void {
  // Broken ring r10, stroke 1, tee alpha 0.45, two opposing 3-long ticks.
  ctx.strokeStyle = rgb(C.tee, 0.45);
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    const a0 = (i * Math.PI) / 2 + 0.25;
    ctx.beginPath();
    ctx.arc(tx, ty, 10, a0, a0 + Math.PI / 2 - 0.5);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(tx - 13, ty);
  ctx.lineTo(tx - 10, ty);
  ctx.moveTo(tx + 10, ty);
  ctx.lineTo(tx + 13, ty);
  ctx.stroke();
}

export function pointInPoly(x: number, y: number, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-9) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function minDistToOutline(x: number, y: number, outline: Vec2[]): number {
  let best = 1e9;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    best = Math.min(best, distToSegment(x, y, a[0], a[1], b[0], b[1]));
  }
  return best;
}

/** True when a decoration of radius r at (x,y) keeps an 18-unit clearance from every playable surface. */
function clearOfCourse(level: Level, outline: Vec2[], x: number, y: number, r: number): boolean {
  if (x - r < 4 || x + r > LOGICAL_W - 4 || y - r < 4 || y + r > LOGICAL_H - 4) return false;
  if (pointInPoly(x, y, outline)) return false;
  if (minDistToOutline(x, y, outline) < r + 18) return false;
  for (const w of level.walls) {
    if (minDistToOutline(x, y, w.points) < r + 18) return false;
  }
  for (const m of level.movers) {
    if (distToSegment(x, y, m.from[0], m.from[1], m.to[0], m.to[1]) < r + 18 + m.width / 2) return false;
  }
  return true;
}

function drawPlanting(ctx: CanvasRenderingContext2D, level: Level, outline: Vec2[], rnd: () => number): void {
  // At most 3 tree groups (trunk 6x20, canopies r14/r20), outside the course with an 18-unit clearance.
  const trees: Vec2[] = [];
  for (let y = 40; y < LOGICAL_H - 40 && trees.length < 3; y += 26) {
    for (let x = 30; x < LOGICAL_W - 30 && trees.length < 3; x += 26) {
      if (rnd() > 0.3) continue;
      if (!clearOfCourse(level, outline, x, y - 8, 22)) continue;
      if (trees.some((t) => Math.hypot(t[0] - x, t[1] - y) < 60)) continue;
      trees.push([x, y]);
    }
  }
  for (const [x, y] of trees) {
    ctx.fillStyle = rgb(C.shadow, 0.12);
    ctx.beginPath();
    ctx.ellipse(x + 4, y + 10, 14, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = rgb(C.trunk);
    ctx.fillRect(x - 3, y - 6, 6, 20);
    ctx.beginPath();
    ctx.arc(x, y - 14, 20, 0, Math.PI * 2);
    ctx.fillStyle = rgb(C.tree);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x - 4, y - 18, 14, 0, Math.PI * 2);
    ctx.fillStyle = rgb(C.treeLight);
    ctx.fill();
  }
  // Bushes (r6/10/14) and flowers (four r2 petals, sandLight center r1); groups separated 12.
  const placed: Vec2[] = [...trees];
  for (let i = 0; i < 40 && placed.length < trees.length + 6; i++) {
    const x = 20 + rnd() * (LOGICAL_W - 40);
    const y = 20 + rnd() * (LOGICAL_H - 40);
    if (!clearOfCourse(level, outline, x, y, 14)) continue;
    if (placed.some((p) => Math.hypot(p[0] - x, p[1] - y) < 40 + 12)) continue;
    placed.push([x, y]);
    if (i % 2 === 0) {
      for (const [r, dx, dy, c] of [
        [14, 0, 0, C.tree],
        [10, 8, 3, C.treeLight],
        [6, -9, 5, C.treeLight],
      ] as const) {
        ctx.beginPath();
        ctx.arc(x + dx, y + dy, r, 0, Math.PI * 2);
        ctx.fillStyle = rgb(c);
        ctx.fill();
      }
    } else {
      for (const [fx, fy] of [
        [0, 0],
        [9, 4],
        [-7, 6],
      ] as const) {
        ctx.fillStyle = rgb(C.flower);
        for (let k = 0; k < 4; k++) {
          const a = (k * Math.PI) / 2;
          ctx.beginPath();
          ctx.arc(x + fx + Math.cos(a) * 2, y + fy + Math.sin(a) * 2, 2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(x + fx, y + fy, 1, 0, Math.PI * 2);
        ctx.fillStyle = rgb(C.sandLight);
        ctx.fill();
      }
    }
  }
}

/** Draws the whole static course in world units (level coordinates). */
export function drawCourse(ctx: CanvasRenderingContext2D, level: Level): void {
  const outline = courseOutline(level);
  const rnd = seeded(level.id || "hole");
  if (outline) {
    drawPlanting(ctx, level, outline, rnd);
    drawIslandShadow(ctx, outline);
    drawTurf(ctx, outline);
  }
  drawSlopes(ctx, level);
  drawFastTurfZones(ctx, level);
  drawSand(ctx, level, rnd);
  drawWater(ctx, level);
  drawMoverTracks(ctx, level);
  drawRails(ctx, level, outline);
  drawBumpers(ctx, level);
  drawOneWayGates(ctx, level);
  drawCupBase(ctx, level.cup[0], level.cup[1]);
  drawTee(ctx, level.tee[0], level.tee[1]);
}

export interface BakedBoard {
  key: string;
  /** UI-space top-left and display size of the baked image. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Bakes the course once per hole directly at device resolution: one texel per device pixel,
 * snapped to whole device pixels, so the image needs no further scaling (fixes the double scale).
 */
export function bakeCourseBoard(
  scene: Phaser.Scene,
  level: Level,
  key: string,
  frame: CourseFrame,
  renderScale: number
): BakedBoard {
  const rect = bakeRect(frame, renderScale);
  const out: BakedBoard = {
    key,
    x: rect.x / renderScale,
    y: rect.y / renderScale,
    w: rect.w / renderScale,
    h: rect.h / renderScale,
  };
  if (scene.textures.exists(key)) return out;
  const tex = scene.textures.createCanvas(key, rect.w, rect.h);
  if (tex == null) return out;
  const canvas = tex.getSourceImage() as HTMLCanvasElement;
  const ctx = canvas.getContext("2d");
  if (ctx == null) return out;
  ctx.setTransform(rect.s, 0, 0, rect.s, frame.ox * renderScale - rect.x, frame.oy * renderScale - rect.y);
  drawCourse(ctx, level);
  tex.refresh();
  return out;
}
