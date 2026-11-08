import { webkit, devices } from "playwright";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertCanvasBackingStore,
  assertMenuScenePicture,
  assertSceneBlackPixels,
  assertSceneControls,
  LOGICAL_H,
  LOGICAL_W,
} from "./smoke-picture.mjs";
import { getControl, tapControlCenter, tapSamples } from "./smoke-controls.mjs";
import { spawnPreview, launchBrowser } from "./lib/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const outDir = path.join(root, "test-results");

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
  const scale = Math.min(box.width / LOGICAL_W, box.height / LOGICAL_H);
  const ox = box.x + (box.width - LOGICAL_W * scale) / 2;
  const oy = box.y + (box.height - LOGICAL_H * scale) / 2;
  return { x: ox + gx * scale, y: oy + gy * scale };
}

async function tapGame(page, gx, gy) {
  const p = await gamePoint(page, gx, gy);
  await page.touchscreen.tap(p.x, p.y);
}

async function touchDragGame(page, x1, y1, x2, y2) {
  const a = await gamePoint(page, x1, y1);
  const b = await gamePoint(page, x2, y2);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 12 });
  await page.mouse.up();
}

async function expectScene(page, name, withinMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < withinMs) {
    const scenes = await page.evaluate(() => window.__pd?.activeScenes?.() ?? []);
    if (scenes.includes(name)) return;
    await page.waitForTimeout(20);
  }
  const scenes = await page.evaluate(() => window.__pd?.activeScenes?.() ?? []);
  throw new Error(`Expected active scene "${name}" within ${withinMs}ms; got [${scenes.join(", ")}]`);
}

async function gotoMenu(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await expectScene(page, "Menu", 2000);
  await page.evaluate(async () => {
    await document.fonts.load("700 20px Fredoka");
    await document.fonts.load("600 16px Nunito");
  });
  await page.waitForFunction(
    () => window.__pd?.fontsReady?.() ?? false,
    { timeout: 5000 }
  );
}

async function testControlTaps(page, baseUrl, controlId, expectSceneName, beforeTap) {
  const points = [];
  for (let i = 0; i < 5; i++) {
    await gotoMenu(page, baseUrl);
    if (beforeTap) await beforeTap(page);
    const ctrl = await getControl(page, controlId);
    if (!ctrl) throw new Error(`Missing control ${controlId}`);
    const cx = ctrl.x + ctrl.w / 2;
    const cy = ctrl.y + ctrl.h / 2;
    if (i === 0) points.push(...tapSamples(cx, cy, ctrl.w * 0.72, ctrl.h * 0.72));
    const pt = points[i];
    await tapGame(page, pt.x, pt.y);
    await page.waitForTimeout(350);
    await expectScene(page, expectSceneName, 2000);
  }
}

async function openHoles(page) {
  await tapControlCenter(page, tapGame, await getControl(page, "menu.holes"));
  await expectScene(page, "LevelSelect", 800);
  await page.waitForFunction(
    () => (window.__pd?.controls?.() ?? []).some((c) => c.id === "holes.card.1"),
    { timeout: 4000 }
  );
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}/`;

  const preview = spawnPreview(
    "npx",
    ["vite", "preview", "--outDir", "build/test", "--port", String(port), "--strictPort"],
    { cwd: root, stdio: "pipe", env: { ...process.env, BROWSER: "none" } }
  );

  const errors = [];
  const onPreviewData = (chunk) => {
    const t = chunk.toString();
    if (t.toLowerCase().includes("error")) errors.push(t);
  };
  preview.stderr.on("data", onPreviewData);
  preview.stdout.on("data", onPreviewData);

  try {
    await waitForHttp(`http://127.0.0.1:${port}/`);

    const iPhone = devices["iPhone 15"];
    const browser = await launchBrowser(webkit, { headless: true });
    const context = await browser.newContext({
      ...iPhone,
      hasTouch: true,
    });
    const page = await context.newPage();

    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
    });
    page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));

    await gotoMenu(page, baseUrl);
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(outDir, "menu-ios.png"), fullPage: false });
    try {
      await assertCanvasBackingStore(page, "ios menu");
      await assertMenuScenePicture(page, "ios menu");
      await assertSceneControls(page, "ios menu", { scenePrefix: "menu." });
    } catch (e) {
      errors.push(e.message);
    }

    for (const id of ["menu.play", "menu.holes", "menu.settings"]) {
      try {
        await testControlTaps(page, baseUrl, id, id === "menu.play" ? "Play" : id === "menu.holes" ? "LevelSelect" : "Settings");
      } catch (e) {
        errors.push(`${id}: ${e.message}`);
      }
    }

    await testControlTaps(page, baseUrl, "holes.back", "Menu", openHoles);
    await gotoMenu(page, baseUrl);
    await tapControlCenter(page, tapGame, await getControl(page, "menu.settings"));
    await expectScene(page, "Settings");
    await testControlTaps(page, baseUrl, "settings.back", "Menu", async () => {
      await tapControlCenter(page, tapGame, await getControl(page, "menu.settings"));
      await expectScene(page, "Settings", 800);
    });

    await testControlTaps(page, baseUrl, "holes.card.1", "Play", openHoles);

    const pauseCtrl = await getControl(page, "play.pause");
    if (!pauseCtrl) errors.push("Missing play.pause");
    else {
      const cx = pauseCtrl.x + pauseCtrl.w / 2;
      const cy = pauseCtrl.y + pauseCtrl.h / 2;
      const pausePoints = tapSamples(cx, cy, pauseCtrl.w, pauseCtrl.h);
      for (const pt of pausePoints) {
        await gotoMenu(page, baseUrl);
        await tapControlCenter(page, tapGame, await getControl(page, "menu.play"));
        await expectScene(page, "Play", 800);
        await tapGame(page, pt.x, pt.y);
        await page.waitForTimeout(150);
        const paused = await page.evaluate(() => window.__pd?.isPaused?.() ?? false);
        if (!paused) errors.push(`Pause tap at ${pt.x},${pt.y} did not open pause panel`);
        const resume = await getControl(page, "pause.resume");
        if (resume) await tapControlCenter(page, tapGame, resume);
        await page.waitForTimeout(100);
        await page.waitForTimeout(200);
        if (await page.evaluate(() => window.__pd?.isPaused?.() ?? true)) {
          const resume = await getControl(page, "pause.resume");
          if (resume) await tapControlCenter(page, tapGame, resume);
          await page.waitForTimeout(200);
        }
      }
    }

    const resumeCtrl = await getControl(page, "pause.resume");
    if (resumeCtrl) {
      const rcx = resumeCtrl.x + resumeCtrl.w / 2;
      const rcy = resumeCtrl.y + resumeCtrl.h / 2;
      for (const pt of tapSamples(rcx, rcy, resumeCtrl.w, resumeCtrl.h)) {
        await gotoMenu(page, baseUrl);
        await tapControlCenter(page, tapGame, await getControl(page, "menu.play"));
        await expectScene(page, "Play", 800);
        await tapControlCenter(page, tapGame, await getControl(page, "play.pause"));
        await page.waitForTimeout(120);
        await tapGame(page, pt.x, pt.y);
        await page.waitForTimeout(100);
        if (await page.evaluate(() => window.__pd?.isPaused?.() ?? true)) {
          errors.push(`Resume tap at ${pt.x},${pt.y} failed to close pause`);
        }
      }
    }

    await gotoMenu(page, baseUrl);
    await tapControlCenter(page, tapGame, await getControl(page, "menu.play"));
    await expectScene(page, "Play");
    const strokesBefore = await page.evaluate(() => window.__pd?.strokeCount?.() ?? 0);
    await touchDragGame(page, 180, 560, 180, 380);
    await page.waitForTimeout(500);
    const strokesAfter = await page.evaluate(() => window.__pd?.strokeCount?.() ?? 0);
    if (strokesAfter <= strokesBefore) {
      errors.push(`putt stroke count unchanged: before=${strokesBefore} after=${strokesAfter}`);
    }

    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(outDir, "play-ios.png"), fullPage: false });
    try {
      await assertSceneBlackPixels(page, "ios play");
      await assertSceneControls(page, "ios play", { scenePrefix: "play." });
    } catch (e) {
      errors.push(e.message);
    }

    await tapControlCenter(page, tapGame, await getControl(page, "play.pause"));
    await page.waitForTimeout(450);
    await page.screenshot({ path: path.join(outDir, "pause-ios.png"), fullPage: false });
    try {
      await assertSceneControls(page, "ios pause", {
        scenePrefix: "pause.",
        checkPauseSheet: true,
      });
    } catch (e) {
      errors.push(e.message);
    }

    await tapControlCenter(page, tapGame, await getControl(page, "pause.holes"));
    await expectScene(page, "LevelSelect", 800);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(outDir, "holes-ios.png"), fullPage: false });
    try {
      await assertSceneBlackPixels(page, "ios holes");
      await assertSceneControls(page, "ios holes", { scenePrefix: "holes." });
    } catch (e) {
      errors.push(e.message);
    }

    await gotoMenu(page, baseUrl);
    await tapControlCenter(page, tapGame, await getControl(page, "menu.settings"));
    await expectScene(page, "Settings", 800);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(outDir, "settings-ios.png"), fullPage: false });
    try {
      await assertSceneControls(page, "ios settings", {
        scenePrefix: "settings.",
        requireSettingsToggles: true,
      });
    } catch (e) {
      errors.push(e.message);
    }

    await browser.close();

    if (errors.length) {
      console.error(errors.join("\n"));
      process.exit(1);
    }
    console.log("smoke:ios ok");
  } finally {
    preview.kill("SIGTERM");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
