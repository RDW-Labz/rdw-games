import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs helper without types
import { _parseEtime, isPreviewServer } from "../scripts/lib/harness.mjs";

describe("script harness orphan rules", () => {
  it("parses BSD ps etime formats", () => {
    expect(_parseEtime("05:07")).toBe(307);
    expect(_parseEtime("02:00:16")).toBe(7216);
    expect(_parseEtime("10-01:19:57")).toBe(10 * 86400 + 3600 + 19 * 60 + 57);
  });

  it("matches only real preview server processes", () => {
    // Real command lines seen in `ps` on the build Mac.
    expect(isPreviewServer("npm exec vite preview --outDir build/test --port 60230 --strictPort")).toBe(true);
    expect(
      isPreviewServer("node /Users/prime/x/node_modules/.bin/vite preview --outDir build/test --port 60354 --strictPort"),
    ).toBe(true);
    expect(isPreviewServer("node /Users/prime/x/node_modules/vite/bin/vite.js preview --port 51266")).toBe(true);
    // Must never match shells, editors or test scripts that merely mention it.
    expect(isPreviewServer('/bin/zsh -c cd x && (npx vite preview --port 5398 > /dev/null &)')).toBe(false);
    expect(isPreviewServer("node scripts/smoke.mjs")).toBe(false);
    expect(isPreviewServer("vim scripts/lib/harness.mjs # vite preview")).toBe(false);
    expect(isPreviewServer("node /x/node_modules/.bin/vite build --mode test")).toBe(false);
  });
});
