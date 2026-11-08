import { describe, expect, it } from "vitest";
import { loadLevels } from "../src/levels.js";
import { courseOutline } from "../src/ui/geometry.js";
import { personalBestOutcome, shouldShowFirstPuttHint, markFirstPuttTutorialSeen, createDefaultSave } from "../src/progress.js";

describe("course outline", () => {
  it("has a closed boundary for bundled hole 1", () => {
    const levels = loadLevels();
    const outline = courseOutline(levels[0]);
    expect(outline).toBeDefined();
    expect(outline!.length).toBeGreaterThanOrEqual(3);
  });
});

describe("first putt hint save flag", () => {
  it("shows hint until first putt marked", () => {
    const save = createDefaultSave(3);
    expect(shouldShowFirstPuttHint(save)).toBe(true);
    const next = markFirstPuttTutorialSeen(save);
    expect(shouldShowFirstPuttHint(next)).toBe(false);
  });
});

describe("personalBestOutcome", () => {
  it("labels first finish and strict improvement", () => {
    expect(personalBestOutcome(undefined, 4).badge).toBe("First finish");
    expect(personalBestOutcome(5, 4).improved).toBe(true);
    expect(personalBestOutcome(4, 5).improved).toBe(false);
  });
});

import { bakeRect, courseFrame, uiToWorld, worldToUi } from "../src/game/course/frame.js";
import { TOKENS } from "../src/ui/tokens.js";

describe("course frame (screens.md section 6 transform)", () => {
  // Fixture rows from screens.md: (T, B, H) -> viewport top/height, q, ox/oy.
  const fixtures = [
    { name: "baseline", T: 24, B: 24, H: 640, top: 96, height: 444, q: 0.666667, ox: 60, oy: 104.667 },
    { name: "short", T: 23, B: 0, H: 639, top: 95, height: 468, q: 0.666667, ox: 60, oy: 115.667 },
    { name: "tall", T: 50, B: 29, H: 780.279, top: 122, height: 553.279, q: 0.666667, ox: 60, oy: 185.306 },
  ];
  for (const f of fixtures) {
    it(`matches the ${f.name} fixture`, () => {
      const fr = courseFrame(f.T, f.B, f.H);
      expect(fr.top).toBeCloseTo(f.top, 3);
      expect(fr.height).toBeCloseTo(f.height, 3);
      expect(fr.q).toBeCloseTo(f.q, 5);
      expect(fr.ox).toBeCloseTo(f.ox, 2);
      expect(fr.oy).toBeCloseTo(f.oy, 3);
    });
  }

  it("is uniform and invertible", () => {
    const fr = courseFrame();
    for (const [x, y] of [[0, 0], [360, 640], [174, 555], [12.5, 301.25]] as const) {
      const [ux, uy] = worldToUi(fr, x, y);
      const [wx, wy] = uiToWorld(fr, ux, uy);
      expect(wx).toBeCloseTo(x, 9);
      expect(wy).toBeCloseTo(y, 9);
    }
    const a = worldToUi(fr, 0, 0);
    const b = worldToUi(fr, 100, 100);
    expect(b[0] - a[0]).toBeCloseTo(b[1] - a[1], 9);
  });

  it("uses a taller course viewport than the legacy 64px power card layout", () => {
    const fr = courseFrame(24, 24, 640);
    expect(fr.height).toBeGreaterThan(428);
  });

  it("centers bundled hole 1 in the play viewport", () => {
    const levels = loadLevels();
    const fr = courseFrame(24, 24, 640, levels[0]);
    const [tx, ty] = worldToUi(fr, levels[0].tee[0], levels[0].tee[1]);
    const [cx, cy] = worldToUi(fr, levels[0].cup[0], levels[0].cup[1]);
    const midX = (tx + cx) / 2;
    const midY = (ty + cy) / 2;
    const vcx = fr.left + fr.width / 2;
    const vcy = fr.top + fr.height / 2;
    expect(Math.abs(midX - vcx)).toBeLessThanOrEqual(3);
    expect(Math.abs(midY - vcy)).toBeLessThanOrEqual(4);
  });

  it("fits every bundled hole between the HUD and the power card", () => {
    const hudBottom = TOKENS.layout.safeTop + 64;
    for (const level of loadLevels()) {
      const fr = courseFrame(24, 24, 640, level);
      const powerTop = fr.powerPanelTop;
      const pts = [
        ...level.walls.flatMap((w) => w.points),
        ...level.water.flatMap((z) => z.poly),
        ...level.sand.flatMap((z) => z.poly),
        level.tee,
        level.cup,
      ];
      for (const [x, y] of pts) {
        const [ux, uy] = worldToUi(fr, x, y);
        expect(uy, `${level.id} y`).toBeGreaterThanOrEqual(hudBottom);
        expect(uy, `${level.id} y`).toBeLessThanOrEqual(powerTop);
        expect(ux).toBeGreaterThanOrEqual(fr.left);
        expect(ux).toBeLessThanOrEqual(fr.left + fr.width);
      }
    }
  });

  it("bakes on whole device pixels covering the world at every render scale, at most textureDprMax texels per UI px", () => {
    const fr = courseFrame();
    for (const r of [1, 2, 2.625, 3]) {
      const rect = bakeRect(fr, r);
      expect(Number.isInteger(rect.x) && Number.isInteger(rect.y) && Number.isInteger(rect.w) && Number.isInteger(rect.h)).toBe(true);
      expect(rect.x).toBeLessThanOrEqual(fr.ox * r);
      expect(rect.y).toBeLessThanOrEqual(fr.oy * r);
      expect(rect.x + rect.w).toBeGreaterThanOrEqual((fr.ox + 360 * fr.q) * r);
      expect(rect.y + rect.h).toBeGreaterThanOrEqual((fr.oy + 640 * fr.q) * r);
      // One texel per device pixel: the image is never rescaled after baking.
      expect(rect.s).toBeCloseTo(fr.q * r, 12);
      expect(rect.s).toBeLessThanOrEqual(TOKENS.budget.textureDprMax);
    }
  });
});
