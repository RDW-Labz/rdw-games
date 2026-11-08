import type { Level, Vec2 } from "../../sim/types.js";
import { TOKENS } from "../../ui/tokens.js";

/** Bottom power panel height (slimmer than screens.md 64px to enlarge the course viewport). */
export const POWER_PANEL_H = 48;

/** Clearance between course viewport bottom and power panel top. */
export const POWER_PANEL_CLEARANCE = 12;

/** UI px margin around fitted hole content. */
export const COURSE_VIEW_MARGIN = 12;

/** Reserved band at the bottom for the power HUD (course-check uses bottomEdge − 64). */
export const POWER_PANEL_BAND = 64;

/**
 * Uniform, invertible world -> UI transform for the golf course (screens.md section 6).
 * World is the authored 360x640 level space (sim coordinates); UI is the 360xH logical screen.
 * The course is drawn, hit-tested and aimed through this one transform.
 */
export interface CourseFrame {
  /** Uniform world->UI scale. */
  q: number;
  /** UI position of world origin. */
  ox: number;
  oy: number;
  /** Course viewport in UI px. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Bottom content edge A = H - B - 16. */
  bottomEdge: number;
  /** Top of the power panel in UI px. */
  powerPanelTop: number;
}

function levelPlayBounds(level: Level): { minX: number; minY: number; maxX: number; maxY: number } {
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
  const pad = 18;
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 360, maxY: 640 };
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

export function courseFrame(
  safeTop: number = TOKENS.layout.safeTop,
  safeBottom: number = TOKENS.layout.safeBottom,
  screenH: number = TOKENS.layout.logicalH,
  level?: Level
): CourseFrame {
  const W = TOKENS.layout.logicalW;
  const A = screenH - safeBottom - 16;
  const top = safeTop + 72;
  const bottomReserve = POWER_PANEL_H + POWER_PANEL_CLEARANCE;
  const left = TOKENS.layout.gutter;
  const width = W - left * 2;
  const height = A - top - bottomReserve;
  const powerPanelTop = A - POWER_PANEL_H;

  let q: number;
  let ox: number;
  let oy: number;

  const qWorld = Math.min(width / 360, height / 640);
  const qBakeCap = TOKENS.budget.textureDprMax / 3;

  const hudBottom = safeTop + 64;
  /** course-check.mjs reserves 64px above the bottom edge for the power HUD band. */
  const playBottom = A - POWER_PANEL_BAND;

  if (level) {
    const b = levelPlayBounds(level);
    const bw = Math.max(1, b.maxX - b.minX);
    const bh = Math.max(1, b.maxY - b.minY);
    const margin = COURSE_VIEW_MARGIN;
    q = Math.min((width - margin * 2) / bw, (height - margin * 2) / bh, qWorld, qBakeCap);
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    const vcx = left + width / 2;
    const vcy = top + height / 2;
    ox = vcx - q * cx;
    oy = vcy - q * cy;
    const wUi = 360 * q;
    const hUi = 640 * q;
    ox = Math.max(left, Math.min(ox, left + width - wUi));
    oy = Math.max(hudBottom, Math.min(oy, playBottom - hUi));
  } else {
    q = Math.min(qWorld, qBakeCap);
    ox = W / 2 - 180 * q;
    oy = top + (height - 640 * q) / 2;
    const wUi = 360 * q;
    const hUi = 640 * q;
    ox = Math.max(left, Math.min(ox, left + width - wUi));
    oy = Math.max(hudBottom, Math.min(oy, playBottom - hUi));
  }

  return {
    q,
    ox,
    oy,
    left,
    top,
    width,
    height,
    bottomEdge: A,
    powerPanelTop,
  };
}

export function powerPanelTop(f: CourseFrame): number {
  return f.powerPanelTop;
}

export function worldToUi(f: CourseFrame, wx: number, wy: number): Vec2 {
  return [f.ox + f.q * wx, f.oy + f.q * wy];
}

export function uiToWorld(f: CourseFrame, ux: number, uy: number): Vec2 {
  return [(ux - f.ox) / f.q, (uy - f.oy) / f.q];
}

/** Device-pixel rectangle that holds the whole 360x640 world at render scale r, snapped to whole pixels. */
export function bakeRect(f: CourseFrame, r: number): { x: number; y: number; w: number; h: number; s: number } {
  const s = f.q * r;
  const x = Math.floor(f.ox * r);
  const y = Math.floor(f.oy * r);
  const w = Math.ceil((f.ox + 360 * f.q) * r) - x;
  const h = Math.ceil((f.oy + 640 * f.q) * r) - y;
  return { x, y, w, h, s };
}
