import { expect, it } from "vitest";
import { parseLevel } from "../src/sim/level.js";
import { measureStroke, solveLevel } from "../src/sim/solver.js";
import { simulateShot } from "../src/sim/physics.js";
const fixture = () => parseLevel({
  id: "wicket", name: "Wicket", par: 3, tee: [180, 560], cup: [180, 130],
  walls: [{ points: [[100, 80], [260, 80], [260, 610], [100, 610]], closed: true }],
  oneWayGates: [{ from: [100, 330], to: [260, 330], normal: [0, -1] }],
  fastTurf: [{ poly: [[105, 350], [255, 350], [255, 480], [105, 480]] }],
});
it("solves and replays real new-mechanic shots, including feasibility", () => {
  const level = fixture(), result = solveLevel(level, { maxCushions: 0 });
  expect(result.solvable).toBe(true); expect(result.feasible).toBe(true); expect(result.worstPassRate).toBeGreaterThanOrEqual(0.6);
  let state = { x: level.tee[0], y: level.tee[1], t: 0 }, holed = false;
  for (const shot of result.shots) { const r = simulateShot(level, state, shot); state = r.end; holed = r.holed; }
  expect(holed).toBe(true);
}, 20000);
it("counts a reverse wicket reflection as a cushion", () => {
  const result = measureStroke(fixture(), { x: 180, y: 322.9, t: 0 }, { angle: Math.PI / 2, power: 0.1 });
  expect(result.cushions).toBe(1);
});
it("invalidates cached routes when a gate reverses and prevents an illegal continuation", () => {
  const level = fixture();
  expect(solveLevel(level, { maxStrokes: 1 }).solvable).toBe(true);
  level.oneWayGates![0].normal = [0, 1];
  expect(solveLevel(level, { maxStrokes: 2 }).solvable).toBe(false);
}, 20000);
it("has no extra hidden phase: turf coverage follows position on every stroke", () => {
  const level = fixture(), shot = { angle: -Math.PI / 2, power: 0.3 };
  const a = measureStroke(level, { x: 180, y: 420, t: 0 }, shot);
  const b = measureStroke(level, { x: 180, y: 420, t: 4.5 }, shot);
  expect(a.end.x).toBe(b.end.x); expect(a.end.y).toBe(b.end.y); expect(a.cushions).toBe(b.cushions);
});
