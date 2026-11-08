import { chromium, webkit, devices } from "playwright";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getControl, tapControlCenter } from "./smoke-controls.mjs";
import { spawnPreview, launchBrowser } from "./lib/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const MISSING_STATES = ["offline/error states"];

const CAPTURES = [
  { nn: "01", slug: "boot-loading", label: "Boot / loading" },
  { nn: "02", slug: "menu-first-run", label: "Menu first-run" },
  { nn: "03", slug: "menu-with-progress", label: "Menu with progress" },
  { nn: "04", slug: "holes-first-run", label: "Holes first-run" },
  { nn: "05", slug: "holes-mid-progress", label: "Holes mid-progress (stars)" },
  { nn: "06", slug: "holes-scrolled-bottom", label: "Holes scrolled to bottom" },
  { nn: "07", slug: "settings", label: "Settings" },
  { nn: "08", slug: "settings-reset-confirm", label: "Settings reset confirm" },
  { nn: "09", slug: "play-hole-1-idle", label: "Play hole 1 idle" },
  { nn: "10", slug: "play-aiming", label: "Play aiming (~70% power)" },
  { nn: "11", slug: "play-ball-rolling", label: "Play ball rolling" },
  { nn: "12", slug: "pause-sheet", label: "Pause sheet" },
  { nn: "13", slug: "result-card-par", label: "Result card (par)" },
  { nn: "14", slug: "result-card-last-free-hole", label: "Result after last free hole" },
  { nn: "15", slug: "play-hole-9", label: "Play hole 9" },
  { nn: "16", slug: "unlock-default", label: "Unlock default" },
  { nn: "17", slug: "unlock-success", label: "Unlock success" },
  { nn: "18", slug: "unlock-failed", label: "Unlock failed toast" },
  { nn: "19", slug: "settings-reduced-motion", label: "Settings reduced motion on" },
  { nn: "20", slug: "settings-colorblind", label: "Settings colorblind aim on" },
  { nn: "21", slug: "first-time-hint", label: "First-time hint" },
  { nn: "22", slug: "holes-world-2-locked", label: "Holes scrolled to World 2 (locked)" },
  { nn: "23", slug: "holes-world-3-locked", label: "Holes scrolled to World 3 (locked)" },
  { nn: "24", slug: "unlock-paid-copy", label: "Unlock with paid-world copy" },
];

const DEVICE_PROFILES = [
  { slug: "iphone-15", engine: "webkit", device: "iPhone 15" },
  { slug: "iphone-se", engine: "webkit", device: "iPhone SE" },
  { slug: "pixel-7", engine: "chromium", device: "Pixel 7" },
];

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

async function waitForHttp(url, ms = 30_000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function gamePoint(page, gx, gy) {
  const box = await page.locator("#game canvas").boundingBox();
  if (!box) throw new Error("Canvas not found");
  const scale = Math.min(box.width / 360, box.height / 640);
  const ox = box.x + (box.width - 360 * scale) / 2;
  const oy = box.y + (box.height - 640 * scale) / 2;
  return { x: ox + gx * scale, y: oy + gy * scale };
}

async function tapGame(page, gx, gy) {
  const p = await gamePoint(page, gx, gy);
  await page.touchscreen.tap(p.x, p.y);
}

async function dragGame(page, x1, y1, x2, y2, { hold = false } = {}) {
  const a = await gamePoint(page, x1, y1);
  const b = await gamePoint(page, x2, y2);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 12 });
  if (!hold) await page.mouse.up();
}

async function expectScene(page, name, withinMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < withinMs) {
    const scenes = await page.evaluate(() => window.__pd?.activeScenes?.() ?? []);
    if (scenes.includes(name)) return;
    await page.waitForTimeout(25);
  }
  const scenes = await page.evaluate(() => window.__pd?.activeScenes?.() ?? []);
  throw new Error(`Expected scene "${name}"; got [${scenes.join(", ")}]`);
}

async function waitMenuReady(page) {
  await expectScene(page, "Menu", 8000);
  await page.waitForFunction(() => window.__pd?.fontsReady?.() ?? false, { timeout: 8000 });
  await page.waitForTimeout(300);
}

function midProgressPartial() {
  const holes = [];
  const bests = [1, 3, 4, 2, 3, 5];
  for (let i = 0; i < 36; i++) {
    const base = {
      attempts: 0,
      fails: 0,
      consecutiveBadFinishes: 0,
      assistEnabled: false,
    };
    if (i < 6) {
      holes.push({ ...base, attempts: 2, best: bests[i] });
    } else {
      holes.push(base);
    }
  }
  return { holes, lastHole: 5 };
}

function allFreeDonePartial() {
  const pars = [2, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4];
  const holes = [];
  for (let i = 0; i < 36; i++) {
    if (i < 12) {
      holes.push({
        attempts: 1,
        fails: 0,
        consecutiveBadFinishes: 0,
        assistEnabled: false,
        best: pars[i],
      });
    } else {
      holes.push({
        attempts: 0,
        fails: 0,
        consecutiveBadFinishes: 0,
        assistEnabled: false,
      });
    }
  }
  return { holes, lastHole: 11, unlocked: false };
}

/** Hole-grid viewport top in logical px (top bar + 12). */
const HOLES_VIEW_TOP = 100;

async function controlRect(page, id) {
  return page.evaluate((cid) => (window.__pd?.controls?.() ?? []).find((c) => c.id === cid) ?? null, id);
}

/** Real finger drags on the grid until card `controlId` sits near the top of the viewport. */
async function scrollUntilControl(page, controlId) {
  for (let i = 0; i < 40; i++) {
    const c = await controlRect(page, controlId);
    if (!c) throw new Error(`capture: ${controlId} not registered`);
    const dy = c.y - (HOLES_VIEW_TOP + 36);
    if (Math.abs(dy) < 12) return;
    const step = Math.max(-220, Math.min(220, dy));
    const from = step > 0 ? 440 : 140;
    await dragGame(page, 180, from, 180, from - step);
    await page.waitForTimeout(80);
  }
  throw new Error(`capture: could not scroll ${controlId} into view`);
}

/** Real drags up until the grid stops moving (bottom: the full-game information card). */
async function scrollHolesToBottom(page) {
  let last = null;
  for (let i = 0; i < 40; i++) {
    const c = await controlRect(page, "holes.card.1");
    if (c && last !== null && Math.abs(c.y - last) < 1) return;
    last = c ? c.y : null;
    await dragGame(page, 180, 440, 180, 140);
    await page.waitForTimeout(80);
  }
  throw new Error("capture: hole grid did not reach the bottom");
}

async function captureDevice(outDir, baseUrl, profile) {
  const launch = profile.engine === "webkit" ? webkit : chromium;
  const browser = await launchBrowser(launch, { headless: true });
  const context = await browser.newContext({
    ...devices[profile.device],
    hasTouch: true,
  });
  const page = await context.newPage();
  const shots = [];

  const shot = async (nn, slug, label) => {
    const file = `${profile.slug}-${nn}-${slug}.png`;
    await page.screenshot({ path: path.join(outDir, file) });
    shots.push({ file, label });
  };

  await page.goto(baseUrl, { waitUntil: "commit" });
  await shot("01", "boot-loading", CAPTURES[0].label);
  await waitMenuReady(page);

  await page.evaluate(() => window.__pd?.resetSave?.());
  await page.evaluate(() => window.__pd?.goto?.("Menu"));
  await waitMenuReady(page);
  await shot("02", "menu-first-run", CAPTURES[1].label);

  await page.evaluate((partial) => window.__pd?.setSave?.(partial), midProgressPartial());
  await page.evaluate(() => window.__pd?.goto?.("Menu"));
  await waitMenuReady(page);
  await shot("03", "menu-with-progress", CAPTURES[2].label);

  await page.evaluate(() => window.__pd?.resetSave?.());
  await page.evaluate(() => window.__pd?.goto?.("LevelSelect"));
  await expectScene(page, "LevelSelect");
  await page.waitForTimeout(500);
  await shot("04", "holes-first-run", CAPTURES[3].label);

  await page.evaluate((partial) => window.__pd?.setSave?.(partial), midProgressPartial());
  await page.evaluate(() => window.__pd?.goto?.("LevelSelect"));
  await expectScene(page, "LevelSelect");
  await page.waitForTimeout(600);
  await shot("05", "holes-mid-progress", CAPTURES[4].label);

  await scrollHolesToBottom(page);
  await page.waitForTimeout(200);
  await shot("06", "holes-scrolled-bottom", CAPTURES[5].label);

  await page.evaluate(() => window.__pd?.goto?.("Settings"));
  await expectScene(page, "Settings");
  await page.waitForTimeout(400);
  await shot("07", "settings", CAPTURES[6].label);

  const resetBtn = await getControl(page, "settings.reset");
  if (resetBtn) await tapControlCenter(page, tapGame, resetBtn);
  await page.waitForTimeout(450);
  await shot("08", "settings-reset-confirm", CAPTURES[7].label);

  await page.evaluate(() => window.__pd?.resetSave?.());
  await page.evaluate(() => window.__pd?.play?.(0));
  await expectScene(page, "Play");
  await page.waitForTimeout(500);
  await shot("09", "play-hole-1-idle", CAPTURES[8].label);

  await dragGame(page, 180, 560, 180, 448, { hold: true });
  await page.waitForTimeout(150);
  await shot("10", "play-aiming", CAPTURES[9].label);
  await page.mouse.up();
  await page.waitForTimeout(300);
  await shot("11", "play-ball-rolling", CAPTURES[10].label);

  await page.evaluate(() => window.__pd?.play?.(0));
  await expectScene(page, "Play");
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__pd?.openPause?.());
  await page.waitForTimeout(450);
  await shot("12", "pause-sheet", CAPTURES[11].label);

  await page.evaluate(() => window.__pd?.play?.(0));
  await expectScene(page, "Play");
  await page.waitForTimeout(350);
  await page.evaluate(() => window.__pd?.forceResult?.(2));
  await page.waitForTimeout(350);
  await shot("13", "result-card-par", CAPTURES[12].label);

  await page.evaluate((partial) => window.__pd?.setSave?.(partial), allFreeDonePartial());
  await page.evaluate(() => window.__pd?.play?.(11));
  await expectScene(page, "Play");
  await page.waitForTimeout(350);
  await page.evaluate(() => window.__pd?.forceResult?.(4));
  await page.waitForTimeout(350);
  await shot("14", "result-card-last-free-hole", CAPTURES[13].label);

  await page.evaluate(() => window.__pd?.play?.(8));
  await expectScene(page, "Play");
  await page.waitForTimeout(500);
  await shot("15", "play-hole-9", CAPTURES[14].label);

  await page.evaluate(() => window.__pd?.goto?.("Unlock"));
  await expectScene(page, "Unlock");
  await page.waitForTimeout(400);
  await shot("16", "unlock-default", CAPTURES[15].label);

  await page.evaluate(() => window.__pd?.forceUnlockState?.("success"));
  await expectScene(page, "Unlock");
  await page.waitForTimeout(400);
  await shot("17", "unlock-success", CAPTURES[16].label);

  await page.evaluate(() => window.__pd?.forceUnlockState?.("failed"));
  await expectScene(page, "Unlock");
  await page.waitForTimeout(500);
  await shot("18", "unlock-failed", CAPTURES[17].label);

  await page.evaluate(() => window.__pd?.goto?.("Settings"));
  await expectScene(page, "Settings");
  const motionToggle = await getControl(page, "settings.toggle.reducedMotion");
  if (motionToggle) await tapControlCenter(page, tapGame, motionToggle);
  await page.waitForTimeout(300);
  await shot("19", "settings-reduced-motion", CAPTURES[18].label);

  const colorToggle = await getControl(page, "settings.toggle.colorblind");
  if (colorToggle) await tapControlCenter(page, tapGame, colorToggle);
  await page.waitForTimeout(300);
  await shot("20", "settings-colorblind", CAPTURES[19].label);

  await page.evaluate(() => window.__pd?.resetSave?.());
  await page.evaluate(() => window.__pd?.play?.(0));
  await expectScene(page, "Play");
  await page.waitForTimeout(2200);
  await shot("21", "first-time-hint", CAPTURES[20].label);

  await page.evaluate(() => window.__pd?.resetSave?.());
  await page.evaluate(() => window.__pd?.goto?.("LevelSelect"));
  await expectScene(page, "LevelSelect");
  await scrollUntilControl(page, "holes.card.13");
  await page.waitForTimeout(300);
  await shot("22", "holes-world-2-locked", CAPTURES[21].label);

  await scrollUntilControl(page, "holes.card.25");
  await page.waitForTimeout(300);
  await shot("23", "holes-world-3-locked", CAPTURES[22].label);

  await page.evaluate(() => window.__pd?.goto?.("Unlock"));
  await expectScene(page, "Unlock");
  await page.waitForTimeout(400);
  await shot("24", "unlock-paid-copy", CAPTURES[23].label);

  await browser.close();
  return shots;
}

function writeIndexHtml(outDir, byDevice) {
  const rows = [];
  for (const profile of DEVICE_PROFILES) {
    rows.push(`<h2>${profile.slug}</h2><div class="grid">`);
    const shots = byDevice[profile.slug] ?? [];
    for (const cap of CAPTURES) {
      const match = shots.find((s) => s.file.includes(`-${cap.nn}-`));
      if (match) {
        rows.push(
          `<figure><img src="${match.file}" alt="${cap.label}"/><figcaption>${cap.nn} ${cap.label}</figcaption></figure>`
        );
      }
    }
    rows.push("</div>");
  }
  rows.push("<h2>Missing states (not in game yet)</h2><ul>");
  for (const m of MISSING_STATES) {
    rows.push(`<li class="missing">MISSING: ${m}</li>`);
  }
  rows.push("</ul>");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Putt Drop baseline screens</title>
<style>
body { font-family: system-ui, sans-serif; margin: 1rem; background: #111; color: #eee; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
figure { margin: 0; }
img { width: 100%; border-radius: 8px; border: 1px solid #333; }
figcaption { font-size: 12px; margin-top: 0.35rem; color: #aaa; }
.missing { color: #f59e0b; }
</style>
</head>
<body>
<h1>Baseline screenshots</h1>
${rows.join("\n")}
</body>
</html>`;
  fs.writeFileSync(path.join(outDir, "index.html"), html);
}

async function main() {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error("Usage: node scripts/capture-screens.mjs <outDir>");
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}/`;
  const preview = spawnPreview(
    "npx",
    ["vite", "preview", "--outDir", "build/test", "--port", String(port), "--strictPort"],
    { cwd: root, stdio: "pipe", env: { ...process.env, BROWSER: "none" } }
  );

  try {
    await waitForHttp(`http://127.0.0.1:${port}/`);
    const byDevice = {};
    for (const profile of DEVICE_PROFILES) {
      console.log(`capture: ${profile.slug}`);
      byDevice[profile.slug] = await captureDevice(outDir, baseUrl, profile);
    }
    writeIndexHtml(outDir, byDevice);
    console.log(`capture: wrote ${outDir}`);
  } finally {
    preview.kill("SIGTERM");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
