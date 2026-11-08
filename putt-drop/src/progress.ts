import { purchaseUnlock } from "./platform/billing.js";

export const FREE_HOLE_COUNT = 12;

/** Holes beyond the free ones in the shipped catalog (levels.json). 0 today: holes 1-12 only. */
export function paidHoleCount(totalHoles: number): number {
  return Math.max(0, totalHoles - FREE_HOLE_COUNT);
}

/**
 * The single gate for selling "Unlock full game": only when the catalog really contains paid
 * holes (13+). With no paid holes there is nothing to sell, so the offer stays "Not on sale yet".
 * Adding hole 13 to the level list turns the real store offer on automatically (docs/billing.md).
 */
export function fullGameOnSale(totalHoles: number): boolean {
  return paidHoleCount(totalHoles) > 0;
}

export interface GameSettings {
  sound: boolean;
  music: boolean;
  vibration: boolean;
  shake: boolean;
  reducedMotion: boolean;
  colorblindAim: boolean;
}

export interface HoleProgress {
  best?: number;
  attempts: number;
  fails: number;
  consecutiveBadFinishes: number;
  assistEnabled: boolean;
}

export interface SaveData {
  settings: GameSettings;
  unlocked: boolean;
  lastHole: number;
  holes: HoleProgress[];
  /** Persisted after the player's first valid putt (tutorial hint). */
  firstPuttTutorialSeen?: boolean;
}

export function createDefaultSave(holeCount: number): SaveData {
  const holes: HoleProgress[] = [];
  for (let i = 0; i < holeCount; i++) {
    holes.push({
      attempts: 0,
      fails: 0,
      consecutiveBadFinishes: 0,
      assistEnabled: false,
    });
  }
  return {
    settings: {
      sound: true,
      music: true,
      vibration: true,
      shake: true,
      reducedMotion: false,
      colorblindAim: false,
    },
    unlocked: false,
    lastHole: 0,
    holes,
  };
}

export function isHoleAvailable(index: number, unlocked: boolean): boolean {
  return index < FREE_HOLE_COUNT || unlocked;
}

/** 3 = under par, 2 = par, 1 = finished over par, 0 = not finished. */
export function rating(best: number | undefined, par: number): number {
  if (best === undefined) return 0;
  if (best < par) return 3;
  if (best === par) return 2;
  return 1;
}

/** First hole without a best score, else lowest index never beaten, else lastHole. */
export function nextHole(save: SaveData, holeCount: number): number {
  if (holeCount <= 0) return 0;
  for (let i = 0; i < holeCount; i++) {
    if (save.holes[i]?.best === undefined && isHoleAvailable(i, save.unlocked)) {
      return i;
    }
  }
  const last = Math.min(save.lastHole, holeCount - 1);
  if (isHoleAvailable(last, save.unlocked)) return last;
  for (let i = 0; i < holeCount; i++) {
    if (isHoleAvailable(i, save.unlocked)) return i;
  }
  return 0;
}

export function ensureHoleSlots(save: SaveData, holeCount: number): SaveData {
  if (save.holes.length >= holeCount) return save;
  const next = { ...save, holes: [...save.holes] };
  while (next.holes.length < holeCount) {
    next.holes.push({
      attempts: 0,
      fails: 0,
      consecutiveBadFinishes: 0,
      assistEnabled: false,
    });
  }
  return next;
}

export function isBadFinish(strokes: number, par: number): boolean {
  return strokes >= par + 3;
}

export function shouldOfferAssist(hole: HoleProgress, currentStrokes: number): boolean {
  if (hole.assistEnabled) return true;
  if (hole.consecutiveBadFinishes >= 2) return true;
  if (currentStrokes >= 8) return true;
  return false;
}

export function previewDurationSeconds(assist: boolean): number {
  return assist ? 1.6 : 0.6;
}

export function onHoleAttemptStart(save: SaveData, holeIndex: number): SaveData {
  const holes = [...save.holes];
  const h = { ...holes[holeIndex] };
  h.attempts += 1;
  holes[holeIndex] = h;
  return { ...save, holes, lastHole: holeIndex };
}

export function onHoleComplete(
  save: SaveData,
  holeIndex: number,
  strokes: number,
  par: number
): SaveData {
  const holes = [...save.holes];
  const h = { ...holes[holeIndex] };
  if (h.best === undefined || strokes < h.best) {
    h.best = strokes;
  }
  if (strokes > par) {
    h.fails += 1;
  }
  if (isBadFinish(strokes, par)) {
    h.consecutiveBadFinishes += 1;
  } else {
    h.consecutiveBadFinishes = 0;
    if (strokes <= par) {
      h.assistEnabled = false;
    }
  }
  holes[holeIndex] = h;
  return { ...save, holes, lastHole: holeIndex };
}

export function setAssistEnabled(save: SaveData, holeIndex: number, enabled: boolean): SaveData {
  const holes = [...save.holes];
  holes[holeIndex] = { ...holes[holeIndex], assistEnabled: enabled };
  return { ...save, holes };
}

/** Only for a save with no valid first putt and no previously completed hole. */
export function shouldShowFirstPuttHint(save: SaveData): boolean {
  if (save.firstPuttTutorialSeen) return false;
  return !save.holes.some((h) => h.best !== undefined);
}

export function markFirstPuttTutorialSeen(save: SaveData): SaveData {
  if (save.firstPuttTutorialSeen) return save;
  return { ...save, firstPuttTutorialSeen: true };
}

export interface PersonalBestOutcome {
  /** True for a first finish or a strict improvement. */
  improved: boolean;
  /** True only for a strict improvement over a recorded previous best (bestBadge accent). */
  beatRecord: boolean;
  badge: string;
  priorBest?: number;
}

/** Compare this attempt to the saved best before persisting completion. */
export function personalBestOutcome(
  priorBest: number | undefined,
  strokes: number
): PersonalBestOutcome {
  if (priorBest === undefined) {
    return { improved: true, beatRecord: false, badge: "First finish", priorBest: undefined };
  }
  if (strokes < priorBest) {
    return { improved: true, beatRecord: true, badge: `Personal best · ${strokes}`, priorBest };
  }
  return { improved: false, beatRecord: false, badge: `Best ${priorBest}`, priorBest };
}

/** "1 stroke", "2 strokes" (HUD and result copy). */
export function strokesLabel(n: number): string {
  return `${n} ${n === 1 ? "stroke" : "strokes"}`;
}

/** Result-card caption next to the big number: "stroke · par 2" / "strokes · par 2". */
export function strokesParCaption(n: number, par: number): string {
  return `${n === 1 ? "stroke" : "strokes"} · par ${par}`;
}

export function scoreLabel(strokes: number, par: number): string {
  const diff = strokes - par;
  if (strokes === 1) return "Hole in one!";
  if (diff <= -3) return "Albatross";
  if (diff === -2) return "Eagle";
  if (diff === -1) return "Birdie";
  if (diff === 0) return "Par";
  if (diff === 1) return "Bogey";
  return `+${diff}`;
}

/** Starts the Google Play purchase of unlock_full (see platform/billing.ts). */
export async function requestUnlock(): Promise<boolean> {
  return (await purchaseUnlock()) === "success";
}
