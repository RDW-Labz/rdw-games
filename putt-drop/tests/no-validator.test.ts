import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const srcRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src");

function allSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, name.name);
    if (name.isDirectory()) out.push(...allSourceFiles(full));
    else if (name.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

const forbidden = [/\.validator\s*=(?!=)/, /\[\s*["']validator["']\s*\]\s*=(?!=)/, /\bIaptic\b/i, /iaptic\.com/i];

describe("no receipt validator in app source", () => {
  it("the patterns catch the forbidden forms", () => {
    for (const bad of [
      'store.validator = "https://validator.iaptic.com/v1/validate";',
      "store['validator'] = fn;",
      "const iaptic = new CdvPurchase.Iaptic({});",
    ]) {
      expect(forbidden.some((p) => p.test(bad)), bad).toBe(true);
    }
  });

  it("never assigns store.validator or references Iaptic / iaptic.com", () => {
    const files = allSourceFiles(srcRoot);
    expect(files.some((f) => f.endsWith(path.join("platform", "billing.ts")))).toBe(true);
    for (const file of allSourceFiles(srcRoot)) {
      const text = readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        expect(text, file).not.toMatch(pattern);
      }
    }
  });
});
