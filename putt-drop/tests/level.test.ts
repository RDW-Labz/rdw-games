import { describe, expect, it } from "vitest";
import { parseLevel, sandAreaFraction } from "../src/sim/level.js";

const valid = {
  id: "test",
  name: "Test",
  par: 2,
  tee: { x: 180, y: 560 },
  cup: { x: 180, y: 120 },
  walls: [
    {
      points: [[20, 20], [340, 20], [340, 620], [20, 620]],
      closed: true,
    },
  ],
};

describe("parseLevel", () => {
  it("accepts a valid level", () => {
    const level = parseLevel(valid, "t.json");
    expect(level.id).toBe("test");
    expect(level.par).toBe(2);
  });

  it("rejects bad par", () => {
    expect(() => parseLevel({ ...valid, par: 1 }, "t.json")).toThrow(/par/);
  });

  it("rejects tee in water", () => {
    expect(() =>
      parseLevel(
        {
          ...valid,
          water: [{ poly: [[100, 500], [260, 500], [260, 600], [100, 600]] }],
        },
        "t.json"
      )
    ).toThrow(/tee.*water/i);
  });

  it("rejects polygon with fewer than 3 points", () => {
    expect(() =>
      parseLevel(
        {
          ...valid,
          sand: [{ poly: [[0, 0], [10, 10]] }],
        },
        "t.json"
      )
    ).toThrow(/sand\[0\].poly/);
  });

  it("rejects tee outside outer wall", () => {
    expect(() =>
      parseLevel({ ...valid, tee: { x: 10, y: 10 } }, "t.json")
    ).toThrow(/tee.*outer wall/i);
  });
});


describe("sand coverage", () => {
  it("measures against the silhouette, independent of polygon winding", () => {
    const rectangle: [number, number][] = [[20, 20], [340, 20], [340, 140], [20, 140]];
    const level = parseLevel({ ...valid, sand: [{ poly: rectangle }] });
    expect(sandAreaFraction(level)).toBe(0.2);
    level.sand[0].poly.reverse();
    expect(sandAreaFraction(level)).toBe(0.2);
    level.sand.push({ poly: rectangle });
    expect(sandAreaFraction(level)).toBe(0.4);
    level.sand = [];
    expect(sandAreaFraction(level)).toBe(0);
  });
});
