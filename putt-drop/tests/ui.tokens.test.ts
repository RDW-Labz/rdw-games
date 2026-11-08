import { describe, expect, it } from "vitest";
import { TOKENS, cssColor, DEPTH } from "../src/ui/tokens.js";
import {
  TEXTURE_PAD,
  bakedFaceDisplayOrigin,
  bakedFaceDisplaySize,
} from "../src/ui/textures.js";

describe("ui tokens", () => {
  it("exposes Pocket Park semantic colors", () => {
    expect(TOKENS.color.bgTop).toBe(0xfaf3df);
    expect(TOKENS.color.primaryTop).toBe(0xf58e6c);
    expect(TOKENS.color.onPrimary).toBe(0x43271f);
  });

  it("cssColor returns padded hex", () => {
    expect(cssColor("text")).toBe("#354b3a");
    expect(cssColor("primaryTop")).toBe("#f58e6c");
  });

  it("keeps scene compatibility aliases", () => {
    expect(TOKENS.panelBg).toBe(TOKENS.color.surfaceTop);
    expect(TOKENS.primaryBtnW).toBe(328);
    expect(TOKENS.minTouch).toBe(56);
  });

  it("maps depth hud for overlays", () => {
    expect(DEPTH.hud).toBe(200);
    expect(TOKENS.depth.sheet).toBe(310);
  });

  it("defines motion durations from motion.md", () => {
    expect(TOKENS.motion.duration.instant).toBe(80);
    expect(TOKENS.motion.duration.quick).toBe(160);
    expect(TOKENS.motion.duration.stagger).toBe(24);
  });

  it("centers baked face origin on the control rect within 2px", () => {
    const faces = [
      { w: TOKENS.component.icon.size, h: TOKENS.component.icon.size },
      { w: TOKENS.component.pill.primary.w, h: TOKENS.component.pill.primary.h },
      { w: 328, h: TOKENS.component.topBar.h },
    ];
    for (const { w, h } of faces) {
      const { w: tw, h: th } = bakedFaceDisplaySize(w, h);
      const o = bakedFaceDisplayOrigin(w, h);
      const faceCenterX = o.x * tw;
      const faceCenterY = o.y * th;
      expect(Math.abs(faceCenterX - (TEXTURE_PAD + w / 2))).toBeLessThanOrEqual(2);
      expect(Math.abs(faceCenterY - (TEXTURE_PAD + h / 2))).toBeLessThanOrEqual(2);
      expect(Math.abs(faceCenterX - tw / 2)).toBeLessThanOrEqual(2);
      expect(Math.abs(faceCenterY - th / 2)).toBeLessThanOrEqual(2);
    }
  });
});

describe("ui component geometry", () => {
  it("star rows match the spec widths (small 66, result 108)", async () => {
    const { starRowWidth } = await import("../src/ui/geometry.js");
    expect(starRowWidth("small")).toBe(66);
    expect(starRowWidth("result")).toBe(108);
  });

  it("hole card mini art uses the largest closed wall as the turf outline", async () => {
    const { courseOutline } = await import("../src/ui/geometry.js");
    const outer: [number, number][] = [[0, 0], [100, 0], [100, 200], [0, 200]];
    const inner: [number, number][] = [[40, 40], [60, 40], [60, 60], [40, 60]];
    const level = {
      id: "t", name: "t", par: 2, tee: [50, 180], cup: [50, 20],
      walls: [{ points: inner, closed: true }, { points: outer, closed: true }, { points: [[0, 0], [5, 5]], closed: false }],
      bumpers: [], sand: [], water: [], slopes: [], movers: [],
    } as unknown as import("../src/sim/types.js").Level;
    expect(courseOutline(level)).toBe(outer);
  });
});
