import type { Level, Vec2 } from "../sim/types.js";
import { TOKENS } from "./tokens.js";

/** Pure (Phaser-free) component geometry, shared by components and unit tests. */

/** Width of a star row variant: 3 stars + 2 gaps (small 66, result 108). */
export function starRowWidth(variant: "small" | "result" = "small"): number {
  const { size, gap } = TOKENS.component.starRow[variant];
  return size * 3 + gap * 2;
}

export function polyArea(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a / 2);
}

/** The course outline: the largest closed wall. Undefined for open-wall-only holes. */
export function courseOutline(level: Level): Vec2[] | undefined {
  let best: Vec2[] | undefined;
  let bestA = 0;
  for (const w of level.walls ?? []) {
    if (!w.closed || w.points.length < 3) continue;
    const a = polyArea(w.points);
    if (a > bestA) {
      bestA = a;
      best = w.points;
    }
  }
  return best;
}
