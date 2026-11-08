// Fails the production build if any test-only code shipped in build/web.
// Test hooks are compiled in only when import.meta.env.MODE !== "production"
// (`npm run build:test` -> build/test). Keep this marker list in sync with those hooks.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "build", "web");

// Markers that must never appear in the production bundle:
const MARKERS = [
  "__pd", // window.__pd test hook object
  "activeScenes", // __pd.activeScenes()
  "forceResult", // __pd.forceResult / PlayScene.forceResultForTest
  "forceUnlockState", // __pd.forceUnlockState (Unlock fixtures)
  "scrollGallery", // __pd.scrollGallery
  "textureCount", // __pd.textureCount
  "Gallery", // dev-only component gallery scene
  "fallbackScene", // old smoke fallback navigation (must never exist anywhere)
  "preserveDrawingBuffer:!0", // pixel read-back buffer, tests only
  'has("test")', // removed runtime ?test switch
];

if (!fs.existsSync(dir)) {
  console.error(`check-bundle: ${dir} does not exist; run vite build first`);
  process.exit(1);
}

function walk(d) {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

const files = walk(dir).filter((f) => /\.(js|mjs|html|css|map|json)$/.test(f));
const hits = [];
for (const f of files) {
  const text = fs.readFileSync(f, "utf8");
  for (const m of MARKERS) {
    let i = text.indexOf(m);
    while (i !== -1) {
      hits.push({ file: path.relative(root, f), marker: m, context: text.slice(Math.max(0, i - 60), i + m.length + 60) });
      i = text.indexOf(m, i + 1);
    }
  }
}

console.log(`check-bundle: scanned ${files.length} file(s) in build/web for ${MARKERS.length} markers`);
if (hits.length) {
  for (const h of hits) console.error(`  FOUND "${h.marker}" in ${h.file}: …${h.context.replace(/\s+/g, " ")}…`);
  console.error(`check-bundle: FAIL (${hits.length} hit(s))`);
  process.exit(1);
}
console.log("check-bundle: ok (no test-only markers)");
