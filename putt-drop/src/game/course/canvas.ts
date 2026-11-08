import type { Vec2 } from "../../sim/types.js";
import { TOKENS } from "../../ui/tokens.js";

export function rgb(c: number, a = 1): string {
  return `rgba(${(c >> 16) & 0xff},${(c >> 8) & 0xff},${c & 0xff},${a})`;
}

export function polyPath(ctx: CanvasRenderingContext2D, pts: Vec2[], closed = true): void {
  if (pts.length < 2) return;
  ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])));
  if (closed) ctx.closePath();
}

export function seeded(levelId: string): () => number {
  let h = 0;
  for (let i = 0; i < levelId.length; i++) h = (h * 31 + levelId.charCodeAt(i)) >>> 0;
  return () => {
    h = (h * 16807) % 2147483647;
    return (h - 1) / 2147483646;
  };
}

export function strokePolyline(
  ctx: CanvasRenderingContext2D,
  pts: Vec2[],
  closed: boolean,
  width: number,
  color: string
): void {
  if (pts.length < 2) return;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  polyPath(ctx, pts, closed);
  ctx.stroke();
}

export function clipExcludeZones(
  ctx: CanvasRenderingContext2D,
  outline: Vec2[],
  holes: Vec2[][],
  draw: () => void
): void {
  ctx.save();
  polyPath(ctx, outline);
  ctx.clip();
  for (const hole of holes) {
    polyPath(ctx, hole);
    ctx.clip("evenodd");
  }
  draw();
  ctx.restore();
}

export const C = TOKENS.color;
export const CR = TOKENS.course;
