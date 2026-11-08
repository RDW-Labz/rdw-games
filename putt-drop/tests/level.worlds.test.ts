import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseLevel, sandAreaFraction } from "../src/sim/level.js";
import { parseIntended } from "../src/sim/solver.js";

const sample = JSON.parse(readFileSync(new URL("../levels/hole01.json", import.meta.url), "utf8"));
describe("paid mechanic schema", () => {
  it("keeps optional fields absent on legacy levels", () => {
    const parsed = parseLevel(sample);
    expect(parsed.fastTurf).toBeUndefined(); expect(parsed.oneWayGates).toBeUndefined();
  });
  it.each([null, {}, 3])("rejects malformed mechanic arrays: %s", value => {
    for (const field of ["fastTurf", "oneWayGates"]) {
      expect(() => parseLevel({ ...sample, [field]: value }, "fixture")).toThrow(`fixture.${field}`);
    }
  });
  it("rejects malformed polygons and gates with field context", () => {
    expect(() => parseLevel({ ...sample, fastTurf: [{ poly: [[0, 0], [1, 1]] }] }, "fixture")).toThrow("fixture.fastTurf[0].poly");
    const gate = { from: [40, 300], to: [320, 300], normal: [0, -1] };
    for (const bad of [{ to: [40, 300] }, { normal: [0, -2] }, { normal: [1, 0] }, { normal: [NaN, 0] }]) {
      expect(() => parseLevel({ ...sample, oneWayGates: [{ ...gate, ...bad }] }, "fixture")).toThrow(/fixture.oneWayGates\[0\]/);
    }
    expect(parseLevel({ ...sample, oneWayGates: [gate] }).oneWayGates).toEqual([gate]);
  });
});

const distance = (p: number[], a: number[], b: number[]) => {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};
describe("paid course authoring", () => {
  it("has 36 unique names and outlines, with all 24 paid holes under the original quality limits", () => {
    const dir = new URL("../levels/", import.meta.url);
    const files = readdirSync(dir).filter(f => /^hole\d\d\.json$/.test(f)).sort();
    expect(files).toHaveLength(36);
    const names = new Set<string>(), outlines = new Set<string>();
    const sands = [0, 0, 0];
    for (const [i, file] of files.entries()) {
      const json = JSON.parse(readFileSync(new URL(file, dir), "utf8"));
      const level = parseLevel(json, file);
      expect(level.id).toBe(`hole${String(i + 1).padStart(2, "0")}`);
      names.add(level.name); outlines.add(JSON.stringify(level.walls[0].points));
      if (level.sand.length) sands[Math.floor(i / 12)]++;
      if (i < 12) continue;
      expect(level.par).toBeGreaterThanOrEqual(3); expect(level.par).toBeLessThanOrEqual(5);
      expect(parseIntended(json)!.maxCushions).toBeLessThanOrEqual(2);
      expect(sandAreaFraction(level)).toBeLessThanOrEqual(0.2);
      expect(level.tee[1]).toBeGreaterThanOrEqual(640 * 2 / 3);
      expect(i < 24 ? level.fastTurf!.length : level.oneWayGates!.length).toBeGreaterThan(0);
      for (const wall of level.walls) for (const [j, a] of wall.points.entries()) {
        expect(a[0], file).toBeGreaterThanOrEqual(16); expect(a[0], file).toBeLessThanOrEqual(344);
        expect(a[1], file).toBeGreaterThanOrEqual(72); expect(a[1], file).toBeLessThanOrEqual(624);
        if (!wall.closed && j === wall.points.length - 1) continue;
        const b = wall.points[(j + 1) % wall.points.length];
        expect(distance(level.cup, a, b), `${file}: cup clearance`).toBeGreaterThanOrEqual(30);
        for (const bumper of level.bumpers) expect(distance([bumper.x, bumper.y], a, b) - bumper.r, `${file}: bumper clearance`).toBeGreaterThanOrEqual(14);
      }
      for (const z of [...level.sand, ...level.water, ...level.slopes, ...level.fastTurf ?? []]) {
        for (const [j, a] of z.poly.entries()) expect(distance(level.tee, a, z.poly[(j + 1) % z.poly.length]), `${file}: tee hazard gap`).toBeGreaterThanOrEqual(16);
      }
      for (const m of level.movers) { expect(m.period).toBeGreaterThanOrEqual(2.5); expect(m.period).toBeLessThanOrEqual(5); }
    }
    expect(names.size).toBe(36); expect(outlines.size).toBe(36);
    for (const count of sands) expect(count).toBeLessThanOrEqual(4);
  });
  it("isolates each mechanic in its opening two lessons", () => {
    for (const n of [13, 14, 25, 26]) {
      const l = parseLevel(JSON.parse(readFileSync(new URL(`../levels/hole${n}.json`, import.meta.url), "utf8")));
      expect([...l.sand, ...l.water, ...l.slopes, ...l.bumpers, ...l.movers]).toEqual([]);
      expect(n < 25 ? l.oneWayGates : l.fastTurf).toBeUndefined();
    }
  });
});
