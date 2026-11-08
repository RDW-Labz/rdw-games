import { describe, expect, it } from "vitest";
import {
  createDefaultSave,
  isHoleAvailable,
  nextHole,
  onHoleComplete,
  previewDurationSeconds,
  personalBestOutcome,
  rating,
  shouldOfferAssist,
  shouldShowFirstPuttHint,
  markFirstPuttTutorialSeen,
  strokesLabel,
  strokesParCaption,
} from "../src/progress.js";

describe("isHoleAvailable", () => {
  it("allows free holes when locked", () => {
    expect(isHoleAvailable(0, false)).toBe(true);
    expect(isHoleAvailable(11, false)).toBe(true);
    expect(isHoleAvailable(12, false)).toBe(false);
  });

  it("allows all holes when unlocked", () => {
    expect(isHoleAvailable(12, true)).toBe(true);
    expect(isHoleAvailable(99, true)).toBe(true);
  });
});

describe("rating", () => {
  it("maps strokes to stars", () => {
    expect(rating(undefined, 3)).toBe(0);
    expect(rating(2, 3)).toBe(3);
    expect(rating(3, 3)).toBe(2);
    expect(rating(5, 3)).toBe(1);
  });
});

describe("nextHole", () => {
  it("picks first hole without a best score", () => {
    const save = createDefaultSave(5);
    save.holes[0].best = 3;
    save.holes[1].best = 4;
    expect(nextHole(save, 5)).toBe(2);
  });

  it("falls back to lastHole when all have scores", () => {
    const save = createDefaultSave(3);
    save.holes.forEach((h) => {
      h.best = 3;
    });
    save.lastHole = 2;
    expect(nextHole(save, 3)).toBe(2);
  });
});

describe("default settings", () => {
  it("includes accessibility fields", () => {
    const save = createDefaultSave(3);
    expect(save.settings.reducedMotion).toBe(false);
    expect(save.settings.colorblindAim).toBe(false);
  });
});

describe("first putt tutorial", () => {
  it("defaults to unseen", () => {
    const save = createDefaultSave(3);
    expect(shouldShowFirstPuttHint(save)).toBe(true);
    expect(markFirstPuttTutorialSeen(save).firstPuttTutorialSeen).toBe(true);
  });
});

describe("personal best", () => {
  it("detects improvement", () => {
    expect(personalBestOutcome(4, 3).improved).toBe(true);
    expect(personalBestOutcome(3, 3).improved).toBe(false);
  });

  it("uses the screens.md badge copy and only accents a strict improvement over a recorded best", () => {
    expect(personalBestOutcome(undefined, 4)).toMatchObject({ badge: "First finish", beatRecord: false });
    expect(personalBestOutcome(5, 4)).toMatchObject({ badge: "Personal best · 4", beatRecord: true });
    expect(personalBestOutcome(4, 4)).toMatchObject({ badge: "Best 4", beatRecord: false });
    expect(personalBestOutcome(3, 6)).toMatchObject({ badge: "Best 3", beatRecord: false });
  });
});

describe("stroke count copy", () => {
  it("is singular only for one", () => {
    expect(strokesLabel(0)).toBe("0 strokes");
    expect(strokesLabel(1)).toBe("1 stroke");
    expect(strokesLabel(2)).toBe("2 strokes");
    expect(strokesLabel(11)).toBe("11 strokes");
    expect(strokesParCaption(1, 2)).toBe("stroke · par 2");
    expect(strokesParCaption(3, 2)).toBe("strokes · par 2");
  });
});

describe("first putt hint eligibility", () => {
  it("is not shown to a returning player who already finished a hole", () => {
    const save = createDefaultSave(3);
    save.holes[0] = { ...save.holes[0], best: 3 };
    expect(shouldShowFirstPuttHint(save)).toBe(false);
  });
});

describe("assist", () => {
  it("extends preview when assist is on", () => {
    expect(previewDurationSeconds(false)).toBe(0.6);
    expect(previewDurationSeconds(true)).toBe(1.6);
  });

  it("offers assist after two bad finishes", () => {
    const save = createDefaultSave(1);
    let s = onHoleComplete(save, 0, 6, 3);
    expect(shouldOfferAssist(s.holes[0], 1)).toBe(false);
    s = onHoleComplete(s, 0, 7, 3);
    expect(shouldOfferAssist(s.holes[0], 1)).toBe(true);
  });

  it("offers assist at 8+ strokes in attempt", () => {
    const save = createDefaultSave(1);
    expect(shouldOfferAssist(save.holes[0], 8)).toBe(true);
  });

  it("clears assist after par or better finish", () => {
    let save = createDefaultSave(1);
    save = onHoleComplete(save, 0, 8, 3);
    save.holes[0].assistEnabled = true;
    save = onHoleComplete(save, 0, 3, 3);
    expect(save.holes[0].assistEnabled).toBe(false);
    expect(save.holes[0].consecutiveBadFinishes).toBe(0);
  });
});
