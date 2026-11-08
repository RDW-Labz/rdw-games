import type {
  Bumper,
  Level,
  Mover,
  OneWayGate,
  PolyZone,
  Slope,
  Vec2,
  Wall,
} from "./types.js";

const FIELD_W = 360;
const FIELD_H = 640;
const MIN_PAR = 2;
const MAX_PAR = 5;

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isVec2(v: unknown): v is Vec2 {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    isNum(v[0]) &&
    isNum(v[1])
  );
}

function parseVec2(v: unknown, field: string): Vec2 {
  if (isVec2(v)) {
    return [v[0], v[1]];
  }
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    if (isNum(o.x) && isNum(o.y)) {
      return [o.x, o.y];
    }
  }
  throw new Error(`${field}: expected [x, y] or {x, y} with finite numbers`);
}

function parsePoly(v: unknown, field: string): Vec2[] {
  if (!Array.isArray(v)) {
    throw new Error(`${field}: expected polygon array`);
  }
  if (v.length < 3) {
    throw new Error(`${field}: polygon must have at least 3 points`);
  }
  return v.map((p, i) => parseVec2(p, `${field}[${i}]`));
}

function parseWall(v: unknown, field: string): Wall {
  if (typeof v !== "object" || v === null) {
    throw new Error(`${field}: expected wall object`);
  }
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.points)) {
    throw new Error(`${field}.points: expected array`);
  }
  if (o.points.length < 2) {
    throw new Error(`${field}.points: need at least 2 points`);
  }
  const points = o.points.map((p, i) => parseVec2(p, `${field}.points[${i}]`));
  if (typeof o.closed !== "boolean") {
    throw new Error(`${field}.closed: expected boolean`);
  }
  return { points, closed: o.closed };
}

function parseBumper(v: unknown, field: string): Bumper {
  if (typeof v !== "object" || v === null) {
    throw new Error(`${field}: expected bumper object`);
  }
  const o = v as Record<string, unknown>;
  if (!isNum(o.x) || !isNum(o.y) || !isNum(o.r)) {
    throw new Error(`${field}: x, y, r must be finite numbers`);
  }
  if (o.r <= 0) {
    throw new Error(`${field}.r: must be positive`);
  }
  return { x: o.x, y: o.y, r: o.r };
}

function parsePolyZone(v: unknown, field: string): PolyZone {
  if (typeof v !== "object" || v === null) {
    throw new Error(`${field}: expected zone object`);
  }
  const o = v as Record<string, unknown>;
  const poly = parsePoly(o.poly, `${field}.poly`);
  return { poly };
}

function parseSlope(v: unknown, field: string): Slope {
  if (typeof v !== "object" || v === null) {
    throw new Error(`${field}: expected slope object`);
  }
  const o = v as Record<string, unknown>;
  const poly = parsePoly(o.poly, `${field}.poly`);
  const force = parseVec2(o.force, `${field}.force`);
  return { poly, force };
}

function parseMover(v: unknown, field: string): Mover {
  if (typeof v !== "object" || v === null) {
    throw new Error(`${field}: expected mover object`);
  }
  const o = v as Record<string, unknown>;
  const from = parseVec2(o.from, `${field}.from`);
  const to = parseVec2(o.to, `${field}.to`);
  if (!isNum(o.width) || o.width <= 0) {
    throw new Error(`${field}.width: must be a positive number`);
  }
  if (!isNum(o.thickness) || o.thickness <= 0) {
    throw new Error(`${field}.thickness: must be a positive number`);
  }
  if (!isNum(o.period) || o.period <= 0) {
    throw new Error(`${field}.period: must be a positive number`);
  }
  return {
    from,
    to,
    width: o.width,
    thickness: o.thickness,
    period: o.period,
  };
}

function parseOneWayGate(v: unknown, field: string): OneWayGate {
  if (typeof v !== "object" || v === null) throw new Error(`${field}: expected gate object`);
  const o = v as Record<string, unknown>;
  const from = parseVec2(o.from, `${field}.from`);
  const to = parseVec2(o.to, `${field}.to`);
  const normal = parseVec2(o.normal, `${field}.normal`);
  const dx = to[0] - from[0], dy = to[1] - from[1], length = Math.hypot(dx, dy);
  if (length < 1e-6) throw new Error(`${field}.to: gate must have nonzero length`);
  if (Math.abs(Math.hypot(...normal) - 1) > 1e-6
    || Math.abs((dx * normal[0] + dy * normal[1]) / length) > 1e-6) {
    throw new Error(`${field}.normal: expected perpendicular unit vector`);
  }
  return { from, to, normal };
}

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

function getOuterBoundary(level: Level): Vec2[] | null {
  for (const w of level.walls) {
    if (w.closed && w.points.length >= 3) {
      return w.points;
    }
  }
  return null;
}

function pointInsideOuterWall(x: number, y: number, boundary: Vec2[]): boolean {
  return pointInPolygon(x, y, boundary);
}

export function parseLevel(json: unknown, fileHint = "level"): Level {
  if (typeof json !== "object" || json === null) {
    throw new Error(`${fileHint}: expected object`);
  }
  const o = json as Record<string, unknown>;

  if (typeof o.id !== "string" || o.id.length === 0) {
    throw new Error(`${fileHint}.id: expected non-empty string`);
  }
  if (typeof o.name !== "string") {
    throw new Error(`${fileHint}.name: expected string`);
  }
  if (!isNum(o.par) || o.par < MIN_PAR || o.par > MAX_PAR) {
    throw new Error(`${fileHint}.par: must be between ${MIN_PAR} and ${MAX_PAR}`);
  }

  const tee = parseVec2(o.tee, `${fileHint}.tee`);
  const cup = parseVec2(o.cup, `${fileHint}.cup`);

  if (!Array.isArray(o.walls) || o.walls.length === 0) {
    throw new Error(`${fileHint}.walls: expected non-empty array`);
  }
  const walls = o.walls.map((w, i) => parseWall(w, `${fileHint}.walls[${i}]`));

  const bumpers = Array.isArray(o.bumpers)
    ? o.bumpers.map((b, i) => parseBumper(b, `${fileHint}.bumpers[${i}]`))
    : [];
  const sand = Array.isArray(o.sand)
    ? o.sand.map((z, i) => parsePolyZone(z, `${fileHint}.sand[${i}]`))
    : [];
  const water = Array.isArray(o.water)
    ? o.water.map((z, i) => parsePolyZone(z, `${fileHint}.water[${i}]`))
    : [];
  const slopes = Array.isArray(o.slopes)
    ? o.slopes.map((s, i) => parseSlope(s, `${fileHint}.slopes[${i}]`))
    : [];
  const movers = Array.isArray(o.movers)
    ? o.movers.map((m, i) => parseMover(m, `${fileHint}.movers[${i}]`))
    : [];

  const level: Level = {
    id: o.id,
    name: o.name,
    par: o.par,
    tee,
    cup,
    walls,
    bumpers,
    sand,
    water,
    slopes,
    movers,
  };
  // Keep legacy parsed objects unchanged, and reject malformed new fields.
  for (const field of ["fastTurf", "oneWayGates"] as const) {
    if (o[field] !== undefined && !Array.isArray(o[field])) {
      throw new Error(`${fileHint}.${field}: expected array`);
    }
  }
  if (Array.isArray(o.fastTurf)) level.fastTurf = o.fastTurf.map((z, i) => parsePolyZone(z, `${fileHint}.fastTurf[${i}]`));
  if (Array.isArray(o.oneWayGates)) level.oneWayGates = o.oneWayGates.map((g, i) => parseOneWayGate(g, `${fileHint}.oneWayGates[${i}]`));

  const boundary = getOuterBoundary(level);
  if (!boundary) {
    throw new Error(`${fileHint}.walls: need at least one closed wall with 3+ points`);
  }

  if (!pointInsideOuterWall(tee[0], tee[1], boundary)) {
    throw new Error(`${fileHint}.tee: must be inside the outer wall`);
  }
  if (!pointInsideOuterWall(cup[0], cup[1], boundary)) {
    throw new Error(`${fileHint}.cup: must be inside the outer wall`);
  }

  for (const wz of water) {
    if (pointInPolygon(tee[0], tee[1], wz.poly)) {
      throw new Error(`${fileHint}.tee: must not be in water`);
    }
  }

  if (tee[0] < 0 || tee[0] > FIELD_W || tee[1] < 0 || tee[1] > FIELD_H) {
    throw new Error(`${fileHint}.tee: out of playfield bounds`);
  }
  if (cup[0] < 0 || cup[0] > FIELD_W || cup[1] < 0 || cup[1] > FIELD_H) {
    throw new Error(`${fileHint}.cup: out of playfield bounds`);
  }

  return level;
}

/** Conservative authoring coverage: overlapping sand polygons count twice. */
export function sandAreaFraction(level: Level): number {
  const area = (poly: Vec2[]) => Math.abs(poly.reduce((sum, a, i) => {
    const b = poly[(i + 1) % poly.length];
    return sum + a[0] * b[1] - b[0] * a[1];
  }, 0)) / 2;
  const boundary = getOuterBoundary(level);
  const outerArea = boundary ? area(boundary) : 0;
  return outerArea > 0 ? level.sand.reduce((sum, zone) => sum + area(zone.poly), 0) / outerArea : Infinity;
}
