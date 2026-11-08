/**
 * Renders Pocket Park launcher icons (SVG → PNG) via Playwright.
 * Run: node scripts/make-icons.mjs
 */
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnPreview, launchBrowser } from "./lib/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const storeDir = path.join(root, "store");
const resRoot = path.join(root, "android/app/src/main/res");

const SKY = "#FAF3DF";
const TURF_TOP = "#B3D28B";
const TURF_BOTTOM = "#87B36F";
const TURF_EDGE = "#887653";
const RAIL = "#FAF1D7";
const RAIL_UNDER = "#B49A71";
const BALL = "#FFFFFF";
const FLAG = "#AE403B";

/** Icon mark SVG (square viewport; safe for adaptive 66% zone). */
function iconSvg(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="turf" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${TURF_TOP}"/>
      <stop offset="100%" stop-color="${TURF_BOTTOM}"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" fill="${SKY}"/>
  <rect x="64" y="64" width="384" height="384" rx="96" fill="url(#turf)" stroke="${TURF_EDGE}" stroke-width="8"/>
  <circle cx="256" cy="256" r="168" fill="none" stroke="${RAIL_UNDER}" stroke-width="22"/>
  <circle cx="256" cy="256" r="152" fill="none" stroke="${RAIL}" stroke-width="16"/>
  <circle cx="220" cy="278" r="36" fill="${BALL}" stroke="${TURF_EDGE}" stroke-width="4"/>
  <line x1="300" y1="170" x2="300" y2="250" stroke="${FLAG}" stroke-width="10" stroke-linecap="round"/>
  <path d="M300 170 L360 190 L300 210 Z" fill="${FLAG}"/>
</svg>`;
}

function foregroundSvg(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="turf" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${TURF_TOP}"/>
      <stop offset="100%" stop-color="${TURF_BOTTOM}"/>
    </linearGradient>
  </defs>
  <rect x="64" y="64" width="384" height="384" rx="96" fill="url(#turf)" stroke="${TURF_EDGE}" stroke-width="8"/>
  <circle cx="256" cy="256" r="168" fill="none" stroke="${RAIL_UNDER}" stroke-width="22"/>
  <circle cx="256" cy="256" r="152" fill="none" stroke="${RAIL}" stroke-width="16"/>
  <circle cx="220" cy="278" r="36" fill="${BALL}" stroke="${TURF_EDGE}" stroke-width="4"/>
  <line x1="300" y1="170" x2="300" y2="250" stroke="${FLAG}" stroke-width="10" stroke-linecap="round"/>
  <path d="M300 170 L360 190 L300 210 Z" fill="${FLAG}"/>
</svg>`;
}

function backgroundSvg(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="${SKY}"/>
</svg>`;
}

const LEGACY = {
  "mipmap-mdpi": 48,
  "mipmap-hdpi": 72,
  "mipmap-xhdpi": 96,
  "mipmap-xxhdpi": 144,
  "mipmap-xxxhdpi": 192,
};

const ADAPTIVE = {
  "mipmap-mdpi": 108,
  "mipmap-hdpi": 162,
  "mipmap-xhdpi": 216,
  "mipmap-xxhdpi": 324,
  "mipmap-xxxhdpi": 432,
};

async function renderPng(page, svg, size, outPath) {
  await page.setContent(
    `<!doctype html><style>html,body{margin:0;background:${SKY}}</style>${svg.replace(
      /width="\d+" height="\d+"/,
      `width="${size}" height="${size}"`
    )}`,
    { waitUntil: "load" }
  );
  const el = await page.$("svg");
  const buf = await el.screenshot({ type: "png", omitBackground: false });
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, buf);
}

async function main() {
  const browser = await launchBrowser(chromium);
  const page = await browser.newPage();

  for (const [folder, px] of Object.entries(LEGACY)) {
    const out = path.join(resRoot, folder, "ic_launcher.png");
    await renderPng(page, iconSvg(512), px, out);
    await renderPng(page, iconSvg(512), px, path.join(resRoot, folder, "ic_launcher_round.png"));
  }

  for (const [folder, px] of Object.entries(ADAPTIVE)) {
    await renderPng(
      page,
      foregroundSvg(512),
      px,
      path.join(resRoot, folder, "ic_launcher_foreground.png")
    );
    await renderPng(
      page,
      backgroundSvg(512),
      px,
      path.join(resRoot, folder, "ic_launcher_background.png")
    );
  }

  await renderPng(page, iconSvg(512), 512, path.join(storeDir, "icon-512.png"));

  await browser.close();
  console.log("make-icons: wrote launcher PNGs and store/icon-512.png");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
