import { describe, expect, it } from "vitest";
import {
  acquireSceneTexture,
  markGlobalTexture,
  releaseSceneTextures,
  releaseTexture,
} from "../src/game/textureCache.js";

describe("textureCache", () => {
  it("tracks scene-owned keys and skips global on release", () => {
    const removed: string[] = [];
    const scene = {
      scene: { key: "Play" },
      textures: {
        exists: (k: string) => k === "level-1" || k === "particle-dot",
        remove: (k: string) => {
          removed.push(k);
        },
      },
    } as unknown as import("phaser").Scene;

    markGlobalTexture("particle-dot");
    acquireSceneTexture(scene, "level-1");
    releaseTexture(scene, "particle-dot");
    expect(removed).not.toContain("particle-dot");

    releaseSceneTextures(scene);
    expect(removed).toContain("level-1");
  });
});
