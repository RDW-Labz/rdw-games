import type {
  BallState,
  Level,
  Mover,
  Shot,
  SimEvent,
  SimulateShotOptions,
  SimulateShotResult,
  Vec2,
} from "./types.js";
import { fastTurfTracker } from "./fastTurf.js";

export const DT = 1 / 120;
export const BALL_R = 7;
export const CUP_R = 11;
export const MAX_SHOT_SPEED = 900;
export const STOP_SPEED = 4;
export const WALL_RESTITUTION = 0.8;
export const BUMPER_RESTITUTION = 1.15;
export const SAND_FRICTION_MULT = 4;
export const ROLLING_DECEL = 400;
export const FAST_TURF_FRICTION_MULT = 0.35;
export const MAX_SHOT_TIME = 12;
export const CUP_CAPTURE_SPEED = 230;
export const CUP_PULL_RADIUS = 1.6 * CUP_R;
export const CUP_PULL_ACCEL = 650;
// Retain 65% of speed on a rim catch (lose 35%).
export const LIP_OUT_RESTITUTION = 0.65;

function pointInPolygon(x: number, y: number, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0];
    const yi = poly[i][1];
    const xj = poly[j][0];
    const yj = poly[j][1];
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function moverCenter(m: Mover, t: number): Vec2 {
  const phase = (t % m.period) / m.period;
  const eased = 0.5 - 0.5 * Math.cos(2 * Math.PI * phase);
  return [
    m.from[0] + (m.to[0] - m.from[0]) * eased,
    m.from[1] + (m.to[1] - m.from[1]) * eased,
  ];
}

export function moverPhaseBucket(movers: Mover[], t: number): number {
  if (movers.length === 0) return 0;
  let h = 0;
  for (let i = 0; i < movers.length; i++) {
    const phase = (t % movers[i].period) / movers[i].period;
    h = (h * 31 + Math.floor(phase * 8)) | 0;
  }
  return h;
}

function distSq(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

function normalize(x: number, y: number): [number, number, number] {
  const len = Math.hypot(x, y);
  if (len < 1e-9) return [0, 0, 0];
  return [x / len, y / len, len];
}

function reflect(
  vx: number,
  vy: number,
  nx: number,
  ny: number,
  restitution: number
): [number, number] {
  const dot = vx * nx + vy * ny;
  return [vx - (1 + restitution) * dot * nx, vy - (1 + restitution) * dot * ny];
}

function circleSegmentCollision(
  cx: number,
  cy: number,
  r: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  startX: number,
  startY: number
): { hit: boolean; nx: number; ny: number; depth: number } {
  // Most short boundary segments are far away. Reject by their expanded
  // bounds before projection/hypot; this cannot discard a circle contact.
  if ((cx + r < x1 && cx + r < x2) || (cx - r > x1 && cx - r > x2)
    || (cy + r < y1 && cy + r < y2) || (cy - r > y1 && cy - r > y2)) {
    return { hit: false, nx: 0, ny: 0, depth: 0 };
  }
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  const projection = lenSq > 1e-12
    ? ((cx - x1) * dx + (cy - y1) * dy) / lenSq : 0;
  const along = Math.max(0, Math.min(1, projection));
  const px = x1 + along * dx;
  const py = y1 + along * dy;
  const dist = Math.hypot(cx - px, cy - py);
  if (dist >= r) return { hit: false, nx: 0, ny: 0, depth: 0 };

  let nx: number;
  let ny: number;
  if (lenSq > 1e-12 && projection > 0 && projection < 1) {
    const len = Math.sqrt(lenSq);
    nx = -dy / len;
    ny = dx / len;
    // Choose the original side, even if integration put the center across it.
    const side = (startX - x1) * nx + (startY - y1) * ny;
    const motion = (cx - startX) * nx + (cy - startY) * ny;
    if (side < 0 || (side === 0 && motion > 0)) {
      nx = -nx;
      ny = -ny;
    }
  } else {
    // Rounded endpoints allow going around the tip, but never through it.
    [nx, ny] = normalize(cx - px, cy - py);
    if (dist < 1e-9) [nx, ny] = normalize(startX - px, startY - py);
    if (nx === 0 && ny === 0) nx = 1;
    if ((startX - px) * nx + (startY - py) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
  }
  return { hit: true, nx, ny, depth: r - ((cx - px) * nx + (cy - py) * ny) };
}

type WallSegment = { a: Vec2; b: Vec2; left: number; right: number; top: number; bottom: number };
type WallIndex = { segments: WallSegment[]; cells: number[][]; all: number[] };
const wallIndexes = new WeakMap<Level["walls"], { signature: string; index: WallIndex }>();
function wallCell(x: number, y: number): number {
  return x >= 0 && x < 384 && y >= 0 && y < 640 ? Math.floor(y / 32) * 12 + Math.floor(x / 32) : -1;
}
function indexWalls(walls: Level["walls"]): WallIndex {
  // Authoring callers can mutate vertices in place between shots.
  const signature = JSON.stringify(walls);
  const cached = wallIndexes.get(walls);
  if (cached?.signature === signature) return cached.index;
  const segments = walls.flatMap(wall => wall.points.slice(0, wall.closed ? undefined : -1).map((a, i) => {
    const b = wall.points[(i + 1) % wall.points.length];
    return { a, b, left: Math.min(a[0], b[0]), right: Math.max(a[0], b[0]), top: Math.min(a[1], b[1]), bottom: Math.max(a[1], b[1]) };
  }));
  const cells: number[][] = Array.from({ length: 240 }, () => []);
  segments.forEach((s, i) => {
    for (let row = Math.max(0, Math.floor((s.top - BALL_R) / 32)); row <= Math.min(19, Math.floor((s.bottom + BALL_R) / 32)); row++) {
      for (let col = Math.max(0, Math.floor((s.left - BALL_R) / 32)); col <= Math.min(11, Math.floor((s.right + BALL_R) / 32)); col++) cells[row * 12 + col].push(i);
    }
  });
  const index = { segments, cells, all: segments.map((_, i) => i) };
  wallIndexes.set(walls, { signature, index });
  return index;
}

function resolveWallCollisions(
  walls: WallIndex,
  x: number,
  y: number,
  vx: number,
  vy: number,
  events: SimEvent[],
  startX: number,
  startY: number
): [number, number, number, number] {
  let cx = x;
  let cy = y;
  let cvx = vx;
  let cvy = vy;
  const cell = wallCell(cx, cy);
  let candidates = cell < 0 ? walls.all : walls.cells[cell];
  let last = -1;
  for (let cursor = 0; cursor < candidates.length; cursor++) {
      const index = candidates[cursor];
      if (index <= last) continue;
      last = index;
      const { a: p1, b: p2, left, right, top, bottom } = walls.segments[index];
      // Same rejection as circleSegmentCollision, with bounds prepared once.
      if (cx + BALL_R < left || cx - BALL_R > right || cy + BALL_R < top || cy - BALL_R > bottom) continue;
      const col = circleSegmentCollision(cx, cy, BALL_R, p1[0], p1[1], p2[0], p2[1], startX, startY);
      if (col.hit) {
        cx += col.nx * col.depth;
        cy += col.ny * col.depth;
        // Separation may enter another cell. Fall back in original segment
        // order so the broad phase cannot change multi-contact resolution.
        if (wallCell(cx, cy) !== cell && candidates !== walls.all) {
          candidates = walls.all;
          cursor = index;
        }
        if (cvx * col.nx + cvy * col.ny < 0) {
          const speed = Math.hypot(cvx, cvy);
          [cvx, cvy] = reflect(cvx, cvy, col.nx, col.ny, WALL_RESTITUTION);
          events.push({ type: "wall-hit", speed });
        }
      }
  }
  return [cx, cy, cvx, cvy];
}

function resolveOneWayCollisions(
  level: Level, x: number, y: number, vx: number, vy: number,
  events: SimEvent[], startX: number, startY: number
): [number, number, number, number] {
  for (const [index, gate] of (level.oneWayGates ?? []).entries()) {
    const [nx, ny] = gate.normal;
    if (vx * nx + vy * ny >= 0
      || (startX - gate.from[0]) * nx + (startY - gate.from[1]) * ny < -1e-9) continue;
    const col = circleSegmentCollision(x, y, BALL_R, ...gate.from, ...gate.to, startX, startY);
    if (!col.hit) continue;
    x += col.nx * col.depth;
    y += col.ny * col.depth;
    if (vx * col.nx + vy * col.ny < 0) {
      const speed = Math.hypot(vx, vy);
      [vx, vy] = reflect(vx, vy, col.nx, col.ny, WALL_RESTITUTION);
      events.push({ type: "one-way-hit", index, x: x - col.nx * BALL_R,
        y: y - col.ny * BALL_R, nx: col.nx, ny: col.ny, speed });
    }
  }
  return [x, y, vx, vy];
}

function resolveBumperCollisions(
  level: Level,
  x: number,
  y: number,
  vx: number,
  vy: number,
  events: SimEvent[]
): [number, number, number, number] {
  let cx = x;
  let cy = y;
  let cvx = vx;
  let cvy = vy;
  for (const b of level.bumpers) {
    const d = Math.hypot(cx - b.x, cy - b.y);
    const minD = BALL_R + b.r;
    if (d < minD && d > 1e-9) {
      const nx = (cx - b.x) / d;
      const ny = (cy - b.y) / d;
      cx = b.x + nx * minD;
      cy = b.y + ny * minD;
      if (cvx * nx + cvy * ny < 0) {
        const speed = Math.hypot(cvx, cvy);
        [cvx, cvy] = reflect(cvx, cvy, nx, ny, BUMPER_RESTITUTION);
        events.push({ type: "bumper-hit", speed });
      }
    }
  }
  return [cx, cy, cvx, cvy];
}

function resolveMoverCollisions(
  level: Level,
  t: number,
  x: number,
  y: number,
  vx: number,
  vy: number,
  startX: number,
  startY: number,
  startT: number,
  dt: number
): [number, number, number, number] {
  let cx = x;
  let cy = y;
  let cvx = vx;
  let cvy = vy;
  for (const m of level.movers) {
    const center = moverCenter(m, t);
    const previous = moverCenter(m, startT);
    const mvx = (center[0] - previous[0]) / dt;
    const mvy = (center[1] - previous[1]) / dt;
    const dx = m.to[0] - m.from[0];
    const dy = m.to[1] - m.from[1];
    const [ux, uy, len] = normalize(dx, dy);
    if (len < 1e-9) continue;
    const px = -uy;
    const py = ux;
    const halfW = m.width / 2;
    const halfT = m.thickness / 2;
    const lx = cx - center[0];
    const ly = cy - center[1];
    const along = lx * ux + ly * uy;
    const perp = lx * px + ly * py;
    const clampedAlong = Math.max(-halfW, Math.min(halfW, along));
    const closestX = center[0] + ux * clampedAlong + px * Math.max(-halfT, Math.min(halfT, perp));
    const closestY = center[1] + uy * clampedAlong + py * Math.max(-halfT, Math.min(halfT, perp));
    const dist = Math.hypot(cx - closestX, cy - closestY);
    if (dist < BALL_R) {
      // Work in the bar's translating frame. Its old position determines
      // the contact side; reflection uses velocity relative to the bar.
      const oldX = startX - previous[0];
      const oldY = startY - previous[1];
      const oldAlong = oldX * ux + oldY * uy;
      const oldPerp = oldX * px + oldY * py;
      let nx: number;
      let ny: number;
      let depth: number;
      if (dist > 1e-9) {
        nx = (cx - closestX) / dist;
        ny = (cy - closestY) / dist;
        const relativeStartX = startX + center[0] - previous[0];
        const relativeStartY = startY + center[1] - previous[1];
        if ((relativeStartX - closestX) * nx + (relativeStartY - closestY) * ny < 0) {
          nx = -nx;
          ny = -ny;
        }
        depth = BALL_R - ((cx - closestX) * nx + (cy - closestY) * ny);
      } else {
        // A center inside the rectangle still has a well-defined entry face.
        if (Math.abs(oldAlong) - halfW > Math.abs(oldPerp) - halfT) {
          const side = oldAlong < 0 ? -1 : 1;
          nx = ux * side;
          ny = uy * side;
          depth = BALL_R + halfW - along * side;
        } else {
          const side = oldPerp < 0 ? -1 : 1;
          nx = px * side;
          ny = py * side;
          depth = BALL_R + halfT - perp * side;
        }
      }
      cx += nx * depth;
      cy += ny * depth;
      if ((cvx - mvx) * nx + (cvy - mvy) * ny < 0) {
        const [rvx, rvy] = reflect(cvx - mvx, cvy - mvy, nx, ny, WALL_RESTITUTION);
        cvx = rvx + mvx;
        cvy = rvy + mvy;
      }
    }
  }
  return [cx, cy, cvx, cvy];
}

/** One response per passage: a lip-out must not become a slow capture on
 * the next substep. Re-arm only after leaving the cup's pull region. */
function tryCup(
  level: Level,
  x: number,
  y: number,
  vx: number,
  vy: number,
  events: SimEvent[],
  passed: boolean
): { holed: boolean; x: number; y: number; vx: number; vy: number; passed: boolean } {
  const dx = x - level.cup[0], dy = y - level.cup[1];
  const distanceSq = dx * dx + dy * dy;
  const result = { holed: false, x, y, vx, vy,
    passed: passed && distanceSq <= CUP_PULL_RADIUS * CUP_PULL_RADIUS };
  if (passed || distanceSq > CUP_R * CUP_R) return result;
  const d = Math.hypot(dx, dy);

  const speed = Math.hypot(vx, vy);
  // Perpendicular distance from the incoming path to the center, rather than
  // distance at the arbitrary substep that first enters the cup.
  const offset = speed > 0 ? Math.abs(dx * vy - dy * vx) / speed : d;
  const firm = speed >= CUP_CAPTURE_SPEED && speed <= 330 && offset < 0.45 * CUP_R;
  if ((d <= CUP_R - 2 && speed < CUP_CAPTURE_SPEED) || firm) {
    events.push(firm ? { type: "holed", firm: true } : { type: "holed" });
    return { holed: true, x: level.cup[0], y: level.cup[1], vx: 0, vy: 0, passed: true };
  }
  if (speed < CUP_CAPTURE_SPEED) return result;

  const rim = speed <= 420 && offset >= 0.45 * CUP_R;
  // Bend toward the outside of the incoming line. Slow, glancing contacts
  // wrap further around the rim; fast skims turn at most two degrees.
  const side = Math.sign(vx * dy - vy * dx);
  const angle = side * (rim
    ? Math.PI / 3 * ((420 - speed) / (420 - CUP_CAPTURE_SPEED)) * (offset / CUP_R)
    : Math.PI / 90 * (offset / CUP_R));
  const retain = rim ? LIP_OUT_RESTITUTION : 1;
  events.push({ type: rim ? "lip-out" : "rim" });
  return { ...result, passed: true,
    vx: (vx * Math.cos(angle) - vy * Math.sin(angle)) * retain,
    vy: (vx * Math.sin(angle) + vy * Math.cos(angle)) * retain };
}

function applyFriction(speed: number, inSand: boolean, dt: number, fastFraction = 0): number {
  const decel = inSand ? ROLLING_DECEL * SAND_FRICTION_MULT : ROLLING_DECEL * (1 - fastFraction * (1 - FAST_TURF_FRICTION_MULT));
  return Math.max(0, speed - decel * dt);
}

export interface SimInstance {
  shoot(shot: Shot): void;
  step(): void;
  ball: BallState;
  vx: number;
  vy: number;
  atRest: boolean;
  holed: boolean;
  inWater: boolean;
  events: SimEvent[];
  shotStart: BallState;
  steps: number;
}

export function createSim(level: Level, initial?: BallState): SimInstance {
  const start = initial ?? { x: level.tee[0], y: level.tee[1], t: 0 };
  let x = start.x;
  let y = start.y;
  let t = start.t;
  let vx = 0;
  let vy = 0;
  let atRest = true;
  let holed = false;
  let inWater = false;
  let shotStart: BallState = { x, y, t };
  let shotElapsed = 0;
  let wasInSand = false;
  let steps = 0;
  let settledSteps = 0;
  let cupPassed = false;
  let segments: WallIndex;
  const events: SimEvent[] = [];
  const turf = level.fastTurf?.length ? fastTurfTracker(level.fastTurf, events) : undefined;
  // Bounds cover acceleration and bar travel, including a bar crossing a
  // nearly stationary ball. Recompute the ball speed after every bounce.
  const moverSpeed = Math.max(0, ...level.movers.map(m =>
    Math.hypot(m.to[0] - m.from[0], m.to[1] - m.from[1]) * Math.PI / m.period));
  const acceleration = CUP_PULL_ACCEL + level.slopes.reduce((sum, s) => sum + Math.hypot(...s.force), 0);

  const sim: SimInstance = {
    ball: { x, y, t },
    vx,
    vy,
    atRest,
    holed,
    inWater,
    events,
    shotStart,
    steps,
    shoot(shot: Shot) {
      if (!atRest || holed) return;
      segments = indexWalls(level.walls);
      events.length = 0;
      turf?.start(x, y);
      shotStart = { x, y, t };
      shotElapsed = 0;
      settledSteps = 0;
      cupPassed = false;
      const speed = shot.power * MAX_SHOT_SPEED;
      vx = Math.cos(shot.angle) * speed;
      vy = Math.sin(shot.angle) * speed;
      atRest = false;
      inWater = false;
      wasInSand = false;
      sim.atRest = false;
      sim.inWater = false;
      sim.vx = vx;
      sim.vy = vy;
    },
    step() {
      if (atRest || holed) {
        sim.ball = { x, y, t };
        return;
      }

      steps++;
      const tickEnd = t + DT;
      shotElapsed += DT;
      let remaining = DT;
      while (remaining > 1e-12 && !atRest && !holed) {
        const speedBound = Math.hypot(vx, vy) + moverSpeed + acceleration * remaining;
        const subSteps = Math.max(1, Math.ceil(speedBound * remaining / (BALL_R * 0.4)));
        const dt = remaining / subSteps;
        const startX = x;
        const startY = y;
        const startT = t;
        t += dt;
        remaining -= dt;

        let inSand = false;
        for (const z of level.sand) {
          if (pointInPolygon(x, y, z.poly)) {
            inSand = true;
            break;
          }
        }
        if (inSand && !wasInSand) {
          events.push({ type: "sand-enter" });
        }
        wasInSand = inSand;

        for (const s of level.slopes) {
          if (pointInPolygon(x, y, s.poly)) {
            vx += s.force[0] * dt;
            vy += s.force[1] * dt;
          }
        }

        const cupDx = level.cup[0] - x, cupDy = level.cup[1] - y;
        const cupDistanceSq = cupDx * cupDx + cupDy * cupDy;
        if (cupDistanceSq > CUP_PULL_RADIUS * CUP_PULL_RADIUS) cupPassed = false;
        if (cupDistanceSq > 0 && cupDistanceSq < CUP_PULL_RADIUS * CUP_PULL_RADIUS
          && Math.hypot(vx, vy) < 300) {
          const cupDistance = Math.hypot(cupDx, cupDy);
          const pull = CUP_PULL_ACCEL * (1 - cupDistance / CUP_PULL_RADIUS) * dt / cupDistance;
          vx += cupDx * pull;
          vy += cupDy * pull;
        }

        x += vx * dt;
        y += vy * dt;

        for (const wz of level.water) {
          if (pointInPolygon(x, y, wz.poly)) {
            turf?.sweep(startX, startY, x, y);
            turf?.reset(x, y);
            events.push({ type: "water" });
            x = shotStart.x;
            y = shotStart.y;
            vx = 0;
            vy = 0;
            atRest = true;
            inWater = true;
            break;
          }
        }
        if (inWater) break;

        const beforeContactsX = x, beforeContactsY = y, beforeContactsEvents = events.length;
        [x, y, vx, vy] = resolveWallCollisions(segments, x, y, vx, vy, events, startX, startY);
        if (level.oneWayGates?.length) [x, y, vx, vy] = resolveOneWayCollisions(level, x, y, vx, vy, events, startX, startY);
        [x, y, vx, vy] = resolveBumperCollisions(level, x, y, vx, vy, events);
        [x, y, vx, vy] = resolveMoverCollisions(level, t, x, y, vx, vy, startX, startY, startT, dt);
        // Object separation can overlap a nearby wall; preserve the entry side.
        if ((level.bumpers.length || level.movers.length || level.oneWayGates?.length)
          && (x !== beforeContactsX || y !== beforeContactsY || events.length !== beforeContactsEvents)) {
          [x, y, vx, vy] = resolveWallCollisions(segments, x, y, vx, vy, events, startX, startY);
        }

        const fastFraction = turf?.sweep(startX, startY, x, y) ?? 0;
        const cupResult = tryCup(level, x, y, vx, vy, events, cupPassed);
        cupPassed = cupResult.passed;
        x = cupResult.x;
        y = cupResult.y;
        vx = cupResult.vx;
        vy = cupResult.vy;
        if (cupResult.holed) {
          holed = true;
          atRest = true;
          vx = 0;
          vy = 0;
        }

        const speed = Math.hypot(vx, vy);
        if (!holed && speed > 0) {
          const newSpeed = applyFriction(speed, inSand, dt, fastFraction);
          const scale = newSpeed / speed;
          vx *= scale;
          vy *= scale;
        }
      }
      if (!holed && !inWater) {
        settledSteps = Math.hypot(vx, vy) < STOP_SPEED ? settledSteps + 1 : 0;
        if (settledSteps >= 3) {
          vx = 0;
          vy = 0;
          atRest = true;
        }
      }
      // Public time and step counts remain fixed ticks, independent of substeps.
      t = tickEnd;

      if (shotElapsed >= MAX_SHOT_TIME && !holed) {
        vx = 0;
        vy = 0;
        atRest = true;
      }

      sim.ball = { x, y, t };
      sim.vx = vx;
      sim.vy = vy;
      sim.atRest = atRest;
      sim.holed = holed;
      sim.inWater = inWater;
      sim.steps = steps;
    },
  };

  return sim;
}

export function simulateShot(
  level: Level,
  state: BallState,
  shot: Shot,
  opts?: SimulateShotOptions
): SimulateShotResult {
  const sim = createSim(level, state);
  const path: Vec2[] | undefined = opts?.recordPath ? [] : undefined;
  sim.shoot(shot);
  while (!sim.atRest && !sim.holed) {
    if (path && sim.steps % 4 === 0) {
      path.push([sim.ball.x, sim.ball.y]);
    }
    sim.step();
  }
  if (path) {
    path.push([sim.ball.x, sim.ball.y]);
  }
  return {
    end: sim.ball,
    holed: sim.holed,
    inWater: sim.inWater,
    steps: sim.steps,
    path,
  };
}

/** Trim path to roughly `duration` seconds of sim time from shot start. */
export function trimPathByTime(
  path: Vec2[],
  steps: number,
  duration: number
): Vec2[] {
  if (path.length === 0) return path;
  const maxSteps = Math.floor(duration / DT);
  const recordEvery = 4;
  const maxPoints = Math.max(2, Math.floor(maxSteps / recordEvery));
  return path.slice(0, maxPoints);
}
