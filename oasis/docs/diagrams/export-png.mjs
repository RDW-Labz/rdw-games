#!/usr/bin/env node
// Screenshot an archify-rendered diagram .html to a full-page, light-theme .png.
// Usage: node export-png.mjs <input.html> <output.png>
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  const requireFrom = createRequire(
    path.join('/Users/prime/.project-swarm/toolchains/node_modules/playwright', 'package.json'),
  );
  ({ chromium } = requireFrom('playwright'));
}

const [, , htmlPath, pngPath] = process.argv;
if (!htmlPath || !pngPath) {
  console.error('Usage: node export-png.mjs <input.html> <output.png>');
  process.exit(1);
}

const url = pathToFileURL(path.resolve(htmlPath)).href;
const isArchitecture = path.basename(htmlPath) === 'architecture.html';

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
  });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts && document.fonts.ready);

  // Hide viewer chrome (top-right toolbar and the floating PATH/MAP/LENS +
  // zoom bar) for the screenshot only; the checked-in .html keeps them.
  // Selected by their own role/aria-label, not by guessed text.
  const hiddenSelectors = await page.evaluate(() => {
    const selectors = [
      '.toolbar[role="toolbar"][aria-label="Diagram actions"]',
      '.diagram-nav[role="toolbar"][aria-label="Diagram view controls"]',
    ];
    const found = [];
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el) {
        el.style.setProperty('display', 'none', 'important');
        found.push(selector);
      }
    }
    return found;
  });

  const { width, height } = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
  }));
  await page.setViewportSize({
    width: Math.max(1600, width),
    height: Math.max(1000, height),
  });
  // Let layout settle at the new viewport size before measuring again.
  await page.evaluate(() => document.fonts && document.fonts.ready);
  const resized = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
  }));
  if (resized.width > width || resized.height > height) {
    await page.setViewportSize({
      width: Math.max(1600, resized.width),
      height: Math.max(1000, resized.height),
    });
  }

  let sublabelPx;
  let edgeLabelPx;
  if (isArchitecture) {
    // archify has no schema/CLI option for connection label font size (fixed
    // at 8px in renderers/architecture/render-architecture.mjs, no meta/CSS
    // override field in the schema either); bump it here at screenshot time
    // only, matching the node sublabel size measured live in the rendered
    // DOM (node outline rail's sublabel text, ".node-outline-item small").
    // The checked-in .html is never hand-edited.
    sublabelPx = await page.evaluate(() => {
      const el = document.querySelector('.node-outline-item small');
      return el ? parseFloat(getComputedStyle(el).fontSize) : null;
    });
    edgeLabelPx = sublabelPx || 9;
    const countCollisions = () =>
      page.evaluate(() => {
        function overlap(a, b) {
          return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        }
        const edgeRects = Array.from(document.querySelectorAll('g[data-edge-id] > text')).map((t) =>
          t.getBoundingClientRect(),
        );
        const nodeRects = Array.from(document.querySelectorAll('g[data-node-id] rect')).map((r) =>
          r.getBoundingClientRect(),
        );
        let count = 0;
        for (let i = 0; i < edgeRects.length; i++) {
          for (let j = i + 1; j < edgeRects.length; j++) {
            if (overlap(edgeRects[i], edgeRects[j])) count += 1;
          }
        }
        for (const e of edgeRects) {
          for (const n of nodeRects) {
            if (overlap(e, n)) count += 1;
          }
        }
        return count;
      });
    await page.addStyleTag({
      content: `g[data-edge-id] > text { font-size: ${edgeLabelPx}px !important; }`,
    });
    if ((await countCollisions()) > 0) {
      edgeLabelPx -= 1;
      await page.addStyleTag({
        content: `g[data-edge-id] > text { font-size: ${edgeLabelPx}px !important; }`,
      });
    }
  }

  const nodeTitles = await page.evaluate(() => {
    const items = document.querySelectorAll('.node-outline-item');
    return items.length;
  });

  const expectedNodeCounts = { 'architecture.html': 16, 't64-watcher.html': 10 };
  const expectedNodeCount = expectedNodeCounts[path.basename(htmlPath)];
  if (expectedNodeCount !== undefined && nodeTitles !== expectedNodeCount) {
    throw new Error(
      `rendered node count ${nodeTitles} does not match expected ${expectedNodeCount} for ${htmlPath}`,
    );
  }

  let t64SublabelPresent;
  if (path.basename(htmlPath) === 't64-watcher.html') {
    t64SublabelPresent = await page.evaluate(
      () => document.body.textContent.includes("browser + per-app, apps that pin their own cert"),
    );
    if (!t64SublabelPresent) {
      throw new Error('t64 fallback sublabel text not found in rendered DOM');
    }
  }

  await page.screenshot({ path: path.resolve(pngPath), fullPage: true });

  console.log(
    JSON.stringify({ htmlPath, pngPath, nodeTitles, hiddenSelectors, t64SublabelPresent, sublabelPx, edgeLabelPx }),
  );
} finally {
  await browser.close();
}
