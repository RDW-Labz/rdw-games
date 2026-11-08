import { describe, expect, it, beforeEach } from "vitest";
import { reducedMotion, setReducedMotionPreference } from "../src/ui/motionPolicy.js";

describe("reducedMotion", () => {
  beforeEach(() => {
    setReducedMotionPreference(false);
  });

  it("defaults to false when OS does not prefer reduce", () => {
    expect(reducedMotion()).toBe(false);
  });

  it("honors saved preference when OS does not override", () => {
    setReducedMotionPreference(true);
    expect(reducedMotion()).toBe(true);
  });
});
