import { chromium, webkit, devices } from "playwright";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

async function capture(browserType, deviceName, slug) {
  const port = await freePort();
  const preview = spawnPreview("npx", ["vite", "preview", "--port", String(port), "--strictPort"], {
    cwd: root,
    stdio: "ignore",
  });
  await waitForHttp(`http://127.0.0.1:${port}/`);
  const device = devices[deviceName];
  const browser = await launchBrowser(browserType, { headless: true });
  const context = await browser.newContext({ ...device, hasTouch: true });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/?test`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__pd?.activeScenes?.()?.includes("Menu"), { timeout: 15000 });
  await page.evaluate(() => window.__pd.goto("Gallery"));
  await page.waitForFunction(() => window.__pd?.activeScenes?.()?.includes("Gallery"), { timeout: 8000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(outDir, `gallery-${slug}-top.png`), fullPage: false });
  await page.evaluate(() => window.__pd?.scrollGallery?.(320));
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(outDir, `gallery-${slug}-scrolled.png`), fullPage: false });
  await browser.close();
  preview.kill("SIGTERM");
}

async function captureScene(browserType, deviceName, slug, gotoFn) {
  const port = await freePort();
  const preview = spawnPreview("npx", ["vite", "preview", "--port", String(port), "--strictPort"], {
    cwd: root,
    stdio: "ignore",
  });
  await waitForHttp(`http://127.0.0.1:${port}/`);
  const device = devices[deviceName];
  const browser = await launchBrowser(browserType, { headless: true });
  const context = await browser.newContext({ ...device, hasTouch: true });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/?test`, { waitUntil: "networkidle" });
  await gotoFn(page);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(outDir, `${slug}-${deviceName.replace(/\s/g, "-").toLowerCase()}.png`) });
  await browser.close();
  preview.kill("SIGTERM");
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  await capture(chromium, "Pixel 7", "pixel7");
  await capture(webkit, "iPhone 15", "iphone15");

  await captureScene(chromium, "Pixel 7", "menu", async (page) => {
    await page.waitForFunction(() => window.__pd?.activeScenes?.()?.includes("Menu"), { timeout: 10000 });
  });
  await captureScene(chromium, "Pixel 7", "holes", async (page) => {
    await page.evaluate(() => window.__pd.goto("LevelSelect"));
    await page.waitForFunction(() => window.__pd?.activeScenes?.()?.includes("LevelSelect"), { timeout: 8000 });
  });
  await captureScene(chromium, "Pixel 7", "settings", async (page) => {
    await page.evaluate(() => window.__pd.goto("Settings"));
    await page.waitForFunction(() => window.__pd?.activeScenes?.()?.includes("Settings"), { timeout: 8000 });
  });
  await captureScene(chromium, "Pixel 7", "play", async (page) => {
    await page.evaluate(() => window.__pd.play(0));
    await page.waitForFunction(() => window.__pd?.activeScenes?.()?.includes("Play"), { timeout: 8000 });
  });
  await captureScene(chromium, "Pixel 7", "pause", async (page) => {
    await page.evaluate(() => {
      window.__pd.play(0);
    });
    await page.waitForFunction(() => window.__pd?.activeScenes?.()?.includes("Play"), { timeout: 8000 });
    await page.evaluate(() => window.__pd.openPause());
    await page.waitForTimeout(400);
  });

  console.log("gallery captures written to test-results/");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
