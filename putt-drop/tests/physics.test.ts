import { describe, expect, it } from "vitest";
import {
  createSim,
  moverCenter,
  simulateShot,
  DT,
  BALL_R,
} from "../src/sim/physics.js";
import type { Level } from "../src/sim/types.js";

function flatLevel(overrides: Partial<Level> = {}): Level {
  return {
    id: "flat",
    name: "Flat",
    par: 2,
    tee: [180, 560],
    cup: [180, 120],
    walls: [
      { points: [[20, 20], [340, 20], [340, 620], [20, 620]], closed: true },
    ],
    bumpers: [],
    sand: [],
    water: [],
    slopes: [],
    movers: [],
    ...overrides,
  };
}

describe("physics determinism", () => {
  it("same shot yields identical end state twice", () => {
    const level = flatLevel();
    const state = { x: 180, y: 560, t: 0 };
    const shot = { angle: -Math.PI / 2, power: 0.5 };
    const a = simulateShot(level, state, shot);
    const b = simulateShot(level, state, shot);
    expect(a.end).toEqual(b.end);
    expect(a.holed).toEqual(b.holed);
    expect(a.steps).toEqual(b.steps);
  });

  it("matches across two createSim instances", () => {
    const level = flatLevel();
    const shot = { angle: -Math.PI / 2 + 0.2, power: 0.7 };
    const run = () => {
      const sim = createSim(level);
      sim.shoot(shot);
      while (!sim.atRest && !sim.holed) sim.step();
      return sim.ball;
    };
    expect(run()).toEqual(run());
  });
});

describe("physics behavior", () => {
  it("ball on flat green eventually stops", () => {
    const level = flatLevel();
    const sim = createSim(level);
    sim.shoot({ angle: -Math.PI / 2, power: 0.3 });
    let steps = 0;
    while (!sim.atRest && steps < 20000) {
      sim.step();
      steps++;
    }
    expect(sim.atRest).toBe(true);
    expect(sim.vx).toBe(0);
    expect(sim.vy).toBe(0);
  });

  it("wall bounce reverses normal velocity component", () => {
    const level = flatLevel();
    const state = { x: 180, y: 80, t: 0 };
    const shot = { angle: Math.PI / 2, power: 0.35 };
    const result = simulateShot(level, state, shot);
    expect(result.end.y).toBeLessThan(620 - BALL_R);
  });

  it("water returns ball to shot start and flags inWater", () => {
    const level = flatLevel({
      water: [{ poly: [[140, 200], [220, 200], [220, 280], [140, 280]] }],
    });
    const state = { x: 180, y: 560, t: 0 };
    const shot = { angle: -Math.PI / 2, power: 0.75 };
    const result = simulateShot(level, state, shot);
    expect(result.inWater).toBe(true);
    expect(result.end.x).toBeCloseTo(state.x, 0);
    expect(result.end.y).toBeCloseTo(state.y, 0);
  });

  it("mover position is periodic", () => {
    const m = {
      from: [100, 300] as [number, number],
      to: [260, 300] as [number, number],
      width: 60,
      thickness: 10,
      period: 3,
    };
    const a = moverCenter(m, 0);
    const b = moverCenter(m, 3);
    expect(a[0]).toBeCloseTo(b[0], 5);
    expect(a[1]).toBeCloseTo(b[1], 5);
    const mid = moverCenter(m, 1.5);
    expect(mid[0]).toBeCloseTo(260, 1);
  });
});

describe("wall bounce", () => {
  it("reflects upward velocity off bottom interior", () => {
    const level = flatLevel();
    const sim = createSim(level);
    sim.shoot({ angle: Math.PI / 2, power: 0.25 });
    let maxY = 0;
    for (let i = 0; i < 800; i++) {
      sim.step();
      maxY = Math.max(maxY, sim.ball.y);
      if (sim.atRest) break;
    }
    expect(maxY).toBeGreaterThan(560 + BALL_R);
    expect(sim.ball.y).toBeLessThan(maxY);
  });
});


describe("no tunneling", () => {
  it("keeps all 360 full-power paths inside a 320x600 box and off a thin wall", () => {
    const wallX = 187;
    const level = flatLevel({
      tee: [180, 320],
      cup: [310, 580],
      walls: [
        ...flatLevel().walls,
        { points: [[wallX, 100], [wallX, 540]], closed: false },
      ],
      bumpers: [{ x: 105, y: 180, r: 18 }, { x: 115, y: 445, r: 22 }],
    });
    for (let angle = 0; angle < 360; angle++) {
      const shot = { angle: angle * Math.PI / 180, power: 1 };
      const state = { x: 180, y: 320, t: 0 };
      const result = simulateShot(level, state, shot, { recordPath: true });
      expect(result, `determinism at ${angle} degrees`).toEqual(
        simulateShot(level, state, shot, { recordPath: true })
      );
      const path = result.path!;
      for (let i = 0; i < path.length; i++) {
        const [x, y] = path[i];
        expect(x, `x at ${angle} degrees`).toBeGreaterThanOrEqual(20 + BALL_R - 1e-8);
        expect(x).toBeLessThanOrEqual(340 - BALL_R + 1e-8);
        expect(y).toBeGreaterThanOrEqual(20 + BALL_R - 1e-8);
        expect(y).toBeLessThanOrEqual(620 - BALL_R + 1e-8);
        if (i === 0) continue;
        const [px, py] = path[i - 1];
        if ((px - wallX) * (x - wallX) < 0) {
          const crossingY = py + (y - py) * (wallX - px) / (x - px);
          expect(crossingY < 100 || crossingY > 540, `wall crossing at ${angle} degrees`).toBe(true);
        }
      }
    }
  });

  it.each([false, true])("reflects a full-power shot resting against a wall (reversed=%s)", reversed => {
    const points: [number, number][] = [[200, 100], [200, 540]];
    if (reversed) points.reverse();
    const level = flatLevel({ walls: [...flatLevel().walls, { points, closed: false }] });
    const sim = createSim(level, { x: 200 - BALL_R, y: 320, t: 0 });
    sim.shoot({ angle: 0, power: 1 });
    sim.step();
    expect(sim.vx).toBeLessThan(0);
    expect(sim.ball.x).toBeLessThanOrEqual(200 - BALL_R);
    const result = simulateShot(level, { x: 200 - BALL_R, y: 320, t: 0 }, { angle: 0, power: 1 }, { recordPath: true });
    expect(result.path!.every(([x]) => x <= 200 - BALL_R + 1e-8)).toBe(true);
  });

  it("uses relative motion when a fast mover sweeps into a slow ball", () => {
    const mover = { from: [100, 320] as [number, number], to: [260, 320] as [number, number], width: 20, thickness: 4, period: 0.1 };
    const level = flatLevel({ movers: [mover] });
    const run = () => {
      const sim = createSim(level, { x: 210, y: 320, t: 0.025 });
      sim.shoot({ angle: 0, power: 0.01 });
      sim.step();
      const center = moverCenter(mover, sim.ball.t);
      expect(sim.ball.x).toBeGreaterThanOrEqual(center[0] + mover.width / 2 + BALL_R - 1e-8);
      expect(sim.vx).toBeGreaterThan(0);
      expect(sim.ball.t).toBe(0.025 + DT);
      expect(sim.steps).toBe(1);
      return { ball: sim.ball, vx: sim.vx, vy: sim.vy, events: sim.events };
    };
    expect(run()).toEqual(run());
  });
});

describe("cup feel", () => {
  const level = flatLevel({ cup: [180, 320] });
  const approach = (x: number, y: number, speed: number) => {
    const sim = createSim(level, { x, y, t: 0 });
    sim.shoot({ angle: -Math.PI / 2, power: speed / 900 });
    return sim;
  };

  it("captures a slow ball inside radius 9, but not a grazing ball at radius 10", () => {
    const center = approach(180, 330, 120);
    center.step();
    expect(center.holed).toBe(true);
    expect(center.events).toEqual([{ type: "holed" }]);
    expect(center.ball).toEqual({ x: 180, y: 320, t: DT });
    const edge = approach(190, 320, 100);
    edge.step();
    expect(edge.holed).toBe(false);
    expect(edge.events).toEqual([]);
  });

  it.each([230, 300, 330])("drops a centered firm putt at %s u/s", speed => {
    const sim = approach(180, 330, speed);
    sim.step();
    expect(sim.holed).toBe(true);
    expect(sim.events).toEqual([{ type: "holed", firm: true }]);
  });

  it("uses path offset rather than entry distance for a firm drop", () => {
    const sim = approach(184, 330, 300);
    sim.step();
    expect(sim.holed).toBe(true);
    expect(sim.events).toEqual([{ type: "holed", firm: true }]);
  });

  it.each([-7, 7])("catches an off-center 300 u/s putt once (offset %s)", offset => {
    const run = () => {
      const sim = approach(180 + offset, 330, 300);
      sim.step();
      const angle = Math.PI / 3 * (120 / 190) * (7 / 11);
      const speed = 300 * 0.65 - 400 * DT;
      expect(sim.vx).toBeCloseTo(Math.sign(offset) * Math.sin(angle) * speed, 10);
      expect(sim.vy).toBeCloseTo(-Math.cos(angle) * speed, 10);
      expect(sim.events).toEqual([{ type: "lip-out" }]);
      for (let i = 0; i < 25; i++) sim.step();
      expect(sim.holed).toBe(false);
      expect(sim.events).toEqual([{ type: "lip-out" }]);
      return { ball: sim.ball, vx: sim.vx, vy: sim.vy, events: sim.events };
    };
    expect(run()).toEqual(run());
  });

  it.each([331, 400, 600])("hops a centered %s u/s putt over without recapturing it", speed => {
    const sim = approach(180, 330, speed);
    for (let i = 0; i < 15; i++) sim.step();
    expect(sim.holed).toBe(false);
    expect(sim.ball.y).toBeLessThan(300);
    expect(sim.events).toEqual([{ type: "rim" }]);
  });

  it.each([
    [184.94, 330, 300, "holed"],
    [184.96, 330, 300, "lip-out"],
    [187, 328, 420, "lip-out"],
    [187, 328, 421, "rim"],
  ] as const)("respects cup thresholds at (%s, %s), speed %s", (x, y, speed, event) => {
    const sim = approach(x, y, speed);
    sim.step();
    expect(sim.events.map(e => e.type)).toEqual([event]);
    expect(sim.holed).toBe(event === "holed");
  });

  it("skims a fast off-center putt with a tiny turn and no rim speed loss", () => {
    const sim = approach(187, 328, 600);
    sim.step();
    expect(sim.holed).toBe(false);
    expect(sim.events).toEqual([{ type: "rim" }]);
    expect(Math.hypot(sim.vx, sim.vy)).toBeCloseTo(600 - 400 * DT, 10);
    expect(Math.atan2(sim.vx, -sim.vy)).toBeGreaterThan(0);
    expect(Math.atan2(sim.vx, -sim.vy)).toBeLessThan(2 * Math.PI / 180);
  });

  it("pulls a moving ball toward the center only below 300 u/s and inside 1.6 R", () => {
    const pulled = approach(192, 325, 100);
    pulled.step();
    expect(pulled.vx).toBeLessThan(-0.5);
    const fast = approach(192, 325, 300);
    fast.step();
    expect(fast.vx).toBeCloseTo(0, 10);
    const outside = approach(198, 325, 100);
    outside.step();
    expect(outside.vx).toBeCloseTo(0, 10);
  });

  it("never moves a resting ball outside the pull region", () => {
    const sim = createSim(level, { x: 198, y: 320, t: 0 });
    for (let i = 0; i < 120; i++) sim.step();
    expect(sim.ball).toEqual({ x: 198, y: 320, t: 0 });
    expect(sim.atRest).toBe(true);
    sim.shoot({ angle: 0, power: 0 });
    for (let i = 0; i < 3; i++) sim.step();
    expect(sim.ball).toEqual({ x: 198, y: 320, t: 3 * DT });
    expect(sim.atRest).toBe(true);
  });
});

describe("settling", () => {
  it("requires three consecutive fixed ticks below 4 u/s and resets on a new shot", () => {
    const sim = createSim(flatLevel());
    for (let shot = 0; shot < 2; shot++) {
      sim.shoot({ angle: 0, power: 3 / 900 });
      sim.step();
      expect(sim.atRest).toBe(false);
      sim.step();
      expect(sim.atRest).toBe(false);
      sim.step();
      expect(sim.atRest).toBe(true);
      expect(sim.vx).toBe(0);
      expect(sim.vy).toBe(0);
    }
    expect(sim.steps).toBe(6);
  });

  it("clears the settle counter when a slope accelerates the ball above 4", () => {
    const sim = createSim(flatLevel({ slopes: [{
      poly: [[100, 300], [200, 300], [200, 340], [100, 340]], force: [600, 0],
    }] }), { x: 100, y: 320, t: 0 });
    sim.shoot({ angle: 0, power: 0 });
    sim.step(); // 1.67 after friction
    sim.step(); // 3.33 after friction
    expect(sim.atRest).toBe(false);
    sim.step(); // 5: reset, rather than settling on the third tick
    expect(sim.vx).toBeGreaterThan(4);
    expect(sim.atRest).toBe(false);
  });
});
