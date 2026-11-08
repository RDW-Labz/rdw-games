import { readFileSync, readdirSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as physics from "../src/sim/physics.js";
import { parseLevel, sandAreaFraction } from "../src/sim/level.js";
import { measureStroke, parseIntended, solveLevel } from "../src/sim/solver.js";
import type { BallState, Level, SimulateShotResult } from "../src/sim/types.js";

function openLevel(): Level {
  return {
    id: "open",
    name: "Open",
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
  };
}

describe("solveLevel", () => {
  it("finds a 1-stroke solution on a trivial open level", () => {
    const result = solveLevel(openLevel(), { maxStrokes: 3 });
    expect(result.solvable).toBe(true);
    expect(result.strokes).toBe(1);
    expect(result.shots.length).toBe(1);
  });

  it("reports unsolvable when cup is walled off", () => {
    const level: Level = {
      ...openLevel(),
      walls: [
        { points: [[20, 20], [340, 20], [340, 620], [20, 620]], closed: true },
        { points: [[20, 200], [340, 200]], closed: false },
      ],
    };
    const min = solveLevel(level, { maxStrokes: 4 });
    expect(min.solvable).toBe(false);
    expect(min.shots).toEqual([]);
    const tight = solveLevel(level, { maxStrokes: 1 });
    expect(tight.solvable).toBe(false);
  });
});


// Keep mocks local: integration cases always use real physics.
afterEach(() => vi.restoreAllMocks());

type MeasuredOutcome = SimulateShotResult & { cushions?: number };
function outcome(state: BallState, changes: Partial<MeasuredOutcome> = {}): MeasuredOutcome {
  return { end: state, holed: false, inWater: false, steps: 1, ...changes };
}


// A one-tick physics double keeps search-policy tests independent of layouts.
function mockShots(run: (level: Level, state: BallState, shot: { angle: number; power: number }) => MeasuredOutcome) {
  const calls: [Level, BallState, { angle: number; power: number }][] = [];
  vi.spyOn(physics, "createSim").mockImplementation((level, initial) => {
    const state = initial ?? { x: level.tee[0], y: level.tee[1], t: 0 };
    const sim = {
      ball: state, vx: 0, vy: 0, atRest: true, holed: false, inWater: false,
      events: [] as physics.SimInstance["events"], shotStart: state, steps: 0,
      shoot(shot: { angle: number; power: number }) {
        calls.push([level, state, shot]);
        const result = run(level, state, shot);
        sim.atRest = false;
        sim.step = () => {
          sim.ball = result.end; sim.holed = result.holed; sim.inWater = result.inWater;
          sim.events = Array.from({ length: result.cushions ?? 0 }, () => ({ type: "wall-hit", speed: 100 }));
          sim.atRest = true; sim.steps = 1;
        };
      },
      step() {},
    };
    return sim;
  });
  return { mock: { calls } };
}

describe("solver stroke priorities", () => {
  it("examines all 960 shots even when the first candidate holes", () => {
    const simulate = mockShots((_level, state) =>
      outcome(state, { holed: true })
    );
    const result = solveLevel(openLevel());
    expect(result.strokes).toBe(1);
    expect(result.explored).toBe(960);
    expect(simulate.mock.calls.slice(0, 960).map(call => call[2])).toHaveLength(960);
    expect(simulate.mock.calls[959][2]).toEqual({ angle: 95 / 96 * 2 * Math.PI, power: 1 });
  });

  it("prefers a clean three-shot route to two shots plus a water penalty", () => {
    const level = openLevel();
    level.movers = [{ from: [30, 30], to: [60, 30], width: 10, thickness: 4, period: 8 }];
    mockShots((_level, state, shot) => {
      if (shot.angle !== 0) return outcome(state);
      if (state.x === 180 && state.t === 0) {
        if (shot.power === 0.1) return outcome(state, { inWater: true, cushions: 1, end: { ...state, t: 1 } });
        if (shot.power === 0.2) return outcome(state, { end: { x: 150, y: 400, t: 1 } });
      }
      if (shot.power === 0.1) {
        if (state.x === 150) return outcome(state, { end: { x: 100, y: 300, t: 2 } });
        if (state.x === 100 || (state.x === 180 && state.t === 1)) return outcome(state, { holed: true });
      }
      return outcome(state);
    });
    const result = solveLevel(level, { maxStrokes: 3 });
    expect(result.solvable).toBe(true);
    expect(result.strokes).toBe(3);
    expect(result.shots).toHaveLength(3);
    expect(result.shots[0].power).toBe(0.2);
    expect(solveLevel(level, { maxStrokes: 2 }).solvable).toBe(false);
  });

  it("counts a required water penalty in the total and budget", () => {
    const level = openLevel();
    level.movers = [{ from: [30, 30], to: [60, 30], width: 10, thickness: 4, period: 8 }];
    mockShots((_level, state) =>
      state.t === 0
        ? outcome(state, { inWater: true, end: { ...state, t: 1 } })
        : outcome(state, { holed: true })
    );
    const result = solveLevel(level, { maxStrokes: 3 });
    expect(result.strokes).toBe(3);
    expect(result.shots).toHaveLength(2);
    expect(solveLevel(level, { maxStrokes: 2 }).solvable).toBe(false);
  });
});

describe("human feasibility", () => {
  it("charges the original prefix and variant water penalty before replanning", () => {
    mockShots((_level, state, shot) => {
      if (state.x === 180) {
        return outcome(state, shot.angle === 0 && shot.power === 0.5
          ? { end: { x: 100, y: 300, t: 1 } } : {});
      }
      if (state.x === 100 && state.t === 1) {
        return outcome(state, shot.angle === 0 && shot.power === 0.4
          ? { holed: true } : { inWater: true, end: { ...state, t: 2 } });
      }
      if (state.x === 100) return outcome(state, { end: { x: 80, y: 200, t: 3 } });
      return outcome(state, { holed: true });
    });
    const result = solveLevel(openLevel());
    expect(result.strokes).toBe(2);
    expect(result.worstPassRate).toBe(1 / 9);
    expect(result.feasible).toBe(false);
  });

  it.each([5, 6])("requires six of nine variants (passes=%s)", passes => {
    const variantStarts = new Set<number>();
    mockShots((_level, state, shot) => {
      if (state.x === 180) {
        if (shot.angle === 0 && shot.power === 0.5) return outcome(state, { holed: true });
        const a = Math.round(shot.angle / (Math.PI / 180)) + 1;
        const p = Math.round((shot.power - 0.5) / 0.03) + 1;
        const isVariant = a >= 0 && a <= 2 && p >= 0 && p <= 2
          && Math.abs(shot.angle - (a - 1) * Math.PI / 180) < 1e-10
          && Math.abs(shot.power - (0.5 + (p - 1) * 0.03)) < 1e-10;
        if (isVariant) return outcome(state, { end: { x: 40 + (a * 3 + p) * 10, y: 300, t: 1 } });
        return outcome(state);
      }
      variantStarts.add(state.x);
      const index = (state.x - 40) / 10;
      return outcome(state, { holed: index < passes && shot.angle === Math.PI / 2 && shot.power === 0.2 });
    });
    // maxStrokes controls finding the original solution; feasibility uses par+2.
    const result = solveLevel(openLevel(), { maxStrokes: 1 });
    expect(result.strokes).toBe(1);
    expect(result.worstPassRate).toBe(passes / 9);
    expect(result.feasible).toBe(passes >= 6);
    expect(result.robust).toBe(result.feasible);
    // The eight displaced variants need newly aimed shots, not the old suffix.
    expect(variantStarts.size).toBe(8);
  });
});

describe("intended routes and cushions", () => {
  it("prefers fewer contacts, then shorter travel, across all equal-score finishes", () => {
    mockShots((_level, state, shot) => outcome(state, {
      holed: true, cushions: shot.power < 0.3 ? 2 : 0,
      end: { ...state, x: state.x + (shot.power === 0.5 ? 10 : 30) },
    }));
    const result = solveLevel(openLevel(), { checkFeasibility: false });
    expect(result.shots[0].power).toBe(0.5);
    expect(result.cushions).toBe(0);
  });

  it("rejects a finish above the per-stroke limit and finds a longer restricted route", () => {
    mockShots((_level, state, shot) => {
      if (state.x === 180) return shot.power === 0.1
        ? outcome(state, { holed: true, cushions: 3 })
        : outcome(state, { end: { x: 100, y: 300, t: 1 }, cushions: 1 });
      return outcome(state, { holed: true, cushions: 1 });
    });
    expect(solveLevel(openLevel(), { maxStrokes: 1 }).cushions).toBe(3);
    expect(solveLevel(openLevel(), { maxStrokes: 1, maxCushions: 2 }).solvable).toBe(false);
    const route = solveLevel(openLevel(), { maxStrokes: 2, maxCushions: 1 });
    expect(route.strokes).toBe(2);
    expect(route.cushions).toBe(1); // Maximum per stroke, not the total of two.
  });

  it("counts wall events and mover contact while excluding free travel and bumpers", () => {
    const level = openLevel();
    const wall = measureStroke(level, { x: 180, y: 590, t: 0 }, { angle: Math.PI / 2, power: 0.3 });
    expect(wall.cushions).toBe(1);
    const moverLevel = { ...level, movers: [{ from: [130, 400] as [number, number], to: [230, 400] as [number, number], width: 180, thickness: 12, period: 4 }] };
    const shot = { angle: -Math.PI / 2, power: 0.5 };
    expect(measureStroke(moverLevel, { x: 180, y: 460, t: 0 }, shot).cushions).toBe(1);
    expect(measureStroke(moverLevel, { x: 50, y: 560, t: 0 }, { angle: -Math.PI / 2, power: 0.2 }).cushions).toBe(0);
    expect(measureStroke({ ...level, bumpers: [{ x: 180, y: 400, r: 18 }] }, { x: 180, y: 460, t: 0 }, { ...shot, power: 0.3 }).cushions).toBe(0);
  });

  it("invalidates authoring caches when an existing Level is edited", () => {
    mockShots((level, state) => outcome(state, { holed: level.cup[0] === 180 }));
    const level = openLevel();
    expect(solveLevel(level, { maxStrokes: 1 }).solvable).toBe(true);
    level.cup = [200, 120];
    expect(solveLevel(level, { maxStrokes: 1 }).solvable).toBe(false);
  });

  it("validates optional intended authoring metadata", () => {
    expect(parseIntended({})).toBeUndefined();
    expect(parseIntended({ intended: { strokes: 3, maxCushions: 2 } })).toEqual({ strokes: 3, maxCushions: 2 });
    for (const intended of [null, {}, { strokes: 0, maxCushions: 2 }, { strokes: 2, maxCushions: -1 }, { strokes: 2, maxCushions: 1.5 }]) {
      expect(() => parseIntended({ intended }, "fixture")).toThrow(/fixture.intended/);
    }
  });

  it("finds the Z bank route in two strokes with no pinball finish", () => {
    const level = parseLevel(JSON.parse(readFileSync(new URL("../levels/hole02.json", import.meta.url), "utf8")));
    const overall = solveLevel(level);
    expect(overall.feasible).toBe(true);
    const result = solveLevel(level, { maxStrokes: 2, maxCushions: 2, checkFeasibility: false });
    expect(result.strokes).toBe(2);
    expect(result.cushions).toBeLessThanOrEqual(2);
  }, 20_000);
});

describe("check-levels policy", () => {
  it.each([
    { name: "parse error", par: 3, best: 2, feasible: true, invalid: true, fails: true, warns: false },
    { name: "unsolvable", par: 3, best: 0, feasible: false, invalid: false, fails: true, warns: false },
    { name: "over budget", par: 3, best: 6, feasible: true, invalid: false, fails: true, warns: false },
    { name: "accidental hole-in-one", par: 3, best: 1, feasible: true, invalid: false, fails: true, warns: true },
    { name: "par too high", par: 5, best: 3, feasible: true, invalid: false, fails: true, warns: true },
    { name: "not feasible", par: 3, best: 2, feasible: false, invalid: false, fails: true, warns: true },
    { name: "intended route fails", par: 3, best: 2, feasible: true, invalid: false, fails: true, warns: false, intended: { strokes: 2, maxCushions: 0 } },
    { name: "invalid intended", par: 3, best: 2, feasible: true, invalid: false, fails: true, warns: false, intended: { strokes: 2, maxCushions: -1 } },
    { name: "excess sand area", par: 3, best: 2, feasible: true, invalid: false, fails: true, warns: false, sand: [{ poly: [[20,20],[340,20],[340,200],[20,200]] }] },
    { name: "four sand holes at area limit", par: 3, best: 2, feasible: true, invalid: false, fails: false, warns: false, copies: 4, sand: [{ poly: [[20,20],[340,20],[340,140],[20,140]] }] },
    { name: "fifth sand hole", par: 3, best: 2, feasible: true, invalid: false, fails: true, warns: false, copies: 5, sand: [{ poly: [[20,20],[340,20],[340,60],[20,60]] }] },
    { name: "low worst rate despite feasible flag", par: 3, best: 2, feasible: true, invalid: false, fails: true, warns: true, worst: 0.59 },
    { name: "valid hole", par: 3, best: 2, feasible: true, invalid: false, fails: false, warns: false },
  ])("$name", async testCase => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      readdirSync: () => Array.from({ length: testCase.copies ?? 1 }, (_, i) => `fixture${i}.json`),
      readFileSync: () => testCase.invalid ? "{" : JSON.stringify({ ...openLevel(), par: testCase.par, intended: testCase.intended, sand: testCase.sand ?? [] }),
    }));
    vi.doMock("../src/sim/solver.js", () => ({
      parseIntended,
      solveLevel: (_level: Level, options: { maxCushions?: number }) => ({
        solvable: options.maxCushions === undefined && testCase.best > 0, strokes: testCase.best, feasible: testCase.feasible,
        worstPassRate: testCase.worst ?? (testCase.feasible ? 1 : 5 / 9), explored: 960, cushions: 1,
      }),
    }));
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await import("../scripts/check-levels.js");
      expect(log.mock.calls[0][0]).toBe("id       | par | best | cush | feasible | worst% | explored | ms");
      if (testCase.fails) expect(exit).toHaveBeenCalledWith(1);
      else expect(exit).not.toHaveBeenCalled();
      expect(warn.mock.calls.length > 0).toBe(testCase.warns);
    } finally {
      vi.doUnmock("node:fs");
      vi.doUnmock("../src/sim/solver.js");
      vi.resetModules();
    }
  });
});


describe("free course readability", () => {
  const distance = (p: number[], a: number[], b: number[]) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  };
  it("keeps twelve unique silhouettes, safe cup clearances, and slow gates", () => {
    const dir = new URL("../levels/", import.meta.url);
    const files = readdirSync(dir).filter(file => /^hole(0[1-9]|1[0-2])\.json$/.test(file)).sort();
    expect(files).toHaveLength(12);
    const outlines = new Set<string>();
    const names = new Set<string>();
    let sandHoles = 0;
    for (const [index, file] of files.entries()) {
      const json = JSON.parse(readFileSync(new URL(file, dir), "utf8"));
      const level = parseLevel(json, file);
      const intended = parseIntended(json, file)!;
      if (level.sand.length) sandHoles++;
      expect(sandAreaFraction(level), file).toBeLessThanOrEqual(0.2);
      expect(intended.maxCushions).toBeLessThanOrEqual(2);
      expect(level.par).toBe(index === 0 ? 2 : index < 8 ? 3 : 4);
      expect(level.tee[1]).toBeGreaterThanOrEqual(640 * 2 / 3);
      outlines.add(JSON.stringify(level.walls[0].points));
      names.add(level.name);
      for (const wall of level.walls) {
        for (const [i, a] of wall.points.entries()) {
          expect(a[0], file).toBeGreaterThanOrEqual(16);
          expect(a[0], file).toBeLessThanOrEqual(344);
          expect(a[1], file).toBeGreaterThanOrEqual(72);
          expect(a[1], file).toBeLessThanOrEqual(624);
          if (!wall.closed && i === wall.points.length - 1) continue;
          const b = wall.points[(i + 1) % wall.points.length];
          expect(distance(level.cup, a, b), file).toBeGreaterThanOrEqual(30);
          for (const bumper of level.bumpers) {
            expect(distance([bumper.x, bumper.y], a, b) - bumper.r,
              `${file}: bumper must leave a ball-width gap to each wall`).toBeGreaterThanOrEqual(2 * physics.BALL_R);
          }
        }
      }
      for (const zone of [...level.sand, ...level.water, ...level.slopes]) {
        for (const [i, a] of zone.poly.entries()) {
          expect(distance(level.tee, a, zone.poly[(i + 1) % zone.poly.length]), file).toBeGreaterThanOrEqual(16);
        }
      }
      for (const mover of level.movers) {
        expect(mover.period).toBeGreaterThanOrEqual(2.5);
        expect(mover.period).toBeLessThanOrEqual(5);
      }
    }
    expect(sandHoles).toBeLessThanOrEqual(4);
    expect(outlines.size).toBe(12);
    expect(names.size).toBe(12);
  });
});
