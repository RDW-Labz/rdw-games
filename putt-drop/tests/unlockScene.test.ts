import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

describe("UnlockScene honesty copy", () => {
  it("uses uiState instead of fixture for internal store UI state", () => {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/game/UnlockScene.ts");
    const src = readFileSync(file, "utf8");
    expect(src).toContain("private uiState:");
    expect(src).not.toMatch(/private fixture:/);
    expect(src).toContain("Not on sale yet");
    expect(src).toContain("Keep playing free holes");
  });
});
