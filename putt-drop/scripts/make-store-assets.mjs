/**
 * Play Store phone screenshots (1080×1920) and feature graphic (1024×500).
 * Usage: node scripts/make-store-assets.mjs [--no-build]
 */
import { chromium } from "playwright";
import { spawn, execSync } from "node:child_process";
import { createServer } from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnPreview, launchBrowser } from "./lib/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const shotDir = path.join(root, "store", "screenshots");
const featurePath = path.join(root, "store", "feature-1024x500.png");

const VIEWPORT = { width: 360, height: 640 };
const SCALE = 3;

const OLD_SHOTS = [
  "store/screenshots/01-hole-1-aiming.png",
  "store/screenshots/02-hole-9-undertow.png",
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

async function waitForHttp(url, ms = 60_000) {
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

async function screenMap(page) {
  const box = await page.locator("#game canvas").boundingBox();
  if (!box) throw new Error("Canvas not found");
  const s = Math.min(box.width / 360, box.height / 640);
  return { x: box.x + (box.width - 360 * s) / 2, y: box.y + (box.height - 640 * s) / 2, s };
}

async function makeToucher(page, context) {
  const cdp = await context.newCDPSession(page);
  return {
    down: (x, y) => cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] }),
    move: (x, y) => cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y, id: 1 }] }),
    up: () => cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }),
  };
}

async function expectScene(page, name, withinMs = 8000) {
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
  await expectScene(page, "Menu");
  await page.waitForFunction(() => window.__pd?.fontsReady?.() ?? false, { timeout: 10000 });
  await page.waitForTimeout(400);
}

async function saveFullScreenshot(page, file) {
  await page.screenshot({ path: file, type: "png" });
}

async function playHole(page, hole, save) {
  await page.evaluate(
    ({ hole, save }) => {
      if (save === "reset") window.__pd.resetSave();
      else if (save) window.__pd.setSave(save);
      window.__pd.play(hole);
    },
    { hole, save }
  );
  await page.waitForFunction(
    (h) =>
      (window.__pd?.activeScenes?.() ?? []).includes("Play") &&
      window.__pdCourse?.level?.().id === `hole${String(h + 1).padStart(2, "0")}`,
    hole,
    { timeout: 10000 }
  );
  await page.evaluate(() => window.__pdCourse.isolate());
  await page.waitForTimeout(500);
}

async function findShot(page, want, opts = {}) {
  const map = await screenMap(page);
  return page.evaluate(
    ({ map, want, opts }) => {
      const pc = window.__pdCourse;
      const f = pc.frame();
      const lvl = pc.level();
      const [bux, buy] = pc.ballUi();
      const sx = Math.round(map.x + bux * map.s);
      const sy = Math.round(map.y + buy * map.s);
      const base = Math.atan2(lvl.cup[1] - lvl.tee[1], lvl.cup[0] - lvl.tee[0]);
      const angles = [];
      for (let d = 0; d <= Math.PI; d += 0.01) {
        angles.push(base + d);
        if (d > 0) angles.push(base - d);
      }
      const powers = [];
      for (let p = opts.pMin ?? 0.3; p <= (opts.pMax ?? 1.0) + 1e-9; p += 0.02) powers.push(p);
      const shotFor = (a, p) => {
        const lenUi = p * 160 * f.q;
        const ex = Math.round(sx - Math.cos(a) * lenUi * map.s);
        const ey = Math.round(sy - Math.sin(a) * lenUi * map.s);
        const dx = (sx - ex) / map.s / f.q;
        const dy = (sy - ey) / map.s / f.q;
        return { ex, ey, angle: Math.atan2(dy, dx), power: Math.min(1, Math.hypot(dx, dy) / 160) };
      };
      for (const a of angles) {
        for (const p of powers) {
          const s = shotFor(a, p);
          const r = pc.simulate(s.angle, s.power);
          const ev = r.events;
          const ok =
            (want === "water" && ev.includes("water")) ||
            (want === "bumper" && ev.includes("bumper-hit") && !ev.includes("water") && !r.holed);
          if (ok) return { sx, sy, ex: s.ex, ey: s.ey, events: ev.slice(0, 8) };
        }
      }
      return null;
    },
    { map, want, opts }
  );
}

async function putt(page, toucher, shot, holdMs = 60) {
  await toucher.down(shot.sx, shot.sy);
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    await toucher.move(
      Math.round(shot.sx + ((shot.ex - shot.sx) * i) / steps),
      Math.round(shot.sy + ((shot.ey - shot.sy) * i) / steps)
    );
  }
  await page.waitForTimeout(holdMs);
  await toucher.up();
}

async function armFreeze(page, name) {
  await page.evaluate((n) => window.__pdCourse.freezeOn(n), name);
}

async function waitFrozen(page, name, timeout = 8000) {
  await page.waitForFunction((n) => window.__pdCourse.frozen() === n, name, { timeout });
}

function midProgressPartial() {
  const holes = [];
  const bests = [1, 3, 4, 2, 3, 5];
  for (let i = 0; i < 18; i++) {
    const base = {
      attempts: 0,
      fails: 0,
      consecutiveBadFinishes: 0,
      assistEnabled: false,
    };
    if (i < 6) holes.push({ ...base, attempts: 2, best: bests[i] });
    else holes.push(base);
  }
  return { holes, lastHole: 5, firstPuttTutorialSeen: true };
}

async function capturePhoneScreenshots(page, toucher) {
  fs.mkdirSync(shotDir, { recursive: true });
  for (const rel of OLD_SHOTS) {
    const p = path.join(root, rel);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  // 01 — Menu (Pocket Park hero, Play)
  await page.evaluate(() => window.__pd.resetSave());
  await page.evaluate(() => window.__pd.goto("Menu"));
  await waitMenuReady(page);
  await saveFullScreenshot(page, path.join(shotDir, "play-01-menu.png"));

  // 02 — Hole 1 aiming ~70% (ring + dotted path)
  const seen = { firstPuttTutorialSeen: true };
  await playHole(page, 0, seen);
  {
    const map = await screenMap(page);
    const { f, ball } = await page.evaluate(() => ({
      f: window.__pdCourse.frame(),
      ball: window.__pdCourse.ballUi(),
    }));
    const sx = Math.round(map.x + ball[0] * map.s);
    const sy = Math.round(map.y + ball[1] * map.s);
    const len = 0.7 * 160 * f.q * map.s;
    const a = -Math.PI / 2 - 0.1;
    await armFreeze(page, "aim70");
    await toucher.down(sx, sy);
    for (let i = 1; i <= 10; i++) {
      await toucher.move(
        Math.round(sx - Math.cos(a) * len * (i / 10)),
        Math.round(sy - Math.sin(a) * len * (i / 10))
      );
    }
    await waitFrozen(page, "aim70");
    await saveFullScreenshot(page, path.join(shotDir, "play-02-aiming.png"));
    await page.evaluate(() => window.__pdCourse.wake());
    await toucher.up();
  }

  // 03 — Water splash (hole 5) or bumper hit
  await playHole(page, 4, seen);
  let reactionShot = await findShot(page, "water", { pMin: 0.25, pMax: 0.85 });
  let freezeName = "splash";
  if (!reactionShot) {
    await playHole(page, 8, seen);
    reactionShot = await findShot(page, "bumper", { pMin: 0.35, pMax: 1.0 });
    freezeName = "squash";
  }
  if (!reactionShot) throw new Error("No water or bumper reaction shot found");
  await armFreeze(page, freezeName);
  await putt(page, toucher, reactionShot);
  if (freezeName === "splash") {
    await waitFrozen(page, "splash", 9000);
  } else {
    await waitFrozen(page, "squash", 9000);
  }
  await saveFullScreenshot(page, path.join(shotDir, "play-03-reaction.png"));
  await page.evaluate(() => window.__pdCourse.wake());

  // 04 — Hole 9 overview, ball on tee
  await playHole(page, 8, seen);
  await page.waitForTimeout(350);
  await saveFullScreenshot(page, path.join(shotDir, "play-04-course.png"));

  // 05 — Celebration card with stars (hole in one on par-2 hole 1)
  await playHole(page, 0, seen);
  await page.evaluate(() => window.__pd.forceResult(1));
  await page.waitForTimeout(450);
  await saveFullScreenshot(page, path.join(shotDir, "play-05-celebration.png"));

  // 06 — Holes grid with several completed (stars)
  await page.evaluate((partial) => window.__pd.setSave(partial), midProgressPartial());
  await page.evaluate(() => window.__pd.goto("LevelSelect"));
  await expectScene(page, "LevelSelect");
  await page.waitForTimeout(600);
  await saveFullScreenshot(page, path.join(shotDir, "play-06-holes.png"));
}

async function renderFeatureGraphic(browser) {
  const fontB64 = fs.readFileSync(path.join(root, "public/fonts/Fredoka-Variable.ttf")).toString("base64");
  const fontUrl = `data:font/ttf;base64,${fontB64}`;
  const page = await browser.newPage({
    viewport: { width: 1024, height: 500 },
    deviceScaleFactor: 1,
  });
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<style>
@font-face {
  font-family: "Fredoka";
  src: url("${fontUrl}") format("truetype");
  font-weight: 100 900;
}
* { margin: 0; box-sizing: border-box; }
body {
  width: 1024px; height: 500px; overflow: hidden;
  background: linear-gradient(180deg, #faf3df 0%, #eee8cf 55%, #fae0b9 100%);
}
svg { display: block; width: 1024px; height: 500px; }
.wordmark {
  position: absolute;
  left: 50%;
  top: 72px;
  transform: translateX(-50%) rotate(-4deg);
  font-family: Fredoka, sans-serif;
  font-weight: 600;
  font-size: 72px;
  line-height: 0.92;
  color: #354b3a;
  text-align: center;
  letter-spacing: -1px;
}
.wordmark .drop { display: block; margin-left: 48px; }
</style>
</head>
<body>
<svg viewBox="0 0 1024 500" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Putt Drop feature art">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0.3" y2="1">
      <stop offset="0%" stop-color="#faf3df"/>
      <stop offset="100%" stop-color="#eee8cf"/>
    </linearGradient>
    <linearGradient id="turf" x1="0" y1="0" x2="0.6" y2="1">
      <stop offset="0%" stop-color="#b3d28b"/>
      <stop offset="100%" stop-color="#87b36f"/>
    </linearGradient>
    <linearGradient id="water" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#64b7c6"/>
      <stop offset="100%" stop-color="#338696"/>
    </linearGradient>
    <radialGradient id="ball" cx="0.35" cy="0.3" r="0.7">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="55%" stop-color="#f2f7e9"/>
      <stop offset="100%" stop-color="#b9cbb8"/>
    </radialGradient>
    <filter id="soft" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="6" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect width="1024" height="500" fill="url(#sky)"/>
  <ellipse cx="180" cy="120" rx="140" ry="52" fill="#fff9e9" opacity="0.55"/>
  <ellipse cx="820" cy="95" rx="170" ry="58" fill="#fff9e9" opacity="0.45"/>
  <ellipse cx="512" cy="430" rx="360" ry="118" fill="#887653" opacity="0.18"/>
  <ellipse cx="512" cy="400" rx="320" ry="100" fill="url(#turf)" stroke="#887653" stroke-width="6"/>
  <ellipse cx="380" cy="395" rx="72" ry="28" fill="url(#water)" opacity="0.85"/>
  <path d="M600 355 Q 520 330 460 360 T 350 390" fill="none" stroke="#d5c8a6" stroke-width="3" stroke-dasharray="8 10" opacity="0.5"/>
  <circle cx="620" cy="372" r="26" fill="#354b3a"/>
  <circle cx="620" cy="368" r="22" fill="#203428"/>
  <line x1="620" y1="346" x2="620" y2="300" stroke="#816b45" stroke-width="5" stroke-linecap="round"/>
  <path d="M620 300 L648 312 L620 324 Z" fill="#db6246"/>
  <circle cx="430" cy="408" r="14" fill="url(#ball)" stroke="#626950" stroke-width="1.5"/>
  <circle cx="424" cy="402" r="4" fill="#fff" opacity="0.7"/>
</svg>
<div class="wordmark"><span>Putt</span><span class="drop">Drop</span></div>
</body>
</html>`;
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(async () => {
    await document.fonts.load('600 72px "Fredoka"');
    await document.fonts.ready;
  });
  await page.waitForTimeout(200);
  await page.screenshot({ path: featurePath, type: "png", omitBackground: false });
  await page.close();
}

async function main() {
  if (!process.argv.includes("--no-build")) {
    console.log("make-store-assets: building test bundle…");
    execSync("npm run build:test", { cwd: root, stdio: "inherit" });
  }

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}/`;
  const preview = spawnPreview(
    "npx",
    ["vite", "preview", "--outDir", "build/test", "--port", String(port), "--strictPort"],
    { cwd: root, stdio: "pipe", env: { ...process.env, BROWSER: "none" } }
  );

  const browser = await launchBrowser(chromium, { headless: true });
  try {
    await waitForHttp(baseUrl);
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: SCALE,
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.__pd?.fontsReady?.() ?? false, { timeout: 15000 });
    const toucher = await makeToucher(page, context);
    await capturePhoneScreenshots(page, toucher);
    await context.close();
    await renderFeatureGraphic(browser);
    console.log("make-store-assets: done");
  } finally {
    preview.kill("SIGTERM");
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
