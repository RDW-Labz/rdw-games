import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLevel, sandAreaFraction } from "../src/sim/level.js";
import { parseIntended, solveLevel } from "../src/sim/solver.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const levelsDir = join(root, "levels");

// Omitted means all holes; an invalid filter must never silently skip checks.
const worldArg = process.argv.indexOf("--world");
const world = worldArg < 0 ? undefined : Number(process.argv[worldArg + 1]);
if (world !== undefined && ![1, 2, 3].includes(world)) throw new Error("--world requires 1, 2 or 3");
const fileWorld = (file: string) => Math.ceil(Number(file.match(/^hole(\d+)\.json$/)?.[1] ?? 1) / 12);

const files = readdirSync(levelsDir)
  .filter((f) => f.endsWith(".json") && (world === undefined || fileWorld(f) === world))
  .sort();

let failed = false;
const sandHoles = new Map<number, number>();
const started = performance.now();

console.log("id       | par | best | cush | feasible | worst% | explored | ms");
console.log("---------|-----|------|------|----------|--------|----------|-----");

for (const file of files) {
  const path = join(levelsDir, file);
  const t0 = performance.now();
  try {
    const json = JSON.parse(readFileSync(path, "utf8"));
    const level = parseLevel(json, file);
    const intended = parseIntended(json, file);
    if (level.sand.length) sandHoles.set(fileWorld(file), (sandHoles.get(fileWorld(file)) ?? 0) + 1);
    const sandFraction = sandAreaFraction(level);
    if (sandFraction > 0.2) {
      failed = true;
      console.error(`  fail: ${level.id} sand covers ${(sandFraction * 100).toFixed(1)}%, maximum 20%`);
    }
    if (intended && intended.maxCushions > 2) {
      failed = true;
      console.error(`  fail: ${level.id} intended route exceeds two cushions per stroke`);
    }
    const maxStrokes = level.par + 2;
    const result = solveLevel(level, { maxStrokes });
    const route = intended ? solveLevel(level, {
      maxStrokes: intended.strokes, maxCushions: intended.maxCushions, checkFeasibility: false,
    }) : undefined;
    if (route && !route.solvable) {
      failed = true;
      console.error(`  fail: ${level.id} intended route needs <=${intended!.strokes} strokes, <=${intended!.maxCushions} cushions per stroke`);
    }
    const ms = Math.round(performance.now() - t0);

    if (!result.solvable || result.strokes > maxStrokes) {
      failed = true;
      console.log(
        `${level.id.padEnd(8)} | ${level.par}   | FAIL | -    | false    | -      | ${String(result.explored).padEnd(8)} | ${ms}`
      );
      continue;
    }

    const feasibleStr = String(result.feasible);
    const worst = (result.worstPassRate * 100).toFixed(1);
    console.log(
      `${level.id.padEnd(8)} | ${level.par}   | ${String(result.strokes).padEnd(4)} | ${String(result.cushions).padEnd(4)} | ${feasibleStr.padEnd(8)} | ${worst.padEnd(6)} | ${String(result.explored).padEnd(8)} | ${ms}`
    );

    if (level.par >= 3 && result.strokes === 1) {
      failed = true;
      console.error(`  fail: ${level.id} accidental hole-in-one on par ${level.par}`);
    }
    if (result.strokes < level.par - 1 || result.strokes > level.par) {
      failed = true;
      console.warn(`  fail: ${level.id} best ${result.strokes} must equal par or par-1`);
    }
    if (!result.feasible || result.worstPassRate < 0.6) {
      failed = true;
      console.warn(`  fail: ${level.id} solution is not human-feasible (worst shot ${worst}%)`);
    }
  } catch (e) {
    failed = true;
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`${file.padEnd(8)} | ERR | ${msg}`);
  }
}

for (const [courseWorld, count] of sandHoles) {
  if (count > 4) {
    failed = true;
    console.error(`fail: world ${courseWorld}: ${count} holes use sand, maximum 4`);
  }
}
const elapsed = performance.now() - started;
console.log(`Total: ${(elapsed / 1000).toFixed(2)} s`);
// 36 holes take ~6-7 min on a laptop; 60s was only meaningful for the 12-hole
// catalog. Keep a guard against runaway solvers, but do not fail on hardware speed.
if (elapsed >= 900_000) {
  failed = true;
  console.error("fail: level checks exceeded 900 seconds");
}

if (failed) {
  process.exit(1);
}
