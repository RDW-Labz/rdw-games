import type { PolyZone, SimEvent, Vec2 } from "./types.js";

function inside(x: number, y: number, poly: Vec2[]): boolean {
  let result = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
  }
  return result;
}

/** Swept center coverage, including thin polygons and overlapping patches.
 * Occupancy only drives events; friction has no hidden phase or cooldown. */
export function fastTurfTracker(zones: PolyZone[], events: SimEvent[]) {
  const patches = zones.map(({ poly }) => {
    const left = Math.min(...poly.map(p => p[0])), right = Math.max(...poly.map(p => p[0]));
    const top = Math.min(...poly.map(p => p[1])), bottom = Math.max(...poly.map(p => p[1]));
    const rectangle = poly.length === 4 && poly.every((p, i) => {
      const next = poly[(i + 1) % poly.length];
      return (p[0] === left || p[0] === right) && (p[1] === top || p[1] === bottom)
        && ((p[0] === next[0]) !== (p[1] === next[1]));
    });
    return { poly, left, right, top, bottom, rectangle };
  });
  const occupied = zones.map(() => false);
  function transition(index: number, active: boolean, x: number, y: number) {
    if (occupied[index] === active) return;
    occupied[index] = active;
    events.push({ type: active ? "fast-turf-enter" : "fast-turf-exit", index, x, y });
  }
  return {
    start(x: number, y: number) {
      patches.forEach((p, i) => { occupied[i] = false; transition(i, inside(x, y, p.poly), x, y); });
    },
    reset(x: number, y: number) { patches.forEach((_, i) => transition(i, false, x, y)); },
    sweep(ax: number, ay: number, bx: number, by: number): number {
      const dx = bx - ax, dy = by - ay;
      const intervals: [number, number][] = [];
      patches.forEach((p, index) => {
        if (Math.max(ax, bx) < p.left || Math.min(ax, bx) > p.right
          || Math.max(ay, by) < p.top || Math.min(ay, by) > p.bottom) return;
        // A wholly interior rectangular step cannot cross an edge. This common
        // case has exactly the same coverage and events as the general sweep.
        if (p.rectangle && Math.min(ax, bx) > p.left && Math.max(ax, bx) < p.right
          && Math.min(ay, by) > p.top && Math.max(ay, by) < p.bottom) {
          transition(index, true, ax, ay);
          intervals.push([0, 1]);
          return;
        }
        const cuts = [0, 1];
        for (let i = 0; i < p.poly.length; i++) {
          const a = p.poly[i], b = p.poly[(i + 1) % p.poly.length];
          const ex = b[0] - a[0], ey = b[1] - a[1];
          const cross = dx * ey - dy * ex;
          if (Math.abs(cross) < 1e-12) continue;
          const rx = a[0] - ax, ry = a[1] - ay;
          const t = (rx * ey - ry * ex) / cross, u = (rx * dy - ry * dx) / cross;
          if (t > 0 && t < 1 && u >= 0 && u <= 1) cuts.push(t);
        }
        cuts.sort((a, b) => a - b);
        for (let i = 1; i < cuts.length; i++) {
          const lo = cuts[i - 1], hi = cuts[i];
          if (hi - lo < 1e-12) continue;
          const mid = (lo + hi) / 2;
          const active = inside(ax + dx * mid, ay + dy * mid, p.poly);
          transition(index, active, ax + dx * lo, ay + dy * lo);
          if (active) intervals.push([lo, hi]);
        }
        transition(index, inside(bx, by, p.poly), bx, by);
      });
      intervals.sort((a, b) => a[0] - b[0]);
      let fraction = 0, end = 0;
      for (const [lo, hi] of intervals) {
        fraction += Math.max(0, hi - Math.max(lo, end));
        end = Math.max(end, hi);
      }
      return fraction;
    },
  };
}
