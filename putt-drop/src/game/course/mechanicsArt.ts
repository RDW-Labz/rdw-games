import type { Level, OneWayGate, Vec2 } from "../../sim/types.js";
import { C, polyPath, rgb, seeded } from "./canvas.js";
import { LOGICAL_H, LOGICAL_W } from "../display.js";
import { pointInPoly } from "./bakeStatic.js";

/** Shared fast-turf and wicket drawing for the baked board and hole-card minis. */
export function drawFastTurfZones(
  ctx: CanvasRenderingContext2D,
  level: Level,
  mini = false
): void {
  const zones = level.fastTurf ?? [];
  if (!zones.length) return;
  const rnd = seeded(`${level.id}-dew`);
  for (const z of zones) {
    const b = polyBounds(z.poly);
    polyPath(ctx, z.poly);
    const fill = ctx.createLinearGradient(b.minX, b.minY, b.maxX, b.maxY);
    // Opaque dew surface (distinct from base turf when baked; still reads pale in probes).
    fill.addColorStop(0, rgb(C.waterRipple));
    fill.addColorStop(0.55, rgb(C.highlight));
    fill.addColorStop(1, rgb(C.waterRipple));
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = rgb(C.waterEdge, mini ? 0.85 : 1);
    ctx.lineWidth = mini ? 1 : 1.5;
    polyPath(ctx, z.poly);
    ctx.stroke();

    ctx.save();
    polyPath(ctx, z.poly);
    ctx.clip();
    // Tighter, brighter mowing stripes (distinct from base turf).
    const strip = mini ? 4 : 16;
    const rot = (-18 * Math.PI) / 180;
    ctx.translate((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2);
    ctx.rotate(rot);
    ctx.translate(-(b.minX + b.maxX) / 2, -(b.minY + b.maxY) / 2);
    ctx.fillStyle = rgb(C.highlight, mini ? 0.12 : 0.11);
    for (let x = b.minX - LOGICAL_W; x < b.maxX + LOGICAL_W; x += strip * 2) {
      ctx.fillRect(x, b.minY - 8, strip, b.maxY - b.minY + 16);
    }
    // Colorblind-readable cross-hatch (not color alone).
    ctx.strokeStyle = rgb(C.waterEdge, mini ? 0.25 : 0.22);
    ctx.lineWidth = mini ? 0.6 : 1;
    const step = mini ? 10 : 22;
    ctx.beginPath();
    for (let x = b.minX; x < b.maxX; x += step) {
      ctx.moveTo(x, b.minY);
      ctx.lineTo(x + step * 0.6, b.maxY);
    }
    ctx.stroke();
    // Botanical leaf dashes (rounded dew marks).
    ctx.strokeStyle = rgb(C.secondary, mini ? 0.45 : 0.5);
    ctx.lineWidth = mini ? 1 : 1.6;
    ctx.lineCap = "round";
    const dashN = mini ? 12 : 28;
    for (let i = 0; i < dashN; i++) {
      const x = b.minX + 4 + rnd() * (b.maxX - b.minX - 8);
      const y = b.minY + 4 + rnd() * (b.maxY - b.minY - 8);
      if (!pointInPoly(x, y, z.poly)) continue;
      const a = rnd() * Math.PI * 2;
      const len = mini ? 3 : 7;
      ctx.beginPath();
      ctx.moveTo(x - Math.cos(a) * len, y - Math.sin(a) * len * 0.35);
      ctx.quadraticCurveTo(x + Math.cos(a) * len * 0.2, y + Math.sin(a) * len * 0.2, x + Math.cos(a) * len, y + Math.sin(a) * len * 0.35);
      ctx.stroke();
    }
    ctx.restore();
  }
}

/** `miniPx`: one thumbnail pixel in level units (hole-card minis); omit for the full-size board. */
export function drawOneWayGates(ctx: CanvasRenderingContext2D, level: Level, miniPx?: number): void {
  for (const gate of level.oneWayGates ?? []) {
    if (miniPx) drawMiniGate(ctx, gate, miniPx);
    else drawOneWayGate(ctx, gate);
  }
}

/** Thumbnail wicket sized in thumbnail pixels: solid coral bar, cream posts, one direction chevron. */
function drawMiniGate(ctx: CanvasRenderingContext2D, gate: OneWayGate, px: number): void {
  const [ax, ay] = gate.from;
  const [bx, by] = gate.to;
  const [nx, ny] = gate.normal;
  const len = Math.hypot(bx - ax, by - ay) || 1;
  const tx = (bx - ax) / len;
  const ty = (by - ay) / len;
  ctx.save();
  ctx.lineCap = "butt";
  ctx.strokeStyle = rgb(C.primaryTop);
  ctx.lineWidth = 2 * px;
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.stroke();
  for (const [x, y] of [gate.from, gate.to]) {
    ctx.beginPath();
    ctx.arc(x, y, 1.5 * px, 0, Math.PI * 2);
    ctx.fillStyle = rgb(C.rail);
    ctx.fill();
  }
  const cx = (ax + bx) / 2;
  const cy = (ay + by) / 2;
  const c = 2.5 * px;
  ctx.strokeStyle = rgb(C.text, 0.85);
  ctx.lineWidth = px;
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(cx - tx * c + nx * c * 0.4, cy - ty * c + ny * c * 0.4);
  ctx.lineTo(cx + nx * c * 1.6, cy + ny * c * 1.6);
  ctx.lineTo(cx + tx * c + nx * c * 0.4, cy + ty * c + ny * c * 0.4);
  ctx.stroke();
  ctx.restore();
}

export function drawOneWayGate(ctx: CanvasRenderingContext2D, gate: OneWayGate, mini = false): void {
  const [ax, ay] = gate.from;
  const [bx, by] = gate.to;
  const [nx, ny] = gate.normal;
  const len = Math.hypot(bx - ax, by - ay) || 1;
  const tx = (bx - ax) / len;
  const ty = (by - ay) / len;
  ctx.save();
  ctx.setLineDash(mini ? [3, 3] : [5, 4]);
  ctx.strokeStyle = rgb(C.primaryTop, mini ? 0.9 : 1);
  ctx.lineWidth = mini ? 2 : 4;
  // Butt caps: round caps would fill the dash gaps and turn the strip into a solid rail.
  ctx.lineCap = "butt";
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.stroke();
  ctx.restore();
  // Posts sit on top of the strip ends, like a croquet hoop's legs.
  const postR = mini ? 2.2 : 4;
  for (const [x, y] of [gate.from, gate.to]) {
    ctx.beginPath();
    ctx.arc(x, y, postR + (mini ? 0 : 1), 0, Math.PI * 2);
    ctx.fillStyle = rgb(C.rail);
    ctx.fill();
    ctx.strokeStyle = rgb(C.railUnder);
    ctx.lineWidth = mini ? 0.8 : 1.2;
    ctx.stroke();
  }
  // Chevrons on the allowed side; blocked side gets a muted band.
  const chev = mini ? 3 : 5;
  ctx.strokeStyle = rgb(C.text, mini ? 0.75 : 0.85);
  ctx.fillStyle = rgb(C.text, mini ? 0.75 : 0.85);
  ctx.lineWidth = mini ? 1 : 2;
  ctx.lineJoin = "round";
  for (const f of [0.25, 0.5, 0.75]) {
    const x = ax + (bx - ax) * f;
    const y = ay + (by - ay) * f;
    const tipX = x + nx * chev;
    const tipY = y + ny * chev;
    ctx.beginPath();
    ctx.moveTo(x - tx * chev - nx * chev * 0.8, y - ty * chev - ny * chev * 0.8);
    ctx.lineTo(tipX, tipY);
    ctx.lineTo(x + tx * chev - nx * chev * 0.8, y + ty * chev - ny * chev * 0.8);
    ctx.stroke();
  }
  // Blocking face: soft coral wash on the +normal side, beyond the chevron tips. A ball arriving
  // from this side bounces (worlds.md: reverse motion from the normal-facing side reflects).
  const near = mini ? 3.5 : 7;
  const far = near + (mini ? 8 : 14);
  ctx.beginPath();
  ctx.moveTo(ax + nx * near, ay + ny * near);
  ctx.lineTo(bx + nx * near, by + ny * near);
  ctx.lineTo(bx + nx * far, by + ny * far);
  ctx.lineTo(ax + nx * far, ay + ny * far);
  ctx.closePath();
  ctx.fillStyle = rgb(C.primaryBottom, mini ? 0.12 : 0.14);
  ctx.fill();
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

/** Centre of the largest fast-turf patch (for alignment probes). */
export function fastTurfSamplePoint(level: Level): Vec2 | null {
  const zones = level.fastTurf ?? [];
  if (!zones.length) return null;
  let best = zones[0];
  let bestA = 0;
  for (const z of zones) {
    const b = polyBounds(z.poly);
    const a = (b.maxX - b.minX) * (b.maxY - b.minY);
    if (a > bestA) {
      bestA = a;
      best = z;
    }
  }
  const b = polyBounds(best.poly);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  if (pointInPoly(cx, cy, best.poly)) return [cx, cy];
  return best.poly[0];
}

/** Point on the wicket hoop strip (for alignment probes). */
export function wicketSamplePoint(level: Level): Vec2 | null {
  const gate = level.oneWayGates?.[0];
  if (!gate) return null;
  const [ax, ay] = gate.from;
  const [bx, by] = gate.to;
  return [(ax + bx) / 2, (ay + by) / 2];
}
