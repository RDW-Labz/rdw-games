export type Vec2 = [number, number];

export interface Wall {
  points: Vec2[];
  closed: boolean;
}

export interface Bumper {
  x: number;
  y: number;
  r: number;
}

export interface PolyZone {
  poly: Vec2[];
}

export interface Slope extends PolyZone {
  force: Vec2;
}

export interface Mover {
  from: Vec2;
  to: Vec2;
  width: number;
  thickness: number;
  period: number;
}

export interface OneWayGate {
  from: Vec2;
  to: Vec2;
  /** Unit normal pointing in the permitted travel direction. */
  normal: Vec2;
}

export interface Level {
  id: string;
  name: string;
  par: number;
  tee: Vec2;
  cup: Vec2;
  walls: Wall[];
  bumpers: Bumper[];
  sand: PolyZone[];
  water: PolyZone[];
  slopes: Slope[];
  movers: Mover[];
  fastTurf?: PolyZone[];
  oneWayGates?: OneWayGate[];
}

export interface BallState {
  x: number;
  y: number;
  t: number;
}

export interface Shot {
  angle: number;
  power: number;
}

export type SimEvent =
  | { type: "fast-turf-enter" | "fast-turf-exit"; index: number; x: number; y: number }
  | { type: "one-way-hit"; index: number; x: number; y: number; nx: number; ny: number; speed: number }
  | { type: "wall-hit"; speed: number }
  | { type: "bumper-hit"; speed: number }
  | { type: "sand-enter" }
  | { type: "water" }
  | { type: "lip-out" }
  | { type: "rim" }
  | { type: "holed"; firm?: boolean };

export interface SimulateShotOptions {
  recordPath?: boolean;
}

export interface SimulateShotResult {
  end: BallState;
  holed: boolean;
  inWater: boolean;
  steps: number;
  path?: Vec2[];
}
