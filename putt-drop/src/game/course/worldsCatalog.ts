import type { Level } from "../../sim/types.js";
import { FREE_HOLE_COUNT, paidHoleCount } from "../../progress.js";

/** Holes per world (docs/design/worlds.md: Park 1-12, Dewglass Garden 13-24, Wicket Grove 25-36). */
export const WORLD_SIZE = FREE_HOLE_COUNT;

export interface WorldSection {
  title: string;
  /** Zero-based first hole index (inclusive). */
  start: number;
  /** Zero-based last hole index (exclusive). */
  end: number;
}

const WORLD_NAMES = ["Park", "Dewglass Garden", "Wicket Grove"];

function hasFastTurf(level: Level): boolean {
  return (level.fastTurf?.length ?? 0) > 0;
}

function hasWickets(level: Level): boolean {
  return (level.oneWayGates?.length ?? 0) > 0;
}

/** The mechanic a world introduces, read from its first hole that has one. */
function worldMechanic(levels: Level[]): string | null {
  for (const l of levels) {
    if (hasWickets(l)) return "Wickets";
    if (hasFastTurf(l)) return "Fast turf";
  }
  return null;
}

/** Hole-select section headers, one per 12-hole world present in the level list. */
export function worldSections(levels: Level[]): WorldSection[] {
  const out: WorldSection[] = [];
  for (let start = 0, w = 0; start < levels.length; start += WORLD_SIZE, w++) {
    const end = Math.min(start + WORLD_SIZE, levels.length);
    const range = `holes ${start + 1}–${end}`;
    const name = WORLD_NAMES[w] ?? `World ${w + 1}`;
    const mechanic = w === 0 ? null : worldMechanic(levels.slice(start, end));
    out.push({ title: mechanic ? `${name} · ${mechanic}` : `${name} · ${range}`, start, end });
  }
  return out;
}

/**
 * Exact "what you get" line for the full-game offer, derived from the shipped level list:
 * paid hole count, number of new worlds, and the mechanics those holes actually contain.
 */
export function paidOfferLine(levels: Level[]): string {
  const paid = paidHoleCount(levels.length);
  if (paid === 0) return `The ${FREE_HOLE_COUNT} free holes are ready to play.`;
  const paidLevels = levels.slice(FREE_HOLE_COUNT);
  const worlds = Math.ceil(paid / WORLD_SIZE);
  const mechanics: string[] = [];
  if (paidLevels.some(hasFastTurf)) mechanics.push("fast turf");
  if (paidLevels.some(hasWickets)) mechanics.push("one-way wickets");
  const where = worlds === 1 ? "1 new world" : `${worlds} new worlds`;
  const holes = paid === 1 ? "1 more hole" : `${paid} more holes`;
  return mechanics.length ? `${holes} in ${where}: ${mechanics.join(" and ")}` : `${holes} in ${where}`;
}
