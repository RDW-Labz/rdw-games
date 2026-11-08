export const LOGICAL_W = 360;
export const LOGICAL_H = 640;

const LEGACY_BTN = { r: 18, g: 22, b: 42 };
const BG_SAMPLE = { r: 19, g: 21, b: 41 };

function luma(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function sampleRgb(data, w, lx, ly) {
  const lxCl = Math.max(0, Math.min(LOGICAL_W - 1, Math.floor(lx)));
  const lyCl = Math.max(0, Math.min(LOGICAL_H - 1, Math.floor(ly)));
  const i = (lyCl * w + lxCl) * 4;
  return [data[i], data[i + 1], data[i + 2]];
}

function inferKind(id) {
  if (id.includes(".toggle.")) return "toggle";
  if (id.endsWith(".play") || id.includes(".resume") || id.includes(".reset.confirm")) return "primary";
  if (id.includes(".holes") || id.includes(".restart") || id.includes(".reset") && !id.includes("confirm"))
    return "secondary";
  if (id.includes(".settings") || id.includes(".back") || id.includes(".pause") && id === "play.pause")
    return "icon";
  if (id.startsWith("holes.card.")) return "card";
  if (id.includes("menu.play") || id.includes("pause.resume")) return "primary";
  return undefined;
}

/** Sample a few pixels per logical cell in [lx0, lx1] x [ly0, ly1]. */
function forEachLogicalPixel(rgba, w, h, scale, lx0, ly0, lx1, ly1, fn) {
  const step = Math.max(1, Math.floor(scale / 2));
  for (let ly = ly0; ly <= ly1; ly += step) {
    for (let lx = lx0; lx <= lx1; lx += step) {
      const px = Math.min(w - 1, Math.floor(lx * scale));
      const py = Math.min(h - 1, Math.floor(ly * scale));
      const i = (py * w + px) * 4;
      fn(rgba[i], rgba[i + 1], rgba[i + 2], lx, ly);
    }
  }
}

export async function readCanvasRgba(page) {
  return page.evaluate(async () => {
    const canvas = document.querySelector("#game canvas");
    if (!canvas) throw new Error("no canvas");
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const rect = canvas.getBoundingClientRect();
    const LW = 360;
    const LH = 640;
    const scale = Math.min(rect.width / LW, rect.height / LH);
    const gw = LW * scale;
    const gh = LH * scale;
    const ox = (rect.width - gw) / 2;
    const oy = (rect.height - gh) / 2;
    const snap = document.createElement("canvas");
    snap.width = canvas.width;
    snap.height = canvas.height;
    const snapCtx = snap.getContext("2d");
    if (!snapCtx) throw new Error("no 2d context");
    snapCtx.drawImage(canvas, 0, 0);
    const raw = snapCtx.getImageData(0, 0, snap.width, snap.height);
    const out = new Uint8ClampedArray(LW * LH * 4);
    for (let ly = 0; ly < LH; ly++) {
      for (let lx = 0; lx < LW; lx++) {
        const gx = ox + (lx + 0.5) * scale;
        const gy = oy + (ly + 0.5) * scale;
        const px = Math.min(
          snap.width - 1,
          Math.max(0, Math.floor(gx * (snap.width / rect.width)))
        );
        const py = Math.min(
          snap.height - 1,
          Math.max(0, Math.floor(gy * (snap.height / rect.height)))
        );
        const src = (py * snap.width + px) * 4;
        const dst = (ly * LW + lx) * 4;
        out[dst] = raw.data[src];
        out[dst + 1] = raw.data[src + 1];
        out[dst + 2] = raw.data[src + 2];
        out[dst + 3] = raw.data[src + 3];
      }
    }
    return { w: LW, h: LH, data: Array.from(out) };
  });
}

export function assertFewBlackPixels(rgba, label) {
  const { w, h, data } = rgba;
  const scale = w / LOGICAL_W;
  let black = 0;
  let samples = 0;
  forEachLogicalPixel(data, w, h, scale, 0, 0, LOGICAL_W - 1, LOGICAL_H - 1, (r, g, b) => {
    samples++;
    if (r === 0 && g === 0 && b === 0) black++;
  });
  const blackFrac = samples > 0 ? black / samples : 0;
  if (blackFrac >= 0.01) {
    throw new Error(
      `${label}: ${(blackFrac * 100).toFixed(2)}% pure black pixels (max 1%); canvas ${w}x${h}`
    );
  }
}

export function assertNoLegacyFlatButtons(rgba, label, buttonRects = []) {
  const { w, h, data } = rgba;
  const scale = w / LOGICAL_W;
  let legacyHits = 0;
  const regions =
    buttonRects.length > 0
      ? buttonRects.map((b) => ({
          x0: Math.floor(b.x),
          y0: Math.floor(b.y),
          x1: Math.floor(b.x + b.w),
          y1: Math.floor(b.y + b.h),
        }))
      : [{ x0: 40, y0: 360, x1: 320, y1: 620 }];
  for (const r of regions) {
    forEachLogicalPixel(data, w, h, scale, r.x0, r.y0, r.x1, r.y1, (cr, cg, cb) => {
      if (cr === LEGACY_BTN.r && cg === LEGACY_BTN.g && cb === LEGACY_BTN.b) legacyHits++;
    });
  }
  if (legacyHits > 2) {
    throw new Error(`${label}: menu still shows legacy flat button fill (${legacyHits} samples)`);
  }
}

export function assertMenuPicture(rgba, label, menuButtons = []) {
  const { w, h, data } = rgba;
  const scale = w / LOGICAL_W;

  let titleHits = 0;
  forEachLogicalPixel(data, w, h, scale, 24, 88, 200, 200, (r, g, b) => {
    if (r < 90 && g > 50 && b < 90) titleHits++;
  });
  if (titleHits < 8) {
    throw new Error(`${label}: title region missing Pocket Park wordmark pixels`);
  }

  assertNoLegacyFlatButtons(rgba, label, menuButtons);
}

export async function assertCanvasBackingStore(page, label) {
  const check = await page.evaluate(() => {
    const canvas = document.querySelector("#game canvas");
    if (!canvas) return { ok: false, reason: "no canvas" };
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const R = Math.min(Math.max(dpr, 1), 3);
    const minLogical = 0.95 * 360 * R;
    const minCss = 0.95 * rect.width * dpr;
    const okLogical = canvas.width >= minLogical;
    const okCss = dpr <= 1 || canvas.width >= minCss;
    return {
      ok: okLogical && okCss,
      canvasWidth: canvas.width,
      cssWidth: rect.width,
      dpr,
      minLogical,
      minCss,
    };
  });
  if (!check.ok) {
    throw new Error(`${label}: canvas DPR check failed: ${JSON.stringify(check)}`);
  }
  return check;
}

export async function assertMenuFonts(page, label) {
  const ok = await page.evaluate(() => {
    const fredoka = ["700 20px Fredoka", "bold 20px Fredoka", "20px Fredoka"].some((s) =>
      document.fonts?.check?.(s)
    );
    const nunito = ["600 16px Nunito", "16px Nunito"].some((s) => document.fonts?.check?.(s));
    return { fredoka, nunito };
  });
  if (!ok.nunito) {
    throw new Error(`${label}: Nunito not loaded before menu (${JSON.stringify(ok)})`);
  }
  if (!ok.fredoka) {
    const rgba = await readCanvasRgba(page);
    let titleHits = 0;
    const { w, h, data } = rgba;
    const scale = w / LOGICAL_W;
    forEachLogicalPixel(data, w, h, scale, 40, 100, 320, 200, (r, g, b) => {
      if (r > 200 && g > 200 && b > 220) titleHits++;
    });
    if (titleHits < 8) {
      throw new Error(`${label}: Fredoka not loaded before menu (${JSON.stringify(ok)})`);
    }
  }
}

export async function assertMenuScenePicture(page, sceneLabel) {
  await page.evaluate(async () => {
    try {
      await document.fonts.load("700 20px Fredoka");
      await document.fonts.load("600 16px Nunito");
    } catch {
      /* ignore */
    }
  });
  await assertMenuFonts(page, sceneLabel);
  const rgba = await readCanvasRgba(page);
  const controls = await page.evaluate(() => window.__pd?.controls?.() ?? []);
  const menuButtons = controls.filter((c) => c.id === "menu.play" || c.id === "menu.holes");
  assertMenuPicture(rgba, sceneLabel, menuButtons);
  return rgba;
}

export function assertControlsPicture(rgba, controls, label, opts = {}) {
  const { w, data } = rgba;
  const bgL = luma(BG_SAMPLE.r, BG_SAMPLE.g, BG_SAMPLE.b);
  const prefix = opts.scenePrefix;

  for (const c of controls) {
    if (prefix && !c.id.startsWith(prefix)) continue;
    if (c.id === "pause.sheet") continue;
    const kind = c.kind ?? inferKind(c.id);
    if (!kind || kind === "icon" || kind === "card" || kind === "toggle") continue;

    const fillX = c.x + c.w * 0.2;
    const rowY = c.y + c.h / 2;
    const [fr, fg, fb] = sampleRgb(data, w, fillX, rowY);
    const fillL = luma(fr, fg, fb);

    if (kind === "primary") {
      if (fillL <= 120) {
        throw new Error(
          `${label}: primary "${c.id}" fill too dark (luma ${fillL.toFixed(1)} at ${fillX},${rowY})`
        );
      }
      if (Math.abs(fillL - bgL) < 8) {
        throw new Error(`${label}: primary "${c.id}" fill matches background`);
      }
      const x0 = c.x + c.w * 0.2;
      const x1 = c.x + c.w * 0.8;
      let minL = 255;
      let maxL = 0;
      for (let ly = rowY - 3; ly <= rowY + 3; ly++) {
        for (let lx = x0; lx <= x1; lx++) {
          const [pr, pg, pb] = sampleRgb(data, w, lx, ly);
          const pl = luma(pr, pg, pb);
          minL = Math.min(minL, pl);
          maxL = Math.max(maxL, pl);
        }
      }
      const contrast = maxL - minL;
      if (contrast <= 80) {
        throw new Error(
          `${label}: primary "${c.id}" label band contrast too low (${contrast.toFixed(1)}; need >80)`
        );
      }
    }

    if (kind === "secondary") {
      const [sr, sg, sb] = sampleRgb(data, w, fillX, rowY);
      const secFillL = luma(sr, sg, sb);
      if (Math.abs(secFillL - bgL) < 12) {
        throw new Error(
          `${label}: secondary "${c.id}" fill too close to background (Δ ${Math.abs(secFillL - bgL).toFixed(1)})`
        );
      }
      const edgeX = Math.floor(c.x + c.w * 0.5);
      const edgeY = Math.floor(c.y + 2);
      const [er, eg, eb] = sampleRgb(data, w, edgeX, edgeY);
      const edgeL = luma(er, eg, eb);
      if (Math.abs(edgeL - secFillL) < 4) {
        throw new Error(`${label}: secondary "${c.id}" missing visible border at edge`);
      }
    }
  }

  if (opts.requireSettingsToggles) {
    const toggles = controls.filter((c) => (c.kind ?? inferKind(c.id)) === "toggle");
    if (toggles.length < 5) {
      throw new Error(`${label}: expected 5 settings toggles, got ${toggles.length}`);
    }
  }

  if (opts.pauseSheet) {
    const sheet = opts.pauseSheet;
    for (const c of controls) {
      if (!c.id.startsWith("pause.") || c.id === "pause.sheet") continue;
      const cx = c.x + c.w / 2;
      const cy = c.y + c.h / 2;
      if (
        cx < sheet.x ||
        cx > sheet.x + sheet.w ||
        cy < sheet.y ||
        cy > sheet.y + sheet.h
      ) {
        throw new Error(
          `${label}: pause control "${c.id}" center (${cx},${cy}) outside sheet ${JSON.stringify(sheet)}`
        );
      }
    }
  }
}

export async function assertSceneControls(page, sceneLabel, opts = {}) {
  const rgba = await readCanvasRgba(page);
  const controls = await page.evaluate(() => window.__pd?.controls?.() ?? []);
  const pauseSheet =
    opts.checkPauseSheet
      ? await page.evaluate(() => window.__pd?.pauseSheetRect?.() ?? null)
      : null;
  assertControlsPicture(rgba, controls, sceneLabel, {
    ...opts,
    pauseSheet,
  });
  return rgba;
}

/**
 * Screen-fit check in CSS px on the real page: every control (icons and back buttons included)
 * must be fully inside the viewport and outside the device's status-bar / home-indicator bands.
 * `canvasBox` is the canvas bounding box; `insets` = { top, bottom } in CSS px.
 */
export function assertControlsSafeArea(controls, label, { canvasBox, viewport, insets, scenePrefix } = {}) {
  const scale = Math.min(canvasBox.width / LOGICAL_W, canvasBox.height / LOGICAL_H);
  const ox = canvasBox.x + (canvasBox.width - LOGICAL_W * scale) / 2;
  const oy = canvasBox.y + (canvasBox.height - LOGICAL_H * scale) / 2;
  let checked = 0;
  for (const c of controls) {
    if (scenePrefix && !c.id.startsWith(scenePrefix)) continue;
    checked++;
    const top = oy + c.y * scale;
    const bottom = oy + (c.y + c.h) * scale;
    const left = ox + c.x * scale;
    const right = ox + (c.x + c.w) * scale;
    if (top < insets.top) {
      throw new Error(`${label}: "${c.id}" top ${top.toFixed(1)}px inside top inset ${insets.top}px`);
    }
    if (bottom > viewport.height - insets.bottom) {
      throw new Error(
        `${label}: "${c.id}" bottom ${bottom.toFixed(1)}px inside bottom inset (limit ${viewport.height - insets.bottom}px)`
      );
    }
    if (left < 0 || right > viewport.width) {
      throw new Error(`${label}: "${c.id}" horizontal overflow (${left.toFixed(1)}..${right.toFixed(1)})`);
    }
  }
  if (checked === 0) throw new Error(`${label}: no controls matched ${scenePrefix ?? "(any)"}`);
  return checked;
}

export async function assertSceneBlackPixels(page, sceneLabel) {
  const rgba = await readCanvasRgba(page);
  const { w, h, data } = rgba;
  const scale = w / LOGICAL_W;
  let hits = 0;
  let samples = 0;
  forEachLogicalPixel(data, w, h, scale, 48, 140, LOGICAL_W - 48, LOGICAL_H - 120, (r, g, b) => {
    samples++;
    if (r + g + b > 24) hits++;
  });
  if (hits < samples * 0.045) {
    throw new Error(`${sceneLabel}: scene center appears undrawn (${hits}/${samples} lit samples)`);
  }
  return rgba;
}
