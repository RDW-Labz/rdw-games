// Course/putt/reaction/celebration captures on WebKit iPhone 15 and Chromium Pixel 7.
//
// Every shot is played with REAL touch input (Chromium: CDP Input.dispatchTouchEvent; WebKit: trusted-path
// TouchEvents on the canvas, since Playwright WebKit has no touch-drag API) through the game's own input
// handling. Shots are chosen by searching the read-only simulation preview for the exact quantized touch
// vector, so the captured state really happens. Each capture arms a probe that pauses the game loop on the
// first rendered frame where the named state is visible (e.g. squash > 3%, both splash rings + droplets,
// the drop clone 30-75% sunk), screenshots it, prints the probe state, then resumes.
//
// Usage: node scripts/capture-course.mjs [--no-build]
import { chromium, webkit, devices } from "playwright";
import { spawn, execSync } from "node:child_process";
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

async function screenMap(page) {
  const box = await page.locator("#game canvas").boundingBox();
  const s = Math.min(box.width / 360, box.height / 640);
  return { x: box.x + (box.width - 360 * s) / 2, y: box.y + (box.height - 640 * s) / 2, s };
}

async function makeToucher(kind, page, context) {
  if (kind === "cdp") {
    const cdp = await context.newCDPSession(page);
    return {
      down: (x, y) => cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] }),
      move: (x, y) => cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y, id: 1 }] }),
      up: () => cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }),
    };
  }
  const fire = (type, x, y) =>
    page.evaluate(
      ({ type, x, y }) => {
        const canvas = document.querySelector("#game canvas");
        const t = document.createTouch(window, canvas, 1, x, y, x, y);
        const live = type === "touchend" ? document.createTouchList() : document.createTouchList(t);
        canvas.dispatchEvent(
          new TouchEvent(type, { touches: live, targetTouches: live, changedTouches: document.createTouchList(t), bubbles: true, cancelable: true })
        );
      },
      { type, x, y }
    );
  let last = [0, 0];
  return {
    down: (x, y) => ((last = [x, y]), fire("touchstart", x, y)),
    move: (x, y) => ((last = [x, y]), fire("touchmove", x, y)),
    up: () => fire("touchend", last[0], last[1]),
  };
}

async function play(page, hole, save) {
  await page.evaluate(
    ({ hole, save }) => {
      window.__pd.resetSave();
      if (save) window.__pd.setSave(save);
      window.__pd.play(hole);
    },
    { hole, save }
  );
  await page.waitForFunction(
    (h) => (window.__pd?.activeScenes?.() ?? []).includes("Play") && window.__pdCourse?.level?.().id === `hole${String(h + 1).padStart(2, "0")}`,
    hole,
    { timeout: 8000 }
  );
  // __pd.play starts Play on top of a still-running Menu; stop it like real navigation would.
  await page.evaluate(() => window.__pdCourse.isolate());
  await page.waitForTimeout(600);
}

/**
 * Searches the simulation for a shot whose QUANTIZED touch vector (integer CSS px, as the drag will
 * really be dispatched) satisfies `want`. Returns CSS start/end points.
 */
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
        // Effective drag exactly as the game will see it: (down - up) in UI px, / q -> world.
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
            (want === "holed" && r.holed && !ev.includes("water")) ||
            (want === "water" && ev.includes("water")) ||
            (want === "sand" && ev.includes("sand-enter") && !ev.includes("water") && !r.holed) ||
            (want === "fastTurf" && ev.includes("fast-turf-enter") && !ev.includes("water") && !r.holed) ||
            (want === "wicket" && ev.includes("one-way-hit") && !ev.includes("water") && !r.holed) ||
            (want === "wall" &&
              // a firm side-rail bank: first event is a rail hit, angled away from the straight line,
              // and the ball keeps rolling well after it (mid-roll capture)
              ev[0] === "wall-hit" &&
              Math.abs(Math.atan2(Math.sin(s.angle - base), Math.cos(s.angle - base))) > 0.25 &&
              ev.filter((e) => e === "wall-hit").length >= 2 &&
              !ev.includes("water") &&
              !r.holed);
          if (ok) return { sx, sy, ex: s.ex, ey: s.ey, angle: s.angle, power: s.power, events: ev.slice(0, 8) };
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
    await toucher.move(Math.round(shot.sx + ((shot.ex - shot.sx) * i) / steps), Math.round(shot.sy + ((shot.ey - shot.sy) * i) / steps));
  }
  await page.waitForTimeout(holdMs);
  await toucher.up();
}

async function arm(page, name) {
  await page.evaluate((n) => window.__pdCourse.freezeOn(n), name);
}

/** Zoomed crop (CSS px box of `size`) around a UI point of the frozen frame, for small effects. */
async function zoom(page, file, ui, size = 56) {
  const map = await screenMap(page);
  const cx = map.x + ui[0] * map.s;
  const cy = map.y + ui[1] * map.s;
  await page.screenshot({ path: file, clip: { x: cx - size / 2, y: cy - size / 2, width: size, height: size } });
}

async function captureFrozen(page, file, name, timeout = 6000, zoomAt = null) {
  try {
    await page.waitForFunction((n) => window.__pdCourse.frozen() === n, name, { timeout });
  } catch (e) {
    const st = await page.evaluate(() => ({ s: window.__pdCourse.state(), b: window.__pdCourse.ball() }));
    throw new Error(`state "${name}" never became visible: ${JSON.stringify(st)}`);
  }
  const state = await page.evaluate(() => window.__pdCourse.state());
  await page.screenshot({ path: file });
  if (zoomAt) await zoom(page, file.replace(/\.png$/, "-zoom.png"), state[zoomAt]);
  await page.evaluate(() => window.__pdCourse.wake());
  return state;
}

function summarize(st) {
  return JSON.stringify({
    phase: st.phase,
    hud: st.hudStrokes,
    power: st.powerText,
    hint: st.powerHint,
    aim: st.aimShown,
    squash: +st.squash.toFixed(3),
    fx: `${st.lastFx.kind}@${Math.round(st.lastFx.age)}ms`,
    splash: st.splash,
    particles: st.liveParticles,
    drop: +st.dropProgress.toFixed(2),
    flag: +st.flagAngle.toFixed(2),
    leaves: st.leaves,
    hintVisible: st.hintVisible,
    reduced: st.reduced,
    next: st.nextLabel,
  });
}

async function runSession(browserType, deviceName, slug, touchKind, baseUrl) {
  const browser = browserType === "webkit" ? await launchBrowser(webkit) : await launchBrowser(chromium);
  const context = await browser.newContext({ ...devices[deviceName] });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const file = (n) => path.join(outDir, `course-${slug}-${n}.png`);
  const log = (n, st) => console.log(`${slug} ${n}: ${typeof st === "string" ? st : summarize(st)}`);
  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.__pd?.fontsReady?.(), { timeout: 10000 });
    const toucher = await makeToucher(touchKind, page, context);
    // World intro hints (holes 13/25) are captured on purpose in step 12 only.
    const seen = { firstPuttTutorialSeen: true, fastTurfIntroSeen: true, wicketIntroSeen: true };

    // 1. Hole 1 idle.
    await play(page, 0, seen);
    await page.waitForTimeout(300);
    await page.screenshot({ path: file("hole1-idle") });
    log("hole1-idle", await page.evaluate(() => window.__pdCourse.state()));

    // 2. Aiming at 70%: hold a real touch drag straight back from the ball.
    {
      const map = await screenMap(page);
      const { f, ball } = await page.evaluate(() => ({ f: window.__pdCourse.frame(), ball: window.__pdCourse.ballUi() }));
      const sx = Math.round(map.x + ball[0] * map.s);
      const sy = Math.round(map.y + ball[1] * map.s);
      const len = 0.7 * 160 * f.q * map.s;
      // Aim up-left a little so the guide shows a bank; finger goes the opposite way.
      const a = -Math.PI / 2 - 0.12;
      await arm(page, "aim70");
      await toucher.down(sx, sy);
      for (let i = 1; i <= 10; i++) await toucher.move(Math.round(sx - Math.cos(a) * len * (i / 10)), Math.round(sy - Math.sin(a) * len * (i / 10)));
      log("aim-70", await captureFrozen(page, file("aim-70"), "aim70"));
      await toucher.up();
    }

    // 3. Mid-roll right after a wall hit (squash visible).
    await play(page, 0, seen);
    {
      const shot = await findShot(page, "wall", { pMin: 0.6, pMax: 0.9 });
      if (!shot) throw new Error("no wall shot found");
      await arm(page, "squash");
      await putt(page, toucher, shot);
      log("wall-squash", await captureFrozen(page, file("wall-squash"), "squash", 6000, "ballUi"));
    }

    // 4. Water splash on hole 5.
    await play(page, 4, seen);
    {
      const shot = await findShot(page, "water", { pMin: 0.3, pMax: 0.8 });
      if (!shot) throw new Error("no water shot found on hole 5");
      console.log(`water shot ${JSON.stringify(shot)}`);
      await arm(page, "splash");
      await putt(page, toucher, shot);
      log("water-splash", await captureFrozen(page, file("water-splash"), "splash", 6000, "lastFxUi"));
      await page.waitForTimeout(500);
      await page.screenshot({ path: file("water-reset") });
      log("water-reset", await page.evaluate(() => window.__pdCourse.state()));
    }

    // 5. Sand puff (hole 3, Sand Pear).
    await play(page, 2, seen);
    {
      const shot = await findShot(page, "sand", { pMin: 0.4, pMax: 1.0 });
      if (!shot) throw new Error("no sand shot found on hole 3");
      await arm(page, "sandPuff");
      await putt(page, toucher, shot);
      log("sand-puff", await captureFrozen(page, file("sand-puff"), "sandPuff", 6000, "lastFxUi"));
    }

    // 6-8. Cup drop mid-animation, flag wiggle, celebration card (one holing shot each, hole 1).
    for (const [name, cond] of [
      ["cup-drop", "cupDrop"],
      ["flag-wiggle", "flagWiggle"],
      ["celebration", "celebration"],
    ]) {
      await play(page, 0, seen);
      const shot = await findShot(page, "holed", { pMin: 0.3, pMax: 1.0 });
      if (!shot) throw new Error("no holing shot found on hole 1");
      await arm(page, cond);
      await putt(page, toucher, shot);
      log(name, await captureFrozen(page, file(name), cond, 9000, name === "celebration" ? null : "cupUi"));
    }

    // 9. First-time hint (fresh save, idle 1800ms, ghost hand mid-drag).
    await play(page, 0, null);
    await arm(page, "hint");
    log("hint", await captureFrozen(page, file("hint"), "hint", 8000));

    // 10. Fast turf streak on hole 13.
    await play(page, 12, seen);
    await page.screenshot({ path: file("fast-turf-idle") });
    log("fast-turf-idle", await page.evaluate(() => window.__pdCourse.state()));
    {
      const shot = await findShot(page, "fastTurf", { pMin: 0.35, pMax: 1.0 });
      if (!shot) throw new Error("no fast-turf shot found on hole 13");
      await arm(page, "turfStreak");
      await putt(page, toucher, shot);
      log("fast-turf-streak", await captureFrozen(page, file("fast-turf-streak"), "turfStreak", 6000, "ballUi"));
    }

    // 11. Wicket hit on hole 25.
    await play(page, 24, seen);
    {
      const shot = await findShot(page, "wicket", { pMin: 0.3, pMax: 1.0 });
      if (!shot) throw new Error("no wicket shot found on hole 25");
      await arm(page, "wicketHit");
      await putt(page, toucher, shot);
      log("wicket-hit", await captureFrozen(page, file("wicket-hit"), "wicketHit", 6000, "lastFxUi"));
    }

    // 12. World mechanic hint (hole 13, fresh save flag).
    await play(page, 12, { ...seen, fastTurfIntroSeen: false });
    await arm(page, "mechanicHint");
    log("mechanic-hint-fast", await captureFrozen(page, file("mechanic-hint-fast"), "mechanicHint", 8000));
    await play(page, 24, { ...seen, wicketIntroSeen: false });
    await arm(page, "mechanicHint");
    log("mechanic-hint-wicket", await captureFrozen(page, file("mechanic-hint-wicket"), "mechanicHint", 8000));

    // 13. Reduced-motion celebration.
    await play(page, 0, { ...seen, settings: { reducedMotion: true } });
    {
      const shot = await findShot(page, "holed", { pMin: 0.3, pMax: 1.0 });
      if (!shot) throw new Error("no holing shot found (reduced motion)");
      await arm(page, "cardSettled");
      await putt(page, toucher, shot);
      log("celebration-reduced", await captureFrozen(page, file("celebration-reduced"), "cardSettled", 9000));
    }
  } finally {
    await browser.close();
  }
  if (errors.length) throw new Error(`${slug} page errors: ${errors.join("; ")}`);
}

async function main() {
  if (!process.argv.includes("--no-build")) {
    execSync("npx vite build --mode test --outDir build/test", { cwd: root, stdio: "ignore" });
  }
  fs.mkdirSync(outDir, { recursive: true });
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}/?test`;
  const preview = spawnPreview("npx", ["vite", "preview", "--outDir", "build/test", "--port", String(port), "--strictPort"], {
    cwd: root,
    stdio: "pipe",
    env: { ...process.env, BROWSER: "none" },
  });
  try {
    await waitForHttp(`http://127.0.0.1:${port}/`);
    await runSession("webkit", "iPhone 15", "webkit-iphone15", "synthetic", baseUrl);
    await runSession("chromium", "Pixel 7", "chromium-pixel7", "cdp", baseUrl);
  } finally {
    preview.kill("SIGTERM");
  }
  console.log("course captures: test-results/course-*.png");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
