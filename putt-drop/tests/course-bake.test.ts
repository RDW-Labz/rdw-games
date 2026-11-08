import { describe, expect, it } from "vitest";
import { loadLevels } from "../src/levels.js";
import { seeded } from "../src/game/course/canvas.js";

describe("course bake helpers", () => {
  it("seeded rng is deterministic per level id", () => {
    const a = seeded("hole05");
    const b = seeded("hole05");
    const c = seeded("hole09");
    expect(a()).toBe(b());
    expect(a()).toBe(b());
    expect(a()).not.toBe(c());
  });

  it("every bundled level has tee and cup inside bounds", () => {
    const levels = loadLevels();
    for (const level of levels) {
      expect(level.tee[0]).toBeGreaterThan(0);
      expect(level.cup[1]).toBeGreaterThan(0);
      expect(level.walls.length).toBeGreaterThan(0);
    }
  });
});
