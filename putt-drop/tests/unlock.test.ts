import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

describe("UnlockScene billing honesty", () => {
  it("uses uiState instead of fixture for test overrides", () => {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/game/UnlockScene.ts");
    const src = readFileSync(file, "utf8");
    expect(src).toContain("uiState:");
    expect(src).not.toMatch(/private fixture/);
  });
});
