import { describe, expect, it } from "vitest";
import { createSim, DT, simulateShot } from "../src/sim/physics.js";
import { fastTurfTracker } from "../src/sim/fastTurf.js";
import type { Level, PolyZone, SimEvent } from "../src/sim/types.js";

const patch = (left: number, top: number, right: number, bottom: number): PolyZone => ({
  poly: [[left, top], [right, top], [right, bottom], [left, bottom]],
});
const level = (extra: Partial<Level> = {}): Level => ({
  id: "mechanics", name: "Mechanics", par: 3, tee: [180, 560], cup: [300, 100],
  walls: [{ points: [[20, 72], [340, 72], [340, 620], [20, 620]], closed: true }],
  bumpers: [], water: [], slopes: [], sand: [], movers: [], ...extra,
});

describe("fast turf", () => {
  it("applies exactly 140/s deceleration, with sand taking precedence", () => {
    const run = (sand: boolean) => {
      const turf = patch(40, 100, 320, 600);
      const sim = createSim(level({ fastTurf: [turf], sand: sand ? [turf] : [] }));
      sim.shoot({ angle: -Math.PI / 2, power: 0.4 }); sim.step();
      expect(Math.hypot(sim.vx, sim.vy)).toBeCloseTo(360 - (sand ? 1600 : 140) * DT, 10);
    };
    run(false); run(true);
  });
  it("uses swept fractions for a subpixel patch without stacking overlaps", () => {
    const events: SimEvent[] = [];
    const track = fastTurfTracker([patch(0.4, 0, 0.5, 10), patch(0.45, 0, 0.55, 10)], events);
    track.start(0, 5);
    expect(track.sweep(0, 5, 2, 5)).toBeCloseTo(0.075, 12);
    expect(events).toEqual([
      { type: "fast-turf-enter", index: 0, x: 0.4, y: 5 },
      { type: "fast-turf-exit", index: 0, x: 0.5, y: 5 },
      { type: "fast-turf-enter", index: 1, x: 0.45, y: 5 },
      { type: "fast-turf-exit", index: 1, x: 0.55, y: 5 },
    ]);
  });
  it("cannot tunnel over a thin strip at maximum shot speed", () => {
    const sim = createSim(level({ fastTurf: [patch(40, 555.1, 320, 555.2)] }));
    sim.shoot({ angle: -Math.PI / 2, power: 1 }); sim.step();
    expect(sim.events.map(e => e.type)).toEqual(["fast-turf-enter", "fast-turf-exit"]);
    expect(sim.vy).toBeLessThan(-900 + 400 * DT);
  });
  it("emits exact enter/exit positions, including travel in the reverse direction", () => {
    const events: SimEvent[] = [];
    const track = fastTurfTracker([patch(10, 10, 30, 30)], events);
    track.start(20, 20); track.sweep(20, 20, 40, 20); track.sweep(40, 20, 0, 20);
    expect(events.map(e => [e.type, "x" in e && e.x])).toEqual([
      ["fast-turf-enter", 20], ["fast-turf-exit", 30], ["fast-turf-enter", 30], ["fast-turf-exit", 10],
    ]);
  });
  it("tangent motion does not acquire coverage and stationary interior has full coverage", () => {
    const events: SimEvent[] = [];
    const track = fastTurfTracker([patch(10, 10, 30, 30)], events);
    expect(track.sweep(0, 40, 40, 0)).toBeCloseTo(0.5);
    expect(track.sweep(0, 60, 60, 0)).toBe(0);
    expect(track.sweep(20, 20, 20, 20)).toBe(1);
  });
  it("exits at the water contact and does not wake a resting ball", () => {
    const sim = createSim(level({ fastTurf: [patch(40, 300, 320, 590)], water: [patch(40, 400, 320, 430)] }));
    const initial = { ...sim.ball }; sim.step(); expect(sim.ball).toEqual(initial);
    sim.shoot({ angle: -Math.PI / 2, power: 0.5 });
    while (!sim.atRest) sim.step();
    expect(sim.inWater).toBe(true);
    const exit = sim.events.find(e => e.type === "fast-turf-exit");
    expect(exit && "y" in exit && exit.y).toBeLessThanOrEqual(430);
    expect(sim.ball.x).toBe(initial.x); expect(sim.ball.y).toBe(initial.y);
  });
  it("settles, restarts inside a patch, and reproduces complete paths exactly", () => {
    const course = level({ fastTurf: [patch(40, 100, 320, 600)] });
    const sim = createSim(course); sim.shoot({ angle: -Math.PI / 2, power: 0.1 });
    while (!sim.atRest) sim.step();
    expect(sim.ball.y).toBeLessThan(540);
    sim.shoot({ angle: 0, power: 0.1 });
    expect(sim.events[0].type).toBe("fast-turf-enter");
    const shot = { angle: -1.3, power: 0.7 }, start = { x: 180, y: 560, t: 2.5 };
    expect(simulateShot(course, start, shot, { recordPath: true })).toEqual(simulateShot(course, start, shot, { recordPath: true }));
  });
});

describe("one-way wickets", () => {
  const gate = { from: [60, 320] as [number, number], to: [300, 320] as [number, number], normal: [0, -1] as [number, number] };
  it("permits forward entry and exit at full power", () => {
    const sim = createSim(level({ oneWayGates: [gate] }), { x: 180, y: 328, t: 0 });
    sim.shoot({ angle: -Math.PI / 2, power: 1 });
    for (let i = 0; i < 4; i++) sim.step();
    expect(sim.ball.y).toBeLessThan(306); expect(sim.vy).toBeLessThan(0);
    expect(sim.events).toEqual([]);
  });
  it("reflects reverse motion with exact restitution and localized event", () => {
    const sim = createSim(level({ oneWayGates: [gate] }), { x: 180, y: 312.9, t: 0 });
    sim.shoot({ angle: Math.PI / 2, power: 0.2 }); sim.step();
    expect(sim.vy).toBeCloseTo(-180 * 0.8 + 400 * DT, 10);
    expect(sim.ball.y).toBe(313);
    expect(sim.events).toEqual([{ type: "one-way-hit", index: 0, x: 180, y: 320, nx: 0, ny: -1, speed: 180 }]);
  });
  it("prevents reverse tunneling at full power, oblique angles and exact contact", () => {
    for (const angle of [Math.PI / 2, Math.PI / 3, 2 * Math.PI / 3]) {
      const sim = createSim(level({ oneWayGates: [gate] }), { x: 180, y: 313, t: 1.25 });
      sim.shoot({ angle, power: 1 }); sim.step();
      expect(sim.ball.y).toBeLessThanOrEqual(313); expect(sim.vy).toBeLessThan(0);
      expect(sim.events.filter(e => e.type === "one-way-hit")).toHaveLength(1);
    }
  });
  it("permits parallel travel and departure from the back side", () => {
    for (const [y, angle] of [[310, 0], [322, Math.PI / 2]]) {
      const sim = createSim(level({ oneWayGates: [gate] }), { x: 180, y, t: 0 });
      sim.shoot({ angle, power: 0.3 }); sim.step(); expect(sim.events).toEqual([]);
    }
  });
  it("has rounded endpoints which can be passed outside the ball radius", () => {
    const sim = createSim(level({ oneWayGates: [gate] }), { x: 51, y: 310, t: 0 });
    sim.shoot({ angle: Math.PI / 2, power: 0.4 });
    for (let i = 0; i < 12; i++) sim.step();
    expect(sim.ball.y).toBeGreaterThan(330); expect(sim.events).toEqual([]);
  });
  it("supports vertical wickets and has no clock phase or resting force", () => {
    const course = level({ oneWayGates: [{ from: [200, 100], to: [200, 600], normal: [1, 0] }] });
    const run = (t: number) => {
      const sim = createSim(course, { x: 207, y: 400, t }); sim.step(); expect(sim.ball.x).toBe(207);
      sim.shoot({ angle: Math.PI, power: 1 }); sim.step(); return sim;
    };
    const a = run(0), b = run(4.125);
    expect(a.vx).toBeGreaterThan(0); expect(a.ball.x).toBe(b.ball.x); expect(a.events).toEqual(b.events);
  });
  it("is bit-for-bit deterministic when combined with turf and moving bars", () => {
    const course = level({ oneWayGates: [gate], fastTurf: [patch(40, 180, 320, 580)],
      movers: [{ from: [100, 250], to: [240, 250], width: 44, thickness: 10, period: 3.5 }] });
    const run = () => {
      const sim = createSim(course); sim.shoot({ angle: -1.7, power: 0.9 });
      while (!sim.atRest) sim.step(); return { ball: sim.ball, events: sim.events, steps: sim.steps };
    };
    expect(run()).toEqual(run());
  });
});

it("refreshes the wall index after an in-place edit between shots on the same sim", () => {
  const course = level({ walls: [
    { points: [[20, 72], [340, 72], [340, 620], [20, 620]], closed: true },
    { points: [[250, 100], [250, 600]], closed: false },
  ] });
  const sim = createSim(course, { x: 180, y: 400, t: 0 });
  sim.shoot({ angle: 0, power: 0.1 }); while (!sim.atRest) sim.step();
  course.walls[1].points[0][0] = 210; course.walls[1].points[1][0] = 210;
  sim.shoot({ angle: 0, power: 0.3 });
  for (let i = 0; i < 10; i++) sim.step();
  expect(sim.vx).toBeLessThan(0);
  expect(sim.ball.x).toBeLessThanOrEqual(203);
  expect(sim.events.some(e => e.type === "wall-hit")).toBe(true);
});
