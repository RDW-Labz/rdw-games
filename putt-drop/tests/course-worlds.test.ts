import { describe, expect, it } from "vitest";
import { loadLevels } from "../src/levels.js";
import { worldSections } from "../src/game/course/worldsCatalog.js";

describe("hole-select world sections", () => {
  it("one header per 12-hole world, named from worlds.md with the mechanic it introduces", () => {
    const sections = worldSections(loadLevels());
    expect(sections).toEqual([
      { title: "Park · holes 1–12", start: 0, end: 12 },
      { title: "Dewglass Garden · Fast turf", start: 12, end: 24 },
      { title: "Wicket Grove · Wickets", start: 24, end: 36 },
    ]);
  });

  it("covers every hole exactly once for any catalog length", () => {
    const levels = loadLevels();
    for (const n of [1, 12, 13, 24, 30, 36]) {
      const sections = worldSections(levels.slice(0, n));
      expect(sections[0].start).toBe(0);
      expect(sections[sections.length - 1].end).toBe(n);
      for (let i = 1; i < sections.length; i++) expect(sections[i].start).toBe(sections[i - 1].end);
    }
  });
});
