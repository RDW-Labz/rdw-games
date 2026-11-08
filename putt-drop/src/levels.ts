import { parseLevel } from "./sim/level.js";
import type { Level } from "./sim/types.js";

const modules = import.meta.glob("../levels/*.json", {
  eager: true,
  import: "default",
}) as Record<string, unknown>;

export function loadLevels(): Level[] {
  const levels: Level[] = [];
  for (const [path, data] of Object.entries(modules)) {
    const fileHint = path.split("/").pop() ?? path;
    levels.push(parseLevel(data, fileHint));
  }
  levels.sort((a, b) => a.id.localeCompare(b.id));
  return levels;
}
