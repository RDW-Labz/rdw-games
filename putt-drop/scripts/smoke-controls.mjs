export function tapSamples(cx, cy, w, h) {
  const left = cx - w / 2;
  const right = cx + w / 2;
  const top = cy - h / 2;
  const bottom = cy + h / 2;
  return [
    { x: cx, y: cy },
    { x: left + 0.15 * w, y: cy },
    { x: right - 0.15 * w, y: cy },
    { x: cx, y: top + 0.15 * h },
    { x: cx, y: bottom - 0.15 * h },
  ];
}

export async function getControl(page, id) {
  return page.evaluate((controlId) => {
    const list = window.__pd?.controls?.() ?? [];
    return list.find((c) => c.id === controlId) ?? null;
  }, id);
}

export async function tapControlCenter(page, tapGame, control) {
  const cx = control.x + control.w / 2;
  const cy = control.y + control.h / 2;
  await tapGame(page, cx, cy);
}

export async function tapControlSamples(page, tapGame, control) {
  const cx = control.x + control.w / 2;
  const cy = control.y + control.h / 2;
  const points = tapSamples(cx, cy, control.w, control.h);
  for (const pt of points) {
    await tapGame(page, pt.x, pt.y);
  }
}
