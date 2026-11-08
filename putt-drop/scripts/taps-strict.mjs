// Strict real-touch tap probe for every control on every screen.
//
// Rules (no exceptions, no fallbacks):
// - Every tap is a real Playwright touch (`page.touchscreen.tap`) at a point derived from the
//   control's on-screen rect reported by `__pd.controls()`: the center and 15% in from each edge.
// - After each tap the expected outcome must be observed within 1200 ms or the point FAILS.
//   Nothing ever navigates on the test's behalf after a tap.
// - `__pd.goto/play/openPause/forceResult/forceUnlockState` are used ONLY to reach a screen
//   before its controls are tested.
// - Every control id visible on a tested screen must have an expected outcome below (or be listed
//   as a non-button region); an unknown id fails the run.
// Devices: iPhone 15 + iPhone SE (WebKit), Pixel 7 (Chromium). Serves build/test
// (`npm run build:test`). Prints a pass table; exit 1 on any failure.
import { chromium, webkit, devices } from "playwright";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnPreview, launchBrowser } from "./lib/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const buildDir = path.join(root, "build", "test");
const LOGICAL_W = 360;
const LOGICAL_H = 640;
const OUTCOME_MS = 1200;
/** Hole-select scroll viewport: top bar + 12 .. A-140 (clip above the fixed Full game + Play footer, A=600). */
const GRID_TOP = 100;
const GRID_BOTTOM = 460;

/** Ids that are registered regions, not buttons (reported so they are visible in the output). */
const NON_BUTTONS = new Set(["pause.sheet", "play.strokeChip"]);

const DEVICES = [
  { name: "iPhone 15", engine: webkit, device: devices["iPhone 15"] },
  { name: "iPhone SE", engine: webkit, device: devices["iPhone SE"] },
  { name: "Pixel 7", engine: chromium, device: devices["Pixel 7"] },
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

export function fivePoints(c) {
  const cx = c.x + c.w / 2;
  const cy = c.y + c.h / 2;
  return [
    { name: "center", x: cx, y: cy },
    { name: "left15", x: c.x + 0.15 * c.w, y: cy },
    { name: "right15", x: c.x + 0.85 * c.w, y: cy },
    { name: "top15", x: cx, y: c.y + 0.15 * c.h },
    { name: "bottom15", x: cx, y: c.y + 0.85 * c.h },
  ];
}

async function toPage(page, gx, gy) {
  const box = await page.locator("#game canvas").boundingBox();
  if (!box) throw new Error("canvas not found");
  const scale = Math.min(box.width / LOGICAL_W, box.height / LOGICAL_H);
  const ox = box.x + (box.width - LOGICAL_W * scale) / 2;
  const oy = box.y + (box.height - LOGICAL_H * scale) / 2;
  return { x: ox + gx * scale, y: oy + gy * scale };
}

async function realTap(page, gx, gy) {
  const p = await toPage(page, gx, gy);
  await page.touchscreen.tap(p.x, p.y);
}

const pd = (page, fn, arg) => page.evaluate(fn, arg);
const scenes = (page) => pd(page, () => window.__pd.activeScenes());
const controls = (page) => pd(page, () => window.__pd.controls());
const control = async (page, id) => (await controls(page)).find((c) => c.id === id) ?? null;

async function waitFor(page, pred, ms) {
  const start = Date.now();
  for (;;) {
    if (await pred()) return true;
    if (Date.now() - start > ms) return false;
    await page.waitForTimeout(30);
  }
}

async function waitScene(page, key, ms = 3000) {
  const ok = await waitFor(page, async () => (await scenes(page)).includes(key), ms);
  if (!ok) throw new Error(`setup: scene ${key} not active (got ${(await scenes(page)).join(",")})`);
}

async function waitControl(page, id, ms = 3000) {
  const ok = await waitFor(page, async () => !!(await control(page, id)), ms);
  if (!ok) throw new Error(`setup: control ${id} not present`);
}

async function snapshot(page) {
  return pd(page, () => ({
    scenes: window.__pd.activeScenes(),
    save: window.__pd.save(),
    playCreates: window.__pd.createCount("Play"),
    holeIndex: window.__pd.holeIndex(),
    paused: window.__pd.isPaused(),
    toastAt: window.__pd.lastToast()?.at ?? 0,
    ids: window.__pd.controls().map((c) => c.id),
  }));
}

// ---- outcome checks: (before, after) => true when the expected effect happened ----
const toScene = (key) => (b, a) => a.scenes.includes(key) && !b.scenes.includes(key);
const toPlay = (holeIndex) => (b, a) =>
  a.scenes.includes("Play") && a.playCreates > b.playCreates && (holeIndex === undefined || a.holeIndex === holeIndex) && !a.paused;
const flips = (key) => (b, a) => b.save && a.save && a.save.settings[key] === !b.save.settings[key];
const toast = () => (b, a) => a.toastAt > b.toastAt;
const idAppears = (id) => (b, a) => !b.ids.includes(id) && a.ids.includes(id);
const unpaused = () => (b, a) => b.paused && !a.paused && a.scenes.includes("Play");
const paused = () => (b, a) => !b.paused && a.paused;
const sheetClosedNoReset = () => (b, a) =>
  !a.ids.includes("settings.reset.cancel") && a.scenes.includes("Settings") &&
  JSON.stringify(a.save.holes) === JSON.stringify(b.save.holes);
const sheetClosedReset = () => (b, a) =>
  !a.ids.includes("settings.reset.confirm") && a.scenes.includes("Settings") &&
  b.save.holes.some((h) => h.attempts > 0) && a.save.holes.every((h) => h.attempts === 0 && h.best === undefined);

// ---- screens: setup reaches the screen (hooks allowed), then each control is tapped ----
async function freshSave(page) {
  await pd(page, () => window.__pd.resetSave());
  await page.waitForTimeout(50);
}

const SCREENS = [
  {
    name: "Menu",
    scene: "Menu",
    async setup(page) {
      await freshSave(page);
      await pd(page, () => window.__pd.goto("Menu"));
      await waitScene(page, "Menu");
      await waitControl(page, "menu.play");
    },
    expect: {
      "menu.play": toPlay(0),
      "menu.holes": toScene("LevelSelect"),
      "menu.settings": toScene("Settings"),
    },
  },
  {
    name: "Holes",
    scene: "LevelSelect",
    async setup(page) {
      await freshSave(page);
      await pd(page, () => window.__pd.goto("LevelSelect"));
      await waitScene(page, "LevelSelect");
      await waitControl(page, "holes.back");
    },
    expect: (id) => {
      if (id === "holes.back") return toScene("Menu");
      if (id === "holes.play") return toPlay(0);
      if (id === "holes.unlock") return toScene("Unlock");
      const m = /^holes\.card\.(\d+)$/.exec(id);
      // Fresh save is not unlocked: paid cards 13+ open the Unlock offer (screens.md section 4).
      if (m) return Number(m[1]) > 12 ? toScene("Unlock") : toPlay(Number(m[1]) - 1);
      return null;
    },
    // holes.unlock is a fixed footer button (A-120) outside the scroll viewport; only cards scroll.
    scrollable: (id) => id.startsWith("holes.card."),
  },
  {
    name: "Settings",
    scene: "Settings",
    async setup(page) {
      await freshSave(page);
      await pd(page, () => window.__pd.goto("Settings"));
      await waitScene(page, "Settings");
      await waitControl(page, "settings.back");
    },
    expect: {
      "settings.back": toScene("Menu"),
      "settings.done": toScene("Menu"),
      "settings.toggle.sound": flips("sound"),
      "settings.toggle.music": flips("music"),
      "settings.toggle.vibration": flips("vibration"),
      "settings.toggle.reducedMotion": flips("reducedMotion"),
      "settings.toggle.colorblind": flips("colorblindAim"),
      "settings.reset": idAppears("settings.reset.confirm"),
    },
  },
  {
    name: "Settings reset sheet",
    scene: "Settings",
    only: (id) => id.startsWith("settings.reset."),
    async setup(page) {
      await freshSave(page);
      // Give the save some progress so Reset has something to clear.
      await pd(page, () => {
        const s = window.__pd.save();
        const holes = s.holes.map((h, i) => (i < 3 ? { ...h, attempts: 2, best: 3 } : h));
        window.__pd.setSave({ holes });
      });
      await pd(page, () => window.__pd.goto("Settings"));
      await waitScene(page, "Settings");
      await waitControl(page, "settings.reset");
      // Opening the sheet is itself a real tap (and is verified).
      const reset = await control(page, "settings.reset");
      await realTap(page, reset.x + reset.w / 2, reset.y + reset.h / 2);
      await waitControl(page, "settings.reset.confirm");
      await page.waitForTimeout(250); // sheet slide-in is decoration; hit areas are final already
    },
    expect: {
      "settings.reset.cancel": sheetClosedNoReset(),
      "settings.reset.confirm": sheetClosedReset(),
    },
  },
  {
    name: "Unlock",
    scene: "Unlock",
    async setup(page) {
      await freshSave(page);
      await pd(page, () => window.__pd.goto("Unlock"));
      await waitScene(page, "Unlock");
      await waitControl(page, "unlock.restore");
    },
    expect: {
      "unlock.back": toScene("LevelSelect"),
      "unlock.purchase": toast(),
      "unlock.restore": toast(),
      "unlock.keepPlaying": toScene("LevelSelect"),
    },
  },
  {
    name: "Unlock success",
    scene: "Unlock",
    async setup(page) {
      await freshSave(page);
      await pd(page, () => window.__pd.forceUnlockState("success"));
      await waitScene(page, "Unlock");
      await waitControl(page, "unlock.success.holes");
    },
    expect: {
      "unlock.back": toScene("LevelSelect"),
      // 36-hole build: hole 13 exists, so the primary is "Play hole 13" (screens.md section 10).
      "unlock.success.play": toPlay(12),
      "unlock.success.holes": toScene("LevelSelect"),
    },
  },
  {
    name: "Play HUD",
    scene: "Play",
    only: (id) => id.startsWith("play."),
    async setup(page) {
      await freshSave(page);
      await pd(page, () => window.__pd.play(0));
      await waitScene(page, "Play");
      await waitControl(page, "play.pause");
    },
    expect: { "play.pause": paused() },
  },
  {
    name: "Pause",
    scene: "Play",
    only: (id) => id.startsWith("pause."),
    async setup(page) {
      await freshSave(page);
      await pd(page, () => window.__pd.play(0));
      await waitScene(page, "Play");
      await waitControl(page, "play.pause");
      await pd(page, () => window.__pd.openPause());
      await waitControl(page, "pause.resume");
      await page.waitForTimeout(250);
    },
    expect: {
      "pause.resume": unpaused(),
      "pause.restart": toPlay(0),
      "pause.holes": toScene("LevelSelect"),
      // Pause sheet per screens.md section 7: Resume, Restart, Holes, Settings, Close (no toggle rows).
      "pause.settings": toScene("Settings"),
      "pause.close": unpaused(),
    },
  },
  {
    name: "Result card",
    scene: "Play",
    only: (id) => id.startsWith("result."),
    async setup(page) {
      await freshSave(page);
      await pd(page, () => window.__pd.play(0));
      await waitScene(page, "Play");
      await waitControl(page, "play.pause");
      await pd(page, () => window.__pd.forceResult(2));
      await waitControl(page, "result.next");
      await page.waitForTimeout(250);
    },
    expect: {
      "result.next": toPlay(1),
      "result.retry": toPlay(0),
      "result.holes": toScene("LevelSelect"),
    },
  },
];

function expectationFor(screen, id) {
  if (typeof screen.expect === "function") return screen.expect(id);
  return screen.expect[id] ?? null;
}

/** Scroll the hole grid with a real drag until every tap point of `id` is inside the viewport. */
async function scrollIntoView(page, id) {
  for (let i = 0; i < 8; i++) {
    const c = await control(page, id);
    if (!c) throw new Error(`setup: ${id} vanished while scrolling`);
    const pts = fivePoints(c);
    const minY = Math.min(...pts.map((p) => p.y));
    const maxY = Math.max(...pts.map((p) => p.y));
    if (minY >= GRID_TOP + 6 && maxY <= GRID_BOTTOM - 6) return;
    // Center the card in the viewport; always drag well past the 8 px scroll threshold so the
    // gesture is a scroll, never a tap.
    let dy = (minY + maxY) / 2 - (GRID_TOP + GRID_BOTTOM) / 2;
    if (Math.abs(dy) < 20) dy = dy >= 0 ? 20 : -20;
    const step = Math.max(-200, Math.min(200, dy));
    const a = await toPage(page, 180, step > 0 ? 440 : 160);
    const b = await toPage(page, 180, (step > 0 ? 440 : 160) - step);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(60);
  }
  throw new Error(`setup: could not scroll ${id} into the grid viewport`);
}

async function runDevice(dev, baseUrl) {
  const browser = await launchBrowser(dev.engine, { headless: true });
  const context = await browser.newContext({ ...dev.device });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  // The game module can still be starting after networkidle (seen on WebKit): wait for the test hooks to exist
  // before asking for scenes. The Menu must still be active within the same 5 s budget.
  const loadStart = Date.now();
  await page.waitForFunction(() => typeof window.__pd?.activeScenes === "function", null, { timeout: 5000 });
  await waitScene(page, "Menu", Math.max(0, 5000 - (Date.now() - loadStart)));
  await page.waitForFunction(() => window.__pd.fontsReady(), null, { timeout: 5000 }).catch(() => {});

  const rows = [];
  for (const screen of SCREENS) {
    try {
      await screen.setup(page);
    } catch (e) {
      rows.push({ device: dev.name, screen: screen.name, id: "(setup)", pass: 0, total: 1, note: e.message });
      continue;
    }
    const ids = (await controls(page))
      .filter((c) => c.scene === screen.scene)
      .map((c) => c.id)
      .filter((id) => (screen.only ? screen.only(id) : true))
      .filter((id) => !(screen.name === "Settings" && id.startsWith("settings.reset.")));
    for (const id of ids) {
      if (NON_BUTTONS.has(id)) {
        rows.push({ device: dev.name, screen: screen.name, id, pass: 0, total: 0, note: "region, not a button" });
        continue;
      }
      const check = expectationFor(screen, id);
      if (!check) {
        rows.push({ device: dev.name, screen: screen.name, id, pass: 0, total: 5, note: "UNTESTED: no expected outcome defined" });
        continue;
      }
      let pass = 0;
      const fails = [];
      for (let i = 0; i < 5; i++) {
        try {
          await screen.setup(page);
          if (screen.scrollable?.(id)) await scrollIntoView(page, id);
          const c = await control(page, id);
          if (!c) throw new Error("control missing after setup");
          const pt = fivePoints(c)[i];
          const before = await snapshot(page);
          await realTap(page, pt.x, pt.y);
          let after = before;
          const ok = await waitFor(page, async () => {
            after = await snapshot(page);
            return check(before, after);
          }, OUTCOME_MS);
          if (ok) pass++;
          else fails.push(`${pt.name}@(${pt.x.toFixed(1)},${pt.y.toFixed(1)}) -> scenes [${after.scenes.join(",")}]${after.paused ? " paused" : ""}`);
        } catch (e) {
          fails.push(`point ${i}: ${e.message}`);
        }
      }
      rows.push({ device: dev.name, screen: screen.name, id, pass, total: 5, note: fails.join("; ") });
    }
  }
  if (pageErrors.length) rows.push({ device: dev.name, screen: "-", id: "pageerror", pass: 0, total: 1, note: pageErrors.join(" | ") });
  await browser.close();
  return rows;
}

async function main() {
  if (!fs.existsSync(path.join(buildDir, "index.html"))) {
    console.error("taps-strict: build/test missing; run `npm run build:test`");
    process.exit(1);
  }
  const port = await freePort();
  const preview = spawnPreview(
    "npx",
    ["vite", "preview", "--outDir", "build/test", "--port", String(port), "--strictPort"],
    { cwd: root, stdio: "pipe", env: { ...process.env, BROWSER: "none" } }
  );
  try {
    await waitForHttp(`http://127.0.0.1:${port}/`);
    const baseUrl = `http://127.0.0.1:${port}/`;
    const results = await Promise.all(DEVICES.map((d) => runDevice(d, baseUrl)));
    const rows = results.flat();

    const pad = (s, n) => String(s).padEnd(n);
    console.log(`${pad("device", 10)} ${pad("screen", 21)} ${pad("control", 30)} result`);
    console.log("-".repeat(80));
    let failed = 0;
    for (const r of rows) {
      const ok = r.total === 0 || r.pass === r.total;
      if (!ok) failed++;
      const res = r.total === 0 ? `n/a (${r.note})` : `${r.pass}/${r.total} ${ok ? "PASS" : "FAIL"}`;
      console.log(`${pad(r.device, 10)} ${pad(r.screen, 21)} ${pad(r.id, 30)} ${res}`);
      if (!ok && r.note) console.log(`           ${r.note}`);
    }
    console.log("-".repeat(80));
    for (const d of DEVICES) {
      const mine = rows.filter((r) => r.device === d.name && r.total > 0);
      const taps = mine.reduce((s, r) => s + r.total, 0);
      const ok = mine.reduce((s, r) => s + r.pass, 0);
      console.log(`${pad(d.name, 10)} ${ok}/${taps} taps passed (${mine.length} controls)`);
    }
    if (failed) {
      console.error(`taps-strict: FAIL (${failed} control row(s) failed)`);
      process.exitCode = 1;
    } else {
      console.log("taps-strict: ok");
    }
  } finally {
    preview.kill("SIGTERM");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
