import { BALL_R, DT, MAX_SHOT_SPEED, createSim, moverCenter, moverPhaseBucket } from "./physics.js";
import type { BallState, Level, Shot } from "./types.js";

const ANGLE_STEPS = 96;
const POWER_LEVELS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
const GRID = 8;
const DEG = Math.PI / 180;
const FRONTIER_PER_COST = 16;
const CACHE_STATES = 128;

export interface SolveOptions {
  maxStrokes?: number;
  /** Restrict every searched stroke, including feasibility continuations. */
  maxCushions?: number;
  /** Authoring previews can omit the expensive perturbation check. */
  checkFeasibility?: boolean;
}

export interface SolveResult {
  solvable: boolean;
  strokes: number;
  /** Maximum wall + mover contacts in any one stroke. Bumpers are excluded. */
  cushions: number;
  shots: Shot[];
  explored: number;
  /** Backward-compatible alias for feasible. */
  robust: boolean;
  feasible: boolean;
  /** Fraction in [0, 1], over all nine variants of the worst shot. */
  worstPassRate: number;
}

interface SearchNode extends BallState {
  strokes: number;
  penalties: number;
  totalCushions: number;
  cushions: number;
  length: number;
  shots: Shot[];
}

function stateKey(state: BallState, level: Level): string {
  return `${Math.floor(state.x / GRID)},${Math.floor(state.y / GRID)},${moverPhaseBucket(level.movers, state.t)}`;
}

const CANDIDATE_SHOTS: Shot[] = [];
for (let a = 0; a < ANGLE_STEPS; a++) {
  for (const power of POWER_LEVELS) {
    CANDIDATE_SHOTS.push({ angle: (a / ANGLE_STEPS) * 2 * Math.PI, power });
  }
}

/** Authoring-only metadata; the runtime Level API remains unchanged. */
export interface IntendedRoute { strokes: number; maxCushions: number }

export function parseIntended(json: { intended?: unknown }, file = "level"): IntendedRoute | undefined {
  if (json.intended === undefined) return undefined;
  const value = json.intended as IntendedRoute | null;
  if (!value || !Number.isInteger(value.strokes) || value.strokes < 1 || value.strokes > 7
    || !Number.isInteger(value.maxCushions) || value.maxCushions < 0) {
    throw new Error(`${file}.intended: expected strokes (1..7) and maxCushions (integer >= 0)`);
  }
  return { strokes: value.strokes, maxCushions: value.maxCushions };
}

/** Measure public physics ticks without changing the runtime physics API.
 * Walls expose events. Movers do not, so near a bar we compare the tick with
 * a collision-disabled shadow. Negative thickness disables contact but keeps
 * mover speed/substep bounds identical. Count each contact tick conservatively:
 * a sustained bar contact may count more than once, never as a free bank.
 */
export function measureStroke(level: Level, state: BallState, shot: Shot) {
  const sim = createSim(level, state);
  const ghostLevel = level.movers.length ? {
    ...level, movers: level.movers.map(m => ({ ...m, thickness: -1e9 })),
  } : level;
  let cushions = 0;
  let length = 0;
  let events = 0;
  sim.shoot(shot);
  while (!sim.atRest && !sim.holed) {
    const before = sim.ball;
    const vx = sim.vx, vy = sim.vy;
    const nearMover = level.movers.some(m => {
      const c = moverCenter(m, before.t);
      const reach = BALL_R + Math.hypot(m.width, m.thickness) / 2
        + (Math.hypot(vx, vy) + Math.hypot(m.to[0] - m.from[0], m.to[1] - m.from[1]) * Math.PI / m.period) * DT;
      return Math.hypot(before.x - c[0], before.y - c[1]) <= reach;
    });
    sim.step();
    for (; events < sim.events.length; events++) {
      if (sim.events[events].type === "wall-hit" || sim.events[events].type === "one-way-hit") cushions++;
    }
    if (nearMover && !sim.inWater) {
      const ghost = createSim(ghostLevel, before);
      ghost.shoot({ angle: Math.atan2(vy, vx), power: Math.hypot(vx, vy) / MAX_SHOT_SPEED });
      ghost.step();
      if (Math.hypot(ghost.ball.x - sim.ball.x, ghost.ball.y - sim.ball.y) > 1e-6
        || Math.hypot(ghost.vx - sim.vx, ghost.vy - sim.vy) > 1e-6) cushions++;
    }
    // Water teleports to the tee; that reset is not travelled distance.
    if (!sim.inWater) length += Math.hypot(sim.ball.x - before.x, sim.ball.y - before.y);
  }
  return {
    end: sim.inWater ? { x: state.x, y: state.y, t: sim.ball.t } : sim.ball,
    holed: sim.holed,
    penalty: sim.inWater ? 1 : 0,
    cushions,
    length,
  };
}

const simulateStroke = measureStroke;

type StrokeResult = ReturnType<typeof simulateStroke>;

/** Coarse walking distance follows doglegs instead of favouring a nearby cup
 * on the other side of a wall. It only orders the beam; physics proves shots. */
function courseDistance(level: Level) {
  const step = 20, cols = 18, rows = 32;
  const inside = (x: number, y: number, poly: [number, number][]) => {
    let yes = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) yes = !yes;
    }
    return yes;
  };
  const segments = level.walls.flatMap(w => w.points.slice(0, w.closed ? undefined : -1).map((a, i) => [a, w.points[(i + 1) % w.points.length]]));
  const outer = level.walls.find(w => w.closed)!.points;
  const clear = (x: number, y: number) => {
    if (!inside(x, y, outer) || level.water.some(z => inside(x, y, z.poly))
      || level.bumpers.some(b => Math.hypot(x - b.x, y - b.y) < b.r + BALL_R + 1)) return false;
    return segments.every(([a, b]) => {
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
      return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy) >= BALL_R + 1;
    });
  };
  const points = Array.from({ length: cols * rows }, (_, i) => [10 + i % cols * step, 10 + Math.floor(i / cols) * step]);
  const valid = points.map(([x, y]) => clear(x, y));
  const distances = points.map(([x, y], i) => valid[i] && Math.hypot(x - level.cup[0], y - level.cup[1]) < 30
    && clear((x + level.cup[0]) / 2, (y + level.cup[1]) / 2) ? Math.hypot(x - level.cup[0], y - level.cup[1]) : Infinity);
  const visited = new Set<number>();
  const edges = new Map<string, boolean>();
  for (;;) {
    let next = -1, best = Infinity;
    for (let i = 0; i < points.length; i++) if (!visited.has(i) && distances[i] < best) { next = i; best = distances[i]; }
    if (next < 0) break;
    visited.add(next);
    const [x, y] = points[next];
    for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) {
      const col = next % cols + dx, row = Math.floor(next / cols) + dy;
      if ((!dx && !dy) || col < 0 || col >= cols || row < 0 || row >= rows) continue;
      const to = row * cols + col;
      if (!valid[to] || visited.has(to)) continue;
      const edge = `${Math.min(next, to)},${Math.max(next, to)}`;
      let pass = edges.get(edge);
      if (pass === undefined) {
        pass = [0.25, 0.5, 0.75].every(t => clear(x + dx * step * t, y + dy * step * t));
        edges.set(edge, pass);
      }
      if (pass) distances[to] = Math.min(distances[to], best + Math.hypot(dx, dy) * step);
    }
  }
  const distance = (state: BallState) => {
    let best = Infinity;
    const col = Math.round((state.x - 10) / step), row = Math.round((state.y - 10) / step);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const c = col + dx, r = row + dy;
      if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
      const i = r * cols + c;
      best = Math.min(best, distances[i] + Math.hypot(state.x - points[i][0], state.y - points[i][1]));
    }
    return Number.isFinite(best) ? best : 10_000 + Math.hypot(state.x - level.cup[0], state.y - level.cup[1]);
  };
  const visible = (a: number[], b: number[]) => {
    const count = Math.max(1, Math.ceil(Math.hypot(a[0] - b[0], a[1] - b[1]) / 5));
    return Array.from({ length: count }, (_, i) => (i + 1) / count)
      .every(t => clear(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t));
  };
  const target = (state: BallState): number[] | undefined => {
    const start = [state.x, state.y];
    let index = -1, best = Infinity;
    // Join the route at a nearby visible grid point, never across a wall.
    for (let i = 0; i < points.length; i++) {
      const gap = Math.hypot(state.x - points[i][0], state.y - points[i][1]);
      if (gap > 45 || gap + distances[i] >= best || !visible(start, points[i])) continue;
      index = i; best = gap + distances[i];
    }
    if (index < 0) return undefined;
    let aim = points[index];
    for (let hops = 0; hops < points.length; hops++) {
      if (visible(start, points[index])) aim = points[index];
      else break;
      let next = -1, remaining = distances[index];
      for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) {
        const col = index % cols + dx, row = Math.floor(index / cols) + dy;
        if (col < 0 || col >= cols || row < 0 || row >= rows) continue;
        const to = row * cols + col;
        if (distances[to] >= remaining || !edges.get(`${Math.min(index, to)},${Math.max(index, to)}`)) continue;
        next = to; remaining = distances[to];
      }
      if (next < 0) return visible(start, level.cup) ? level.cup : aim;
      index = next;
    }
    return aim;
  };
  return { distance, target };
}

const levelSignatures = new WeakMap<Level, string>();
const bestSolutions = new WeakMap<Level, SearchNode>();
const levelCaches = new WeakMap<Level, Map<string, StrokeResult[]>>();

/** One context shares exact simulations across searches, never rounded states. */
function searchContext(level: Level, maxCushions: number) {
  let explored = 0;
  const navigation = courseDistance(level);
  const distances = new WeakMap<BallState, number>();
  const distance = (state: BallState) => {
    let value = distances.get(state);
    if (value === undefined) { value = navigation.distance(state); distances.set(state, value); }
    return value;
  };
  const cache = levelCaches.get(level) ?? new Map<string, StrokeResult[]>();
  levelCaches.set(level, cache);

  function outcomes(state: BallState): StrokeResult[] {
    const key = `${state.x},${state.y},${state.t}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const results: StrokeResult[] = [];
    if (cache.size >= CACHE_STATES) cache.delete(cache.keys().next().value!);
    cache.set(key, results);
    return results;
  }

  // Feasibility needs a legal continuation, not an optimal score. Re-aim at
  // visible navigation corners from the ACTUAL displaced state, then fall back
  // to the complete sampled search. Never replay the original route's suffix.
  function quickContinuation(start: BallState, budget: number): SearchNode | undefined {
    let frontier: SearchNode[] = [{ ...start, strokes: 0, penalties: 0,
      totalCushions: 0, cushions: 0, length: 0, shots: [] }];
    const reached = new Set<string>();
    for (let cost = 0; cost < budget; cost++) {
      const next = new Map<string, SearchNode>();
      for (const node of frontier) {
        const target = navigation.target(node);
        for (const aim of [level.cup, ...(target ? [target] : [])]) {
          const angle = Math.atan2(aim[1] - node.y, aim[0] - node.x);
          const estimated = Math.min(1, Math.sqrt(800 * Math.hypot(aim[0] - node.x, aim[1] - node.y)) / MAX_SHOT_SPEED);
          for (const power of [estimated, ...POWER_LEVELS]) {
            const shot = { angle, power };
            const result = simulateStroke(level, node, shot);
            explored++;
            if (result.cushions > maxCushions || result.penalty) continue;
            const candidate: SearchNode = { ...result.end, strokes: cost + 1, penalties: 0,
              totalCushions: node.totalCushions + result.cushions,
              cushions: Math.max(node.cushions, result.cushions), length: node.length + result.length,
              shots: [...node.shots, shot] };
            if (result.holed) return candidate;
            const key = stateKey(candidate, level);
            if (!reached.has(key)) next.set(key, candidate);
          }
        }
      }
      frontier = [...next.values()].sort((a, b) => distance(a) + 80 * a.totalCushions - distance(b) - 80 * b.totalCushions).slice(0, 4);
      for (const node of frontier) reached.add(stateKey(node, level));
      if (!frontier.length) break;
    }
    return undefined;
  }

  function search(start: BallState, maxStrokes: number, firstFinish = false): SearchNode | undefined {
    if (maxStrokes < 1) return undefined;
    if (firstFinish) {
      const quick = quickContinuation(start, maxStrokes);
      if (quick) return quick;
    }
    // Integer stroke-cost buckets are a priority queue for edges of cost 1/2.
    // Compare complete routes by contacts, length, then penalties.
    const buckets: SearchNode[][] = Array.from({ length: maxStrokes + 1 }, () => []);
    const root: SearchNode = { ...start, strokes: 0, penalties: 0, totalCushions: 0, cushions: 0, length: 0, shots: [] };
    buckets[0].push(root);
    const reached = new Map<string, SearchNode>();
    reached.set(stateKey(start, level), root);
    let best: SearchNode | undefined;

    const quality = (a: SearchNode, b: SearchNode) => a.totalCushions - b.totalCushions || a.length - b.length || a.penalties - b.penalties;
    // Balance progress around doglegs with an 80-unit cost per cushion.
    // Complete solutions still compare strokes, contacts, then actual length.
    const order = (a: SearchNode, b: SearchNode) => a.penalties - b.penalties || (distance(a) + 80 * a.totalCushions) - (distance(b) + 80 * b.totalCushions) || quality(a, b);

    for (let cost = 0; cost < maxStrokes; cost++) {
      if (best && cost + 1 > best.strokes) break;
      const frontier = buckets[cost].sort(order);
      for (const node of frontier) {
        if (best && cost + 1 === best.strokes && node.totalCushions > best.totalCushions) continue;
        if (reached.get(stateKey(node, level)) !== node) continue;
        const results = outcomes(node);
        // Examine every candidate, including later clean shots, before deciding.
        for (let i = 0; i < CANDIDATE_SHOTS.length; i++) {
          if (!results[i]) {
            results[i] = simulateStroke(level, node, CANDIDATE_SHOTS[i]);
            explored++;
          }
          const { end, holed, penalty, cushions, length } = results[i];
          if (cushions > maxCushions) continue;
          const strokes = cost + 1 + penalty;
          const penalties = node.penalties + penalty;
          if (strokes > maxStrokes || (best && strokes > best.strokes)) continue;
          const next: SearchNode = { ...end, strokes, penalties,
            totalCushions: node.totalCushions + cushions,
            cushions: Math.max(node.cushions, cushions), length: node.length + length,
            shots: [...node.shots, CANDIDATE_SHOTS[i]] };
          if (holed) {
            if (!best || strokes < best.strokes || (strokes === best.strokes && quality(next, best) < 0)) {
              best = next;
              if (firstFinish) return best;
            }
            continue;
          }
          if (strokes >= maxStrokes || (best && strokes >= best.strokes)) continue;
          const key = stateKey(end, level);
          const previous = reached.get(key);
          if (previous && (previous.strokes < strokes || (previous.strokes === strokes && quality(previous, next) <= 0))) continue;
          if (previous) {
            const oldBucket = buckets[previous.strokes];
            const oldIndex = oldBucket.indexOf(previous);
            if (oldIndex !== -1) oldBucket.splice(oldIndex, 1);
          }
          const bucket = buckets[strokes];
          bucket.push(next);
          reached.set(key, next);
          if (bucket.length > FRONTIER_PER_COST) {
            bucket.sort(order);
            const dropped = bucket.pop()!;
            // A pruned representative must not prevent a later candidate in
            // its cell from entering the bounded frontier.
            const droppedKey = stateKey(dropped, level);
            if (reached.get(droppedKey) === dropped) reached.delete(droppedKey);
          }
        }
      }
    }
    return best;
  }

  return { search, get explored() { return explored; } };
}

export function solveLevel(level: Level, options?: SolveOptions): SolveResult {
  // Level is a mutable public API: invalidate caches if an editor changes it.
  const signature = JSON.stringify(level);
  if (levelSignatures.get(level) !== signature) {
    levelCaches.delete(level);
    bestSolutions.delete(level);
    levelSignatures.set(level, signature);
  }
  const maxStrokes = options?.maxStrokes ?? level.par + 2;
  const maxCushions = options?.maxCushions ?? Infinity;
  const context = searchContext(level, maxCushions);
  const start: BallState = { x: level.tee[0], y: level.tee[1], t: 0 };
  const cachedBest = bestSolutions.get(level);
  // An unrestricted winner that obeys the cap is also a restricted winner.
  // This reuses a fully simulated legal route, not an unfiltered frontier.
  const solution = cachedBest && cachedBest.strokes <= maxStrokes && cachedBest.cushions <= maxCushions
    ? cachedBest : context.search(start, maxStrokes);
  if (solution && maxCushions === Infinity) bestSolutions.set(level, solution);
  if (!solution) {
    return { solvable: false, strokes: 0, cushions: 0, shots: [], explored: context.explored, robust: false, feasible: false, worstPassRate: 0 };
  }

  // Perturb each shot at its ORIGINAL start, then plan a new continuation
  // from the actual end. Never replay a suffix aimed from another position.
  let state = start;
  let spent = 0;
  let worstPassRate = options?.checkFeasibility === false ? 0 : 1;
  for (const shot of options?.checkFeasibility === false ? [] : solution.shots) {
    let passed = 0;
    for (const angleDelta of [-1, 0, 1]) {
      for (const powerDelta of [-0.03, 0, 0.03]) {
        const variant = {
          angle: shot.angle + angleDelta * DEG,
          power: Math.max(0, Math.min(1, shot.power + powerDelta)),
        };
        const result = simulateStroke(level, state, variant);
        const remaining = level.par + 2 - spent - 1 - result.penalty;
        if (result.cushions <= maxCushions && remaining >= 0 && (result.holed || context.search(result.end, remaining, true))) passed++;
      }
    }
    worstPassRate = Math.min(worstPassRate, passed / 9);
    const original = simulateStroke(level, state, shot);
    state = original.end;
    spent += 1 + original.penalty;
  }
  const feasible = worstPassRate >= 0.6;
  return {
    solvable: true,
    strokes: solution.strokes,
    cushions: solution.cushions,
    shots: solution.shots,
    explored: context.explored,
    robust: feasible,
    feasible,
    worstPassRate,
  };
}
