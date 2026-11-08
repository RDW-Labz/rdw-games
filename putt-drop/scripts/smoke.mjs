import { chromium, webkit, devices } from "playwright";
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
  assertControlsSafeArea,
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
  const scale = Math.min(box.width / 360, box.height / 640);
  const ox = box.x + (box.width - 360 * scale) / 2;
  const oy = box.y + (box.height - 640 * scale) / 2;
  return { x: ox + gx * scale, y: oy + gy * scale };
}

async function tapGame(page, gx, gy) {
  const p = await gamePoint(page, gx, gy);
  await page.touchscreen.tap(p.x, p.y);
}

async function dragGame(page, x1, y1, x2, y2) {
  const a = await gamePoint(page, x1, y1);
  const b = await gamePoint(page, x2, y2);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 10 });
  await page.mouse.up();
}

async function expectScene(page, name, withinMs = 600) {
  const start = Date.now();
  while (Date.now() - start < withinMs) {
    const scenes = await page.evaluate(() => window.__pd?.activeScenes?.() ?? []);
    if (scenes.includes(name)) return;
    await page.waitForTimeout(20);
  }
  const scenes = await page.evaluate(() => window.__pd?.activeScenes?.() ?? []);
  throw new Error(`Expected active scene "${name}" within ${withinMs}ms; got [${scenes.join(", ")}]`);
}

async function tapControlAndExpectScene(page, controlId, scene, withinMs = 1200) {
  // One real tap at the control's center; no retries at other points (taps-strict.mjs covers
  // all five points per control).
  const ctrl = await getControl(page, controlId);
  if (!ctrl) throw new Error(`Missing control ${controlId}`);
  await tapControlCenter(page, tapGame, ctrl);
  await expectScene(page, scene, withinMs);
  // The scene responded in time; let control-appear animations (160 ms) settle so the picture
  // checks that follow sample final faces.
  await page.waitForTimeout(400);
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

    const browser = await launchBrowser(chromium, { headless: true });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();

    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
    });
    page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));

    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await expectScene(page, "Menu", 2000);
    await page.evaluate(async () => {
      await document.fonts.load("700 20px Fredoka");
      await document.fonts.load("600 16px Nunito");
    });
    await page.waitForFunction(() => window.__pd?.fontsReady?.() ?? false, { timeout: 5000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(outDir, "menu.png") });
    try {
      await assertCanvasBackingStore(page, "chromium menu");
      await assertMenuScenePicture(page, "chromium menu");
      await assertSceneControls(page, "chromium menu", { scenePrefix: "menu." });
    } catch (e) {
      errors.push(e.message);
    }

    await tapControlAndExpectScene(page, "menu.play", "Play");
    await page.waitForTimeout(300);
    await dragGame(page, 180, 560, 180, 380);
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(outDir, "play.png") });
    try {
      await assertSceneBlackPixels(page, "chromium play");
      await assertSceneControls(page, "chromium play", { scenePrefix: "play." });
    } catch (e) {
      errors.push(e.message);
    }

    const pauseCtrl = await getControl(page, "play.pause");
    if (!pauseCtrl) errors.push("Missing play.pause control");
    else await tapControlCenter(page, tapGame, pauseCtrl);
    await page.waitForTimeout(450);
    await page.screenshot({ path: path.join(outDir, "pause.png") });
    try {
      await assertSceneControls(page, "chromium pause", {
        scenePrefix: "pause.",
        checkPauseSheet: true,
      });
    } catch (e) {
      errors.push(e.message);
    }

    await tapControlAndExpectScene(page, "pause.holes", "LevelSelect");
    await page.screenshot({ path: path.join(outDir, "holes.png") });
    try {
      await assertSceneBlackPixels(page, "chromium holes");
      await assertSceneControls(page, "chromium holes", { scenePrefix: "holes." });
    } catch (e) {
      errors.push(e.message);
    }

    await tapControlAndExpectScene(page, "holes.card.1", "Play");
    await page.waitForTimeout(300);
    await tapControlCenter(page, tapGame, await getControl(page, "play.pause"));
    await page.waitForTimeout(400);
    await tapControlAndExpectScene(page, "pause.holes", "LevelSelect");
    await page.waitForTimeout(350);
    await tapControlAndExpectScene(page, "holes.back", "Menu");
    await tapControlAndExpectScene(page, "menu.settings", "Settings");
    await page.screenshot({ path: path.join(outDir, "settings.png") });
    try {
      await assertSceneControls(page, "chromium settings", {
        scenePrefix: "settings.",
        requireSettingsToggles: true,
      });
    } catch (e) {
      errors.push(e.message);
    }

    for (const id of [
      "settings.toggle.sound",
      "settings.toggle.music",
      "settings.toggle.vibration",
      "settings.toggle.reducedMotion",
      "settings.toggle.colorblind",
    ]) {
      const ctrl = await getControl(page, id);
      if (!ctrl) {
        errors.push(`Missing ${id}`);
        continue;
      }
      const cx = ctrl.x + ctrl.w / 2;
      const cy = ctrl.y + ctrl.h / 2;
      for (const pt of tapSamples(cx, cy, ctrl.w, ctrl.h)) {
        await tapGame(page, pt.x, pt.y);
      }
      await page.waitForTimeout(40);
    }

    await tapControlAndExpectScene(page, "settings.back", "Menu");

    await page.evaluate(() => window.__pd?.goto?.("Unlock"));
    await expectScene(page, "Unlock", 2000);
    for (const id of ["unlock.purchase", "unlock.restore"]) {
      const ctrl = await getControl(page, id);
      if (!ctrl) errors.push(`Missing ${id}`);
      else {
        const cx = ctrl.x + ctrl.w / 2;
        const cy = ctrl.y + ctrl.h / 2;
        for (const pt of tapSamples(cx, cy, ctrl.w, ctrl.h)) {
          await tapGame(page, pt.x, pt.y);
        }
        await page.waitForTimeout(40);
      }
    }
    const keep = await getControl(page, "unlock.keepPlaying");
    if (!keep) errors.push("Missing unlock.keepPlaying");
    else await tapControlCenter(page, tapGame, keep);
    await expectScene(page, "LevelSelect", 2000);
    await page.evaluate(() => window.__pd?.forceUnlockState?.("success"));
    await expectScene(page, "Unlock", 2000);
    const unlockPlay = await getControl(page, "unlock.success.holes");
    if (unlockPlay) await tapControlCenter(page, tapGame, unlockPlay);
    await expectScene(page, "LevelSelect", 2000);

    // Reduced motion, both sources: the saved toggle, and the OS setting (emulated
    // prefers-reduced-motion: reduce with the toggle off). The travel decoration must be
    // finished within 200 ms of navigation (measured, not just configured).
    async function measureTravel(p, label) {
      await p.evaluate(() => window.__pd.goto("Menu"));
      await expectScene(p, "Menu", 2000);
      await p.waitForTimeout(400);
      // Timed inside the page (rAF), so test-harness round trips are not counted.
      const elapsed = await p.evaluate(
        () =>
          new Promise((resolve) => {
            const t0 = performance.now();
            window.__pd.goto("Settings");
            const tick = () => {
              const now = performance.now();
              if (window.__pd.activeScenes().includes("Settings") && !window.__pd.traveling()) resolve(now - t0);
              else if (now - t0 > 1000) resolve(Infinity);
              else requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          })
      );
      const done = Number.isFinite(elapsed);
      const configured = await p.evaluate(() => window.__pd.transitionMs());
      console.log(`reduced motion (${label}): configured ${configured} ms, finished after ${Number(elapsed).toFixed(0)} ms`);
      if (!done || elapsed > 200) errors.push(`reduced motion (${label}): travel not finished within 200 ms (${Number(elapsed).toFixed(0)} ms)`);
      if (configured > 200) errors.push(`reduced motion (${label}): configured ${configured} ms > 200`);
    }
    await page.evaluate(() => window.__pd.setSave({ settings: { reducedMotion: true } }));
    await measureTravel(page, "saved toggle");
    await page.evaluate(() => window.__pd.setSave({ settings: { reducedMotion: false } }));

    {
      const rmCtx = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        reducedMotion: "reduce",
      });
      const rmPage = await rmCtx.newPage();
      await rmPage.goto(baseUrl, { waitUntil: "networkidle" });
      await expectScene(rmPage, "Menu", 3000);
      const saved = await rmPage.evaluate(() => window.__pd.save().settings.reducedMotion);
      if (saved) errors.push("OS reduced-motion run: saved toggle unexpectedly on");
      await measureTravel(rmPage, "OS prefers-reduced-motion");
      await rmCtx.close();
    }

    // Screen fit: every control fully on screen and clear of the status bar / home indicator.
    // The shipping target is a full-screen Capacitor webview (index.html uses viewport-fit=cover),
    // so the page is sized to the device SCREEN (not the Safari viewport) and the device's real
    // insets in CSS px are applied: iPhone 15 59/34 (Dynamic Island, stricter than the 47 in the
    // job spec), iPhone SE (1st gen in Playwright, 320x568) 20/0, Pixel 7 48/24 (conservative
    // status bar + gesture bar).
    const fitDevices = [
      { name: "iPhone 15", engine: webkit, device: devices["iPhone 15"], insets: { top: 59, bottom: 34 } },
      { name: "iPhone SE", engine: webkit, device: devices["iPhone SE"], insets: { top: 20, bottom: 0 } },
      { name: "Pixel 7", engine: chromium, device: devices["Pixel 7"], insets: { top: 48, bottom: 24 } },
    ];
    const fitScreens = [
      { scene: "Menu", prefix: "menu.", go: () => window.__pd.goto("Menu") },
      { scene: "LevelSelect", prefix: "holes.", go: () => window.__pd.goto("LevelSelect") },
      { scene: "Settings", prefix: "settings.", go: () => window.__pd.goto("Settings") },
      { scene: "Unlock", prefix: "unlock.", go: () => window.__pd.goto("Unlock") },
    ];
    for (const dev of fitDevices) {
      const fitBrowser = dev.engine === webkit ? await launchBrowser(webkit, { headless: true }) : browser;
      const fitCtx = await fitBrowser.newContext({
        ...dev.device,
        viewport: dev.device.screen ?? dev.device.viewport,
      });
      const fitPage = await fitCtx.newPage();
      await fitPage.goto(baseUrl, { waitUntil: "networkidle" });
      await expectScene(fitPage, "Menu", 3000);
      for (const sc of fitScreens) {
        await fitPage.evaluate(sc.go);
        await expectScene(fitPage, sc.scene, 3000);
        await fitPage.waitForTimeout(150);
        const canvasBox = await fitPage.locator("#game canvas").boundingBox();
        const viewport = fitPage.viewportSize();
        let controls = await fitPage.evaluate(() => window.__pd.controls());
        // Hole cards live in a scroll viewport; only the fixed controls must fit on screen.
        controls = controls.filter((c) => !c.id.startsWith("holes.card.") && c.id !== "holes.unlock");
        try {
          const n = assertControlsSafeArea(controls, `${dev.name} ${sc.scene} fit`, {
            canvasBox,
            viewport,
            insets: dev.insets,
            scenePrefix: sc.prefix,
          });
          console.log(`fit ${dev.name} ${sc.scene}: ${n} controls inside safe area`);
        } catch (e) {
          errors.push(e.message);
        }
      }
      await fitCtx.close();
      if (fitBrowser !== browser) await fitBrowser.close();
    }

    await browser.close();

    if (errors.length) {
      console.error(errors.join("\n"));
      process.exit(1);
    }
    console.log("smoke: ok");
  } finally {
    preview.kill("SIGTERM");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
