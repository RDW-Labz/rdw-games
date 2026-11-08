import { afterEach, expect, it, vi } from "vitest";
const originalArgs = [...process.argv];
afterEach(() => {
  process.argv = [...originalArgs];
  vi.doUnmock("node:fs"); vi.doUnmock("../src/sim/solver.js");
  vi.restoreAllMocks(); vi.resetModules();
});
function setup(sandCounts: number[], world?: string) {
  vi.resetModules();
  process.argv = [originalArgs[0], "check-levels.ts", ...(world ? ["--world", world] : [])];
  const files = Array.from({ length: 36 }, (_, i) => `hole${String(i + 1).padStart(2, "0")}.json`);
  vi.doMock("node:fs", () => ({
    readdirSync: () => files,
    readFileSync: (path: string) => {
      const n = Number(path.match(/hole(\d+)/)![1]) - 1;
      return JSON.stringify({ id: files[n].slice(0, -5), name: "Policy", par: 3, tee: [180, 550], cup: [180, 130],
        walls: [{ points: [[30,80],[330,80],[330,610],[30,610]], closed: true }],
        sand: n % 12 < sandCounts[Math.floor(n / 12)] ? [{poly:[[40,200],[70,200],[70,220],[40,220]]}] : [],
      });
    },
  }));
  const solve = vi.fn(() => ({ solvable: true, strokes: 2, cushions: 1, feasible: true, worstPassRate: 1, explored: 960 }));
  vi.doMock("../src/sim/solver.js", () => ({ parseIntended: () => undefined, solveLevel: solve }));
  const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  return { solve, exit, error };
}
it("keeps the four-sand-hole limit independently in all three worlds", async () => {
  const { solve, exit } = setup([4, 4, 4]);
  await import("../scripts/check-levels.js");
  expect(solve).toHaveBeenCalledTimes(36); expect(exit).not.toHaveBeenCalled();
});
it("fails a fifth sand hole in a paid world", async () => {
  const { exit, error } = setup([0, 5, 0]);
  await import("../scripts/check-levels.js");
  expect(exit).toHaveBeenCalledWith(1); expect(error).toHaveBeenCalledWith("fail: world 2: 5 holes use sand, maximum 4");
});
it("filters exactly the requested twelve holes without dropping their sand gate", async () => {
  const { solve, exit } = setup([5, 0, 5], "3");
  await import("../scripts/check-levels.js");
  expect(solve.mock.calls.map(call => (call as unknown as [{id:string}])[0].id)).toEqual(Array.from({length:12}, (_, i) => `hole${i+25}`));
  expect(exit).toHaveBeenCalledWith(1);
});
it.each(["0", "4", "NaN"])("rejects invalid --world %s", async world => {
  setup([0, 0, 0], world);
  await expect(import("../scripts/check-levels.js")).rejects.toThrow("--world requires 1, 2 or 3");
});
it("retains the exact 900-second hard runtime gate", async () => {
  const { exit, error } = setup([0, 0, 0]);
  vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(900_000);
  await import("../scripts/check-levels.js");
  expect(exit).toHaveBeenCalledWith(1); expect(error).toHaveBeenCalledWith("fail: level checks exceeded 900 seconds");
});
