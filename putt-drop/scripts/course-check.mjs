// Course alignment check: the rendered course art, ball, cup and rails must sit exactly where the
// simulation says they are, at every render scale, and touch input must map through the same transform.
//
// Builds a test bundle (`npx vite build --mode test --outDir build/test`), serves build/test, and for
// holes 1, 5, 9, 12 on WebKit iPhone 15 (R=3), Chromium Pixel 7 (R=2.625), a 360x640 desktop viewport
// (R=1) and the same viewport at 2x (R=2) samples SCREENSHOT pixels at points computed from level data:
//   cup centre = cup dark colour; 3 points on the outer wall = rail colours; tee = ball white;
//   a turf point near the tee = turf green.
// Then holds a real touch/mouse drag at 50% power and checks the power readout, then releases and
// checks the ball travels in the drag-back direction.
// Usage: node scripts/course-check.mjs [--no-build]   Exit 1 with messages on any failure.
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

// Colours from src/ui/tokens.ts (course art).
const COL = {
  cupDeep: [0x20, 0x34, 0x28],
  rail: [0xfa, 0xf1, 0xd7],
  railHighlight: [0xff, 0xfd, 0xf4],
  railUnder: [0xb4, 0x9a, 0x71],
  turfTop: [0xb3, 0xd2, 0x8b],
  turfBottom: [0x87, 0xb3, 0x6f],
  dewFill: [0xe1, 0xf9, 0xff],
  wicketCoral: [0xf5, 0x8e, 0x6c],
};
const HOLES = [0, 4, 8, 11, 12, 17, 23, 24, 29, 35];

const CONFIGS = [
  { name: "webkit-iphone15", type: webkit, ctx: { ...devices["iPhone 15"] }, touch: "synthetic" },
  { name: "chromium-pixel7", type: chromium, ctx: { ...devices["Pixel 7"] }, touch: "cdp" },
  { name: "webkit-iphoneSE", type: webkit, ctx: { ...devices["iPhone SE"] }, touch: "synthetic" },
  { name: "chromium-360x640-r1", type: chromium, ctx: { viewport: { width: 360, height: 640 }, deviceScaleFactor: 1 }, touch: "mouse" },
  { name: "chromium-360x640-r2", type: chromium, ctx: { viewport: { width: 360, height: 640 }, deviceScaleFactor: 2 }, touch: "mouse" },
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

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const hex = (c) => `rgb(${c.join(",")})`;

function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToSeg(px, py, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l2));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

function polyArea(p) {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i];
    const [x2, y2] = p[(i + 1) % p.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a / 2);
}

function outlineOf(level) {
  let best = null;
  for (const w of level.walls) {
    if (!w.closed || w.points.length < 3) continue;
    if (!best || polyArea(w.points) > polyArea(best)) best = w.points;
  }
  return best;
}

/** Three points on the outer wall centreline, spread around the perimeter, away from the flag/cup. */
function railPoints(level) {
  const pts = outlineOf(level);
  const segs = pts.map((a, i) => [a, pts[(i + 1) % pts.length]]);
  const lens = segs.map(([a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1]));
  const total = lens.reduce((s, l) => s + l, 0);
  const out = [];
  const fractions = [0.13, 0.29, 0.46, 0.63, 0.79, 0.94];
  for (const f of fractions) {
    let d = f * total;
    for (let i = 0; i < segs.length; i++) {
      if (d > lens[i]) {
        d -= lens[i];
        continue;
      }
      // Stay at least 6 world units from a vertex (joins) and 50 from the cup/flag.
      if (d < 6 || lens[i] - d < 6) break;
      const [a, b] = segs[i];
      const t = d / lens[i];
      const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      if (Math.hypot(p[0] - level.cup[0], p[1] - level.cup[1]) < 50) break;
      // Not under a mover, bumper, wicket post or other wall.
      const blocked =
        level.bumpers.some((bp) => Math.hypot(p[0] - bp.x, p[1] - bp.y) < bp.r + 10) ||
        level.movers.some((m) => distToSeg(p[0], p[1], m.from, m.to) < m.width / 2 + 10) ||
        (level.oneWayGates ?? []).some((g) => [g.from, g.to].some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 5 + 10));
      if (!blocked) out.push(p);
      break;
    }
    if (out.length === 3) break;
  }
  return out;
}

/** A turf point near the tee: inside the outline, clear of hazards, rails, tee ring, ball and cup. */
function turfPoint(level) {
  const outline = outlineOf(level);
  const [tx, ty] = level.tee;
  for (const r of [24, 30, 36, 20]) {
    for (let k = 0; k < 16; k++) {
      const a = -Math.PI / 2 + (k * Math.PI) / 8;
      const x = tx + Math.cos(a) * r;
      const y = ty + Math.sin(a) * r;
      if (!pointInPoly(x, y, outline)) continue;
      // Base turf only: fast-turf patches are probed separately with their own colour.
      const zones = [...level.sand, ...level.water, ...level.slopes, ...(level.fastTurf ?? [])];
      if (zones.some((z) => pointInPoly(x, y, z.poly))) continue;
      // Keep 8 world units from every hazard/slope edge (antialiased borders, soft bands).
      const edgeD = Math.min(Infinity, ...zones.flatMap((z) => z.poly.map((a, i) => distToSeg(x, y, a, z.poly[(i + 1) % z.poly.length]))));
      if (edgeD < 8) continue;
      let wallD = Infinity;
      for (const w of level.walls) {
        const n = w.points.length;
        for (let i = 0; i < (w.closed ? n : n - 1); i++) wallD = Math.min(wallD, distToSeg(x, y, w.points[i], w.points[(i + 1) % n]));
      }
      if (wallD < 14) continue;
      if (level.bumpers.some((b) => Math.hypot(x - b.x, y - b.y) < b.r + 10)) continue;
      if (level.movers.some((m) => distToSeg(x, y, m.from, m.to) < m.width / 2 + 12)) continue;
      return [x, y];
    }
  }
  return null;
}

function polyBounds(poly) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p[0]);
    minY = Math.min(minY, p[1]);
    maxX = Math.max(maxX, p[0]);
    maxY = Math.max(maxY, p[1]);
  }
  return { minX, minY, maxX, maxY };
}

/** Clear of hazards, slopes, walls, bumpers, movers, wickets, tee and cup (antialiased edges, overlays). */
function clearOfEverything(level, x, y) {
  const zones = [...level.sand, ...level.water, ...level.slopes];
  if (zones.some((z) => pointInPoly(x, y, z.poly))) return false;
  const edgeD = Math.min(Infinity, ...zones.flatMap((z) => z.poly.map((a, i) => distToSeg(x, y, a, z.poly[(i + 1) % z.poly.length]))));
  if (edgeD < 8) return false;
  for (const w of level.walls) {
    const n = w.points.length;
    for (let i = 0; i < (w.closed ? n : n - 1); i++) if (distToSeg(x, y, w.points[i], w.points[(i + 1) % n]) < 14) return false;
  }
  if (level.bumpers.some((b) => Math.hypot(x - b.x, y - b.y) < b.r + 10)) return false;
  if (level.movers.some((m) => distToSeg(x, y, m.from, m.to) < m.width / 2 + 12)) return false;
  if ((level.oneWayGates ?? []).some((g) => distToSeg(x, y, g.from, g.to) < 24)) return false;
  if (Math.hypot(x - level.tee[0], y - level.tee[1]) < 20) return false;
  if (Math.hypot(x - level.cup[0], y - level.cup[1]) < 30) return false;
  return true;
}

/** A fast-turf point: inside a patch, 8+ units from its edge, clear of everything drawn above it. */
function fastTurfPoint(level) {
  let best = null;
  (level.fastTurf ?? []).forEach((z) => {
    const b = polyBounds(z.poly);
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    for (let y = b.minY; y <= b.maxY; y += 3) {
      for (let x = b.minX; x <= b.maxX; x += 3) {
        if (!pointInPoly(x, y, z.poly)) continue;
        const edge = Math.min(...z.poly.map((a, i) => distToSeg(x, y, a, z.poly[(i + 1) % z.poly.length])));
        if (edge < 8 || !clearOfEverything(level, x, y)) continue;
        const d = Math.hypot(x - cx, y - cy);
        if (!best || d < best.d) best = { d, p: [x, y] };
      }
    }
  });
  return best?.p ?? null;
}

/**
 * Wicket probes for every gate: a post at its exact `from` endpoint, and the centres of the coral
 * dashes (pattern [5,4] from `from`) at least 9 units from either post.
 */
function wicketProbes(level) {
  return (level.oneWayGates ?? []).map((gate, gi) => {
    const [ax, ay] = gate.from;
    const [bx, by] = gate.to;
    const len = Math.hypot(bx - ax, by - ay);
    const dashes = [];
    for (let d = 2.5; d < len; d += 9) {
      if (Math.min(d, len - d) >= 9) dashes.push([ax + ((bx - ax) * d) / len, ay + ((by - ay) * d) / len]);
    }
    return { gi, post: [ax, ay], dashes };
  });
}

async function decoder(context) {
  const page = await context.newPage();
  await page.setContent("<html><body></body></html>");
  return page;
}

/** Reads pixels (device px) from a page screenshot PNG. */
async function samplePixels(decodePage, png, points) {
  const b64 = png.toString("base64");
  return decodePage.evaluate(
    async ({ b64, points }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      return points.map(([x, y]) => Array.from(ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data.slice(0, 3)));
    },
    { b64, points }
  );
}

async function screenMap(page) {
  const box = await page.locator("#game canvas").boundingBox();
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  const s = Math.min(box.width / 360, box.height / 640);
  const ox = box.x + (box.width - 360 * s) / 2;
  const oy = box.y + (box.height - 640 * s) / 2;
  return {
    dpr,
    css: (ux, uy) => [ox + ux * s, oy + uy * s],
    px: (ux, uy) => [(ox + ux * s) * dpr, (oy + uy * s) * dpr],
  };
}

async function makeToucher(cfg, page, context) {
  if (cfg.touch === "cdp") {
    const cdp = await context.newCDPSession(page);
    return {
      down: (x, y) => cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] }),
      move: (x, y) => cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y, id: 1 }] }),
      up: () => cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }),
    };
  }
  if (cfg.touch === "synthetic") {
    const fire = (type, x, y) =>
      page.evaluate(
        ({ type, x, y }) => {
          const canvas = document.querySelector("#game canvas");
          // WebKit has no Touch constructor; document.createTouch builds a real Touch object.
          const t = document.createTouch(window, canvas, 1, x, y, x, y);
          const live = type === "touchend" ? document.createTouchList() : document.createTouchList(t);
          const changed = document.createTouchList(t);
          canvas.dispatchEvent(new TouchEvent(type, { touches: live, targetTouches: live, changedTouches: changed, bubbles: true, cancelable: true }));
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
  return {
    down: async (x, y) => {
      await page.mouse.move(x, y);
      await page.mouse.down();
    },
    move: (x, y) => page.mouse.move(x, y),
    up: () => page.mouse.up(),
  };
}

async function waitPlay(page, hole) {
  await page.evaluate((h) => window.__pd.play(h), hole);
  await page.waitForFunction(
    (h) => (window.__pd?.activeScenes?.() ?? []).includes("Play") && window.__pdCourse?.level?.().id === `hole${String(h + 1).padStart(2, "0")}`,
    hole,
    { timeout: 8000 }
  );
  // __pd.play starts Play on top of a still-running Menu; stop it like real navigation would.
  await page.evaluate(() => window.__pdCourse.isolate());
  await page.waitForTimeout(700); // scene travel (280ms) settles
}

async function runConfig(cfg, errors, notes) {
  const browser = await launchBrowser(cfg.type);
  const context = await browser.newContext(cfg.ctx);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${cfg.name}: pageerror ${e.message}`));
  const dec = await decoder(context);
  try {
    await page.goto(globalThis.baseUrl, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.__pd?.fontsReady?.(), { timeout: 10000 });
    await page.evaluate(() => {
      window.__pd.resetSave();
      window.__pd.setSave({
        firstPuttTutorialSeen: true,
        fastTurfIntroSeen: true,
        wicketIntroSeen: true,
      });
    });
    for (const hole of HOLES) {
      await waitPlay(page, hole);
      const info = await page.evaluate(() => ({ level: window.__pdCourse.level(), frame: window.__pdCourse.frame(), R: window.__pdCourse.renderScale() }));
      const { level, frame, R } = info;
      const w2u = (x, y) => [frame.ox + frame.q * x, frame.oy + frame.q * y];
      const map = await screenMap(page);
      const tag = `${cfg.name} hole ${hole + 1} (${level.name}, R=${R}, q=${frame.q.toFixed(4)})`;
      const probes = [];
      probes.push({ what: "cup centre", world: level.cup, test: (c) => dist(c, COL.cupDeep) <= 30, want: `cup dark ${hex(COL.cupDeep)}` });
      for (const p of railPoints(level)) {
        probes.push({
          what: `outer rail at (${p[0].toFixed(1)},${p[1].toFixed(1)})`,
          world: p,
          test: (c) => Math.min(dist(c, COL.rail), dist(c, COL.railHighlight), dist(c, COL.railUnder)) <= 32,
          want: `rail ${hex(COL.rail)} / ${hex(COL.railHighlight)} / ${hex(COL.railUnder)}`,
        });
      }
      probes.push({ what: "ball at tee", world: level.tee, test: (c) => c.every((v) => v >= 225), want: "ball white (all channels >= 225)" });
      const turf = turfPoint(level);
      if (!turf) errors.push(`${tag}: no clear turf point near the tee`);
      else {
        const tY = Math.max(0, Math.min(1, turf[1] / 640));
        const expect = lerp(COL.turfTop, COL.turfBottom, tY);
        probes.push({
          what: `turf near tee at (${turf[0].toFixed(1)},${turf[1].toFixed(1)})`,
          world: turf,
          test: (c) => c[1] > c[0] + 8 && c[1] > c[2] + 25 && dist(c, expect) <= 40,
          want: `turf green ~${hex(expect.map(Math.round))}`,
        });
      }
      if ((level.fastTurf ?? []).length) {
        const dew = fastTurfPoint(level);
        if (!dew) errors.push(`${tag}: no clear fast-turf probe point`);
        else
          probes.push({
            what: `fast turf at (${dew[0].toFixed(1)},${dew[1].toFixed(1)})`,
            world: dew,
            // Pale dew surface (waterRipple..white), never base turf green or pond blue.
            test: (c) => Math.min(dist(c, COL.dewFill), dist(c, [255, 255, 255])) <= 48 && c[2] >= c[0] - 8,
            want: `dew fill ~${hex(COL.dewFill)}`,
          });
      }
      for (const w of wicketProbes(level)) {
        probes.push({
          what: `wicket ${w.gi} post at (${w.post[0].toFixed(1)},${w.post[1].toFixed(1)})`,
          world: w.post,
          test: (c) => dist(c, COL.rail) <= 32,
          want: `wicket post ${hex(COL.rail)}`,
        });
        if (!w.dashes.length) errors.push(`${tag}: wicket ${w.gi} has no dash clear of its posts`);
        // Dash centres can sit under a direction chevron; at least one must show the coral hoop strip.
        else
          probes.push({
            what: `wicket ${w.gi} hoop strip (${w.dashes.length} dash centres)`,
            anyOf: w.dashes,
            test: (c) => dist(c, COL.wicketCoral) <= 48,
            want: `wicket coral ${hex(COL.wicketCoral)} at one dash centre or more`,
          });
      }
      if (probes.filter((p) => p.what.startsWith("outer rail")).length < 3) errors.push(`${tag}: fewer than 3 rail sample points`);
      const png = await page.screenshot();
      const pts = probes.flatMap((p) => p.anyOf ?? [p.world]);
      const px = pts.map((w) => map.px(...w2u(w[0], w[1])));
      const colors = await samplePixels(dec, png, px);
      let ok = 0;
      let at = 0;
      probes.forEach((p) => {
        const n = p.anyOf ? p.anyOf.length : 1;
        const idx = Array.from({ length: n }, (_, k) => at + k);
        at += n;
        const hit = idx.find((k) => p.test(colors[k]));
        if (hit !== undefined) ok++;
        else {
          const seen = idx.map((k) => `(${px[k].map((v) => v.toFixed(1)).join(",")}) ${hex(colors[k])}`).join("; ");
          errors.push(`${tag}: ${p.what} at screen px ${seen}, expected ${p.want}`);
        }
      });
      notes.push(`${tag}: ${ok}/${probes.length} pixel probes ok`);
      // Whole course inside the play area, below the HUD and above the power card.
      const top = 24 + 64;
      const [, y0] = w2u(0, 0);
      const [, y1] = w2u(0, 640);
      if (y0 < top || y1 > frame.bottomEdge - 64) errors.push(`${tag}: world rect y ${y0}..${y1} overlaps HUD (${top}) or power card (${frame.bottomEdge - 64})`);
    }

    // Input: hold a real drag at 50% (drag vector = 0.5 * 160 world units * q) from the ball, straight down.
    await waitPlay(page, 0);
    const toucher = await makeToucher(cfg, page, context);
    const map = await screenMap(page);
    const { frame, ballUi } = await page.evaluate(() => ({ frame: window.__pdCourse.frame(), ballUi: window.__pdCourse.ballUi() }));
    const dragUi = 0.5 * 160 * frame.q;
    const [sx, sy] = map.css(ballUi[0], ballUi[1]);
    const [ex, ey] = map.css(ballUi[0], ballUi[1] + dragUi);
    await toucher.down(sx, sy);
    for (let i = 1; i <= 8; i++) await toucher.move(sx + ((ex - sx) * i) / 8, sy + ((ey - sy) * i) / 8);
    await page.waitForTimeout(150);
    const held = await page.evaluate(() => window.__pdCourse.state());
    const pct = parseInt(held.powerText, 10);
    if (!held.aimShown || Math.abs(pct - 50) > 2) errors.push(`${cfg.name}: held drag of ${dragUi.toFixed(1)} UI px shows aim=${held.aimShown} power=${held.powerText}, expected ~50%`);
    const before = await page.evaluate(() => window.__pdCourse.ball());
    await toucher.up();
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => ({ ball: window.__pdCourse.ball(), state: window.__pdCourse.state() }));
    const dy = after.ball.y - before.y;
    const dx = after.ball.x - before.x;
    if (after.state.strokes !== 1 || !(dy < -20) || Math.abs(dx) > Math.abs(dy) * 0.2) {
      errors.push(`${cfg.name}: release did not putt straight up (strokes=${after.state.strokes}, moved ${dx.toFixed(1)},${dy.toFixed(1)})`);
    }
    notes.push(`${cfg.name}: input held ${held.powerText} (want 50%), putt moved (${dx.toFixed(1)}, ${dy.toFixed(1)}) world units, HUD "${after.state.hudStrokes}"`);
    if (after.state.hudStrokes !== "1 stroke") errors.push(`${cfg.name}: HUD shows "${after.state.hudStrokes}", expected "1 stroke"`);
    // Pause sheet: open with a real tap on play.pause; every pause.* hit rect is >= 56x56, on screen,
    // inside the sheet, and no two overlap (a tap near one control's edge can never hit another).
    await waitPlay(page, 0);
    const pauseBtn = (await page.evaluate(() => window.__pd.controls())).find((c) => c.id === "play.pause");
    const [px, py] = map.css(pauseBtn.x + pauseBtn.w / 2, pauseBtn.y + pauseBtn.h / 2);
    await toucher.down(px, py);
    await toucher.up();
    await page.waitForTimeout(500);
    const ctrls = (await page.evaluate(() => window.__pd.controls())).filter((c) => c.id.startsWith("pause."));
    const sheet = ctrls.find((c) => c.id === "pause.sheet");
    const btns = ctrls.filter((c) => c.id !== "pause.sheet");
    if (!sheet || btns.length < 5) errors.push(`${cfg.name}: pause sheet not open via real tap (controls: ${ctrls.map((c) => c.id).join(",")})`);
    for (const c of btns) {
      if (c.w < 56 || c.h < 56) errors.push(`${cfg.name}: ${c.id} hit area ${c.w}x${c.h} < 56x56`);
      if (c.x < 0 || c.y < 0 || c.x + c.w > 360 || c.y + c.h > 640) errors.push(`${cfg.name}: ${c.id} off screen ${JSON.stringify(c)}`);
      if (sheet && (c.x < sheet.x - 0.5 || c.y < sheet.y - 0.5 || c.x + c.w > sheet.x + sheet.w + 0.5 || c.y + c.h > sheet.y + sheet.h + 0.5)) errors.push(`${cfg.name}: ${c.id} outside the sheet`);
    }
    for (let i = 0; i < btns.length; i++) {
      for (let j = i + 1; j < btns.length; j++) {
        const a = btns[i];
        const b = btns[j];
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (ox > 0 && oy > 0) errors.push(`${cfg.name}: ${a.id} and ${b.id} hit areas overlap by ${ox.toFixed(1)}x${oy.toFixed(1)}`);
      }
    }
    const rows = btns.filter((c) => c.w > 100).sort((a, b) => a.y - b.y);
    const pitches = rows.slice(1).map((c, i) => (c.y - rows[i].y).toFixed(1));
    notes.push(`${cfg.name}: pause sheet ${sheet ? `y ${sheet.y.toFixed(1)}..${(sheet.y + sheet.h).toFixed(1)}` : "missing"}; controls ${btns.map((c) => `${c.id} ${c.w}x${c.h}@${c.y.toFixed(0)}`).join(", ")}; row pitch ${pitches.join("/")}`);
  } finally {
    await browser.close();
  }
}

async function main() {
  if (!process.argv.includes("--no-build")) {
    execSync("npx vite build --mode test --outDir build/test", { cwd: root, stdio: "ignore" });
  }
  fs.mkdirSync(outDir, { recursive: true });
  const port = await freePort();
  globalThis.baseUrl = `http://127.0.0.1:${port}/?test`;
  const preview = spawnPreview("npx", ["vite", "preview", "--outDir", "build/test", "--port", String(port), "--strictPort"], {
    cwd: root,
    stdio: "pipe",
    env: { ...process.env, BROWSER: "none" },
  });
  const errors = [];
  const notes = [];
  try {
    await waitForHttp(`http://127.0.0.1:${port}/`);
    for (const cfg of CONFIGS) {
      try {
        await runConfig(cfg, errors, notes);
      } catch (e) {
        errors.push(`${cfg.name}: ${e.message}`);
      }
    }
  } finally {
    preview.kill("SIGTERM");
  }
  for (const n of notes) console.log(n);
  if (errors.length) {
    console.error(`\ncourse-check: FAILED (${errors.length})`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log("\ncourse-check: ok");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
