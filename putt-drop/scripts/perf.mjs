import { chromium, devices } from "playwright";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { spawnPreview, launchBrowser } from "./lib/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
// Bundle size is measured on the production build (build/web, `npm run build`) when present;
// the game itself is served from the test build (build/test, `npm run build:test`), which is
// the only build that carries the window.__pd hooks this script reads.
const testBuildDir = path.join(root, "build/test");
const buildDir = fs.existsSync(path.join(root, "build/web/index.html"))
  ? path.join(root, "build/web")
  : testBuildDir;

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

function gzipSize(buf) {
  return zlib.gzipSync(buf).length;
}

function collectBundleStats() {
  const walk = (dir, base = "") => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files = [];
    for (const e of entries) {
      const rel = path.join(base, e.name);
      const full = path.join(dir, e.name);
      if (e.isDirectory()) files.push(...walk(full, rel));
      else files.push(rel);
    }
    return files;
  };
  if (!fs.existsSync(buildDir)) {
    throw new Error(`Missing build output at ${buildDir}`);
  }
  const all = walk(buildDir);
  const jsFiles = all.filter((f) => f.endsWith(".js"));
  const fontFiles = all.filter((f) => /\.(woff2?|ttf|otf)$/i.test(f));

  const jsChunks = {};
  let totalJs = 0;
  let totalJsGzip = 0;
  for (const f of jsFiles) {
    const buf = fs.readFileSync(path.join(buildDir, f));
    const raw = buf.length;
    const gz = gzipSize(buf);
    jsChunks[f.replace(/\\/g, "/")] = { bytes: raw, gzip: gz };
    totalJs += raw;
    totalJsGzip += gz;
  }

  let fontsBytes = 0;
  let fontsGzip = 0;
  for (const f of fontFiles) {
    const buf = fs.readFileSync(path.join(buildDir, f));
    fontsBytes += buf.length;
    fontsGzip += gzipSize(buf);
  }

  const allFiles = all.map((f) => {
    const buf = fs.readFileSync(path.join(buildDir, f));
    return { bytes: buf.length, gzip: gzipSize(buf) };
  });
  const totalBytes = allFiles.reduce((a, b) => a + b.bytes, 0);
  const totalGzip = allFiles.reduce((a, b) => a + b.gzip, 0);

  return {
    totalJs: { bytes: totalJs, gzip: totalJsGzip },
    jsChunks,
    fonts: { bytes: fontsBytes, gzip: fontsGzip },
    total: { bytes: totalBytes, gzip: totalGzip },
  };
}

async function gamePoint(page, gx, gy) {
  const box = await page.locator("#game canvas").boundingBox();
  if (!box) throw new Error("Canvas not found");
  const scale = Math.min(box.width / 360, box.height / 640);
  const ox = box.x + (box.width - 360 * scale) / 2;
  const oy = box.y + (box.height - 640 * scale) / 2;
  return { x: ox + gx * scale, y: oy + gy * scale };
}

async function sampleFps(page, durationMs) {
  return page.evaluate(async (ms) => {
    const stamps = [];
    let rafId = 0;
    const start = performance.now();
    await new Promise((resolve) => {
      const tick = () => {
        stamps.push(performance.now());
        if (performance.now() - start >= ms) {
          cancelAnimationFrame(rafId);
          resolve();
          return;
        }
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
    });
    const deltas = [];
    for (let i = 1; i < stamps.length; i++) deltas.push(stamps[i] - stamps[i - 1]);
    if (!deltas.length) return { avg: 0, p5: 0 };
    const fpsSamples = deltas.map((d) => 1000 / d);
    fpsSamples.sort((a, b) => a - b);
    const avg = fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length;
    const p5 = fpsSamples[Math.floor(fpsSamples.length * 0.05)] ?? fpsSamples[0];
    return { avg: Math.round(avg * 10) / 10, p5: Math.round(p5 * 10) / 10 };
  }, durationMs);
}

async function measureMenuInteractive(page, baseUrl) {
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    await page.goto(baseUrl, { waitUntil: "commit" });
    await page.waitForFunction(
      () => {
        const scenes = window.__pd?.activeScenes?.() ?? [];
        if (!scenes.includes("Menu")) return false;
        return (window.__pd?.controls?.() ?? []).some((c) => c.id === "menu.play");
      },
      { timeout: 15000 }
    );
    samples.push(Date.now() - t0);
    await page.evaluate(() => {
      localStorage.clear();
    });
    await page.waitForTimeout(200);
  }
  samples.sort((a, b) => a - b);
  return samples[1];
}

async function fullPowerPutt(page) {
  const a = await gamePoint(page, 180, 560);
  const b = await gamePoint(page, 180, 400);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 10 });
  await page.mouse.up();
}

async function collectHeapMb(cdp, page) {
  await cdp.send("HeapProfiler.collectGarbage");
  await new Promise((r) => setTimeout(r, 150));
  const heap = await page.evaluate(() => window.__pd?.heap?.() ?? null);
  if (typeof heap === "number") return heap / (1024 * 1024);
  const { result } = await cdp.send("Runtime.evaluate", {
    expression: "performance.memory ? performance.memory.usedJSHeapSize : null",
    returnByValue: true,
  });
  const used = result.value;
  return typeof used === "number" ? used / (1024 * 1024) : null;
}

async function readWebGlRenderer(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector("#game canvas");
    if (!canvas) return { vendor: null, renderer: null };
    const gl =
      canvas.getContext("webgl2") ||
      canvas.getContext("webgl") ||
      canvas.getContext("experimental-webgl");
    if (!gl) return { vendor: null, renderer: null };
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    if (!ext) return { vendor: "unknown", renderer: "WEBGL_debug_renderer_info unavailable" };
    return {
      vendor: gl.getParameter(ext.UNMASKED_VENDOR_WEBGL),
      renderer: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL),
    };
  });
}

async function profileSelfTimeTop(cdp, page, ms, during) {
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.start");
  await during(page);
  await page.waitForTimeout(ms);
  const { profile } = await cdp.send("Profiler.stop");
  await cdp.send("Profiler.disable");

  const nodes = profile.nodes ?? [];
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  const self = new Map();
  for (let i = 0; i < samples.length; i++) {
    const id = samples[i];
    const dt = deltas[i] ?? 0;
    self.set(id, (self.get(id) ?? 0) + dt);
  }
  const rows = nodes
    .map((n) => ({
      name: n.callFrame?.functionName || "(anonymous)",
      url: n.callFrame?.url || "",
      selfUs: self.get(n.id) ?? 0,
    }))
    .filter((r) => r.selfUs > 0)
    .sort((a, b) => b.selfUs - a.selfUs)
    .slice(0, 15)
    .map((r) => ({
      name: r.name,
      url: r.url ? r.url.replace(/^.*\//, "") : "",
      selfMs: Math.round(r.selfUs / 1000),
    }));
  return rows;
}

function printTable(report, label = "perf") {
  console.log(`\n--- ${label} ---`);
  if (report.cpuThrottleRate != null) {
    console.log(`cpuThrottleRate: ${report.cpuThrottleRate}`);
  }
  if (report.webgl) {
    console.log(`webgl vendor: ${report.webgl.vendor}`);
    console.log(`webgl renderer: ${report.webgl.renderer}`);
  }
  console.log(`menuInteractiveMs (median cold): ${report.menuInteractiveMs}`);
  console.log(`fpsPutt avg/p5: ${report.fpsPutt.avg} / ${report.fpsPutt.p5}`);
  console.log(
    `fpsMenuTransition avg/p5: ${report.fpsMenuTransition.avg} / ${report.fpsMenuTransition.p5}`
  );
  console.log(`fpsResult avg/p5: ${report.fpsResult.avg} / ${report.fpsResult.p5}`);
  console.log(`layoutJumps: ${report.layoutJumps}`);
  console.log(
    `heapMB hole1 / after10holes / growth: ${report.heapMB.afterHole1} / ${report.heapMB.after10Holes} / ${report.heapMB.growthMB}`
  );
  if (report.heapMB.after30Holes != null) {
    console.log(`heapMB after30holes: ${report.heapMB.after30Holes}`);
  }
  if (report.textureCount) {
    console.log(
      `textureCount hole1 / after10: ${report.textureCount.afterHole1} / ${report.textureCount.after10Holes} (delta ${report.textureCount.delta})`
    );
  }
  console.log(`bundle (${path.relative(root, buildDir)}) total JS gzip: ${(report.bundle.totalJs.gzip / 1024).toFixed(1)} KiB`);
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function medianReport(reports) {
  const pick = (path) => reports.map((r) => path(r));
  const medFps = (key) => ({
    avg: median(pick((r) => r[key].avg)),
    p5: median(pick((r) => r[key].p5)),
  });
  return {
    menuInteractiveMs: median(pick((r) => r.menuInteractiveMs)),
    fpsPutt: medFps("fpsPutt"),
    fpsMenuTransition: medFps("fpsMenuTransition"),
    fpsResult: medFps("fpsResult"),
    layoutJumps: median(pick((r) => r.layoutJumps)),
    heapMB: {
      afterHole1: median(pick((r) => r.heapMB.afterHole1)),
      after10Holes: median(pick((r) => r.heapMB.after10Holes)),
      growthMB: median(pick((r) => r.heapMB.growthMB)),
      after30Holes: reports[0].heapMB.after30Holes ?? null,
    },
    textureCount: reports[0].textureCount,
    bundle: reports[0].bundle,
    webgl: reports[0].webgl,
    cpuThrottleRate: reports[0].cpuThrottleRate,
    profilePutt: reports[0].profilePutt,
    profileTransition: reports[0].profileTransition,
  };
}

async function runPerfPass({ baseUrl, cpuThrottleRate, includeProfile, extraHoles = 20 }) {
  const browser = await launchBrowser(chromium, {
    headless: true,
    // Real GPU (Metal on macOS) unless PERF_SOFTWARE_GL=1; headless default is SwiftShader, which measures the CPU rasterizer, not the game.
    args: [
      "--enable-precise-memory-info",
      "--js-flags=--expose-gc",
      ...(process.env.PERF_SOFTWARE_GL === "1" ? [] : ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"]),
    ],
  });
  const context = await browser.newContext({
    ...devices["Pixel 7"],
    hasTouch: true,
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottleRate });

  const menuInteractiveMs = await measureMenuInteractive(page, baseUrl);

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForFunction(
    () => (window.__pd?.activeScenes?.() ?? []).includes("Menu"),
    { timeout: 10000 }
  );
  await page.waitForFunction(() => window.__pd?.fontsReady?.() ?? false, { timeout: 8000 });
  await page.waitForTimeout(500);

  const webgl = await readWebGlRenderer(page);

  const layoutJumps = await page.evaluate(async () => {
    const canvas = document.querySelector("#game canvas");
    if (!canvas) return 0;
    let last = canvas.getBoundingClientRect();
    let jumps = 0;
    const same = (a, b) =>
      a.width === b.width && a.height === b.height && a.top === b.top && a.left === b.left;
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const next = canvas.getBoundingClientRect();
      if (!same(last, next)) {
        jumps += 1;
        last = next;
      }
    }
    return jumps;
  });

  await page.evaluate(() => window.__pd?.play?.(0));
  await page.waitForFunction(
    () => (window.__pd?.activeScenes?.() ?? []).includes("Play"),
    { timeout: 8000 }
  );
  await page.waitForTimeout(400);

  let profilePutt = null;
  let profileTransition = null;

  if (includeProfile) {
    profilePutt = await profileSelfTimeTop(cdp, page, 2000, async (p) => {
      await fullPowerPutt(p);
    });
  } else {
    await fullPowerPutt(page);
  }
  const fpsPutt = await sampleFps(page, 2000);

  await page.evaluate(() => window.__pd?.goto?.("Menu"));
  await page.waitForFunction(
    () => (window.__pd?.activeScenes?.() ?? []).includes("Menu"),
    { timeout: 8000 }
  );
  await page.waitForTimeout(200);

  if (includeProfile) {
    profileTransition = await profileSelfTimeTop(cdp, page, 1200, async (p) => {
      const fpsMenuPromise = sampleFps(p, 1200);
      await p.evaluate(() => window.__pd?.goto?.("LevelSelect"));
      await p.waitForFunction(
        () => (window.__pd?.activeScenes?.() ?? []).includes("LevelSelect"),
        { timeout: 8000 }
      );
      await fpsMenuPromise;
    });
    await page.evaluate(() => window.__pd?.goto?.("Menu"));
    await page.waitForFunction(
      () => (window.__pd?.activeScenes?.() ?? []).includes("Menu"),
      { timeout: 8000 }
    );
    await page.waitForTimeout(200);
  }

  const fpsMenuPromise = sampleFps(page, 1200);
  await page.evaluate(() => window.__pd?.goto?.("LevelSelect"));
  await page.waitForFunction(
    () => (window.__pd?.activeScenes?.() ?? []).includes("LevelSelect"),
    { timeout: 8000 }
  );
  const fpsMenuTransition = await fpsMenuPromise;

  await page.evaluate(() => window.__pd?.play?.(0));
  await page.waitForFunction(
    () => (window.__pd?.activeScenes?.() ?? []).includes("Play"),
    { timeout: 8000 }
  );
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__pd?.forceResult?.(2));
  const fpsResult = await sampleFps(page, 1200);

  await page.evaluate(() => window.__pd?.play?.(0));
  await page.waitForFunction(
    () => (window.__pd?.activeScenes?.() ?? []).includes("Play"),
    { timeout: 8000 }
  );
  await page.waitForTimeout(400);

  let texAfterHole1 = null;
  let heapAfterHole1 = null;
  let heapAfter10 = null;
  let texAfter10 = null;

  for (let i = 0; i < 10; i++) {
    await page.evaluate((idx) => window.__pd?.play?.(idx), i);
    await page.waitForFunction(
      () => (window.__pd?.activeScenes?.() ?? []).includes("Play"),
      { timeout: 8000 }
    );
    await page.waitForTimeout(250);
    await fullPowerPutt(page);
    await page.waitForTimeout(600);
    if (i === 0) {
      heapAfterHole1 = await collectHeapMb(cdp, page);
      texAfterHole1 = await page.evaluate(() => window.__pd?.textureCount?.() ?? null);
    }
    if (i === 9) {
      heapAfter10 = await collectHeapMb(cdp, page);
      texAfter10 = await page.evaluate(() => window.__pd?.textureCount?.() ?? null);
    }
  }

  for (let i = 0; i < extraHoles; i++) {
    await page.evaluate((idx) => window.__pd?.play?.(idx % 12), i);
    await page.waitForFunction(
      () => (window.__pd?.activeScenes?.() ?? []).includes("Play"),
      { timeout: 8000 }
    );
    await page.waitForTimeout(200);
    await fullPowerPutt(page);
    await page.waitForTimeout(400);
  }
  const heapAfter30 = await collectHeapMb(cdp, page);

  await browser.close();

  const texDelta =
    texAfterHole1 != null && texAfter10 != null ? texAfter10 - texAfterHole1 : null;
  if (texDelta != null && Math.abs(texDelta) > 2) {
    console.warn(
      `texture count grew by ${texDelta} (after10=${texAfter10}, hole1=${texAfterHole1}); expected ±2`
    );
  }

  return {
    cpuThrottleRate,
    webgl,
    menuInteractiveMs,
    fpsPutt,
    fpsMenuTransition,
    fpsResult,
    layoutJumps,
    heapMB: {
      afterHole1: heapAfterHole1 != null ? Math.round(heapAfterHole1 * 100) / 100 : null,
      after10Holes: heapAfter10 != null ? Math.round(heapAfter10 * 100) / 100 : null,
      growthMB:
        heapAfterHole1 != null && heapAfter10 != null
          ? Math.round((heapAfter10 - heapAfterHole1) * 100) / 100
          : null,
      after30Holes: heapAfter30 != null ? Math.round(heapAfter30 * 100) / 100 : null,
    },
    textureCount: {
      afterHole1: texAfterHole1,
      after10Holes: texAfter10,
      delta: texDelta,
    },
    profilePutt,
    profileTransition,
  };
}

async function main() {
  const outFile = process.argv[2];
  if (!outFile) {
    console.error("Usage: node scripts/perf.mjs <outFile.json> [--runs N] [--profile]");
    process.exit(1);
  }
  const runs = Number(process.argv.find((a) => a.startsWith("--runs="))?.split("=")[1] ?? 1);
  const withProfile = process.argv.includes("--profile");
  const includeUnthrottled = !process.argv.includes("--throttled-only");

  const bundle = collectBundleStats();
  const port = await freePort();
  if (!fs.existsSync(path.join(testBuildDir, "index.html"))) {
    throw new Error("Missing build/test; run `npm run build:test`");
  }
  const baseUrl = `http://127.0.0.1:${port}/`;
  const preview = spawnPreview(
    "npx",
    ["vite", "preview", "--outDir", "build/test", "--port", String(port), "--strictPort"],
    { cwd: root, stdio: "pipe", env: { ...process.env, BROWSER: "none" } }
  );

  try {
    await waitForHttp(`http://127.0.0.1:${port}/`);

    const throttledRuns = [];
    for (let i = 0; i < runs; i++) {
      throttledRuns.push(
        await runPerfPass({
          baseUrl,
          cpuThrottleRate: 4,
          includeProfile: withProfile && i === 0,
          extraHoles: 20,
        })
      );
    }
    const throttled = medianReport(throttledRuns);
    throttled.bundle = bundle;

    let unthrottled = null;
    if (includeUnthrottled) {
      unthrottled = await runPerfPass({
        baseUrl,
        cpuThrottleRate: 1,
        includeProfile: false,
        extraHoles: 0,
      });
      unthrottled.bundle = bundle;
    }

    const report = {
      throttled,
      unthrottled,
      runs,
    };

    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
    printTable(throttled, "perf (CPU x4, median)");
    if (unthrottled) printTable(unthrottled, "perf (CPU x1)");
    if (throttled.profilePutt) {
      console.log("\n--- profile putt (top 15 self ms) ---");
      for (const row of throttled.profilePutt) {
        console.log(`${row.selfMs}ms ${row.name} ${row.url}`);
      }
    }
    if (throttled.profileTransition) {
      console.log("\n--- profile menu transition (top 15 self ms) ---");
      for (const row of throttled.profileTransition) {
        console.log(`${row.selfMs}ms ${row.name} ${row.url}`);
      }
    }
  } finally {
    preview.kill("SIGTERM");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
