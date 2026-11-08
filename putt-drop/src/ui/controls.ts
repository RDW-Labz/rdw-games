import type Phaser from "phaser";

export type ControlKind = "primary" | "secondary" | "icon" | "card" | "toggle";

export interface ControlRect {
  id: string;
  scene: string;
  x: number;
  y: number;
  w: number;
  h: number;
  kind?: ControlKind;
}

interface ControlEntry extends ControlRect {
  target?: Phaser.GameObjects.Container;
  /** Permanent hit object; when present its world bounds are the control rect. */
  hit?: Phaser.GameObjects.Rectangle;
}

const registry: ControlEntry[] = [];

export function clearSceneControls(sceneKey: string): void {
  for (let i = registry.length - 1; i >= 0; i--) {
    if (registry[i].scene === sceneKey) registry.splice(i, 1);
  }
}

export function registerControl(
  rect: ControlRect,
  target?: Phaser.GameObjects.Container,
  hit?: Phaser.GameObjects.Rectangle
): void {
  // Test-only reporting (window.__pd.controls()); production builds compile this to nothing.
  if (import.meta.env.MODE !== "production") {
    const idx = registry.findIndex((r) => r.id === rect.id && r.scene === rect.scene);
    const entry: ControlEntry = { ...rect, target, hit };
    if (idx >= 0) registry[idx] = entry;
    else registry.push(entry);
  }
}

export function unregisterIdPrefix(prefix: string): void {
  for (let i = registry.length - 1; i >= 0; i--) {
    if (registry[i].id.startsWith(prefix)) registry.splice(i, 1);
  }
}

/** Center (x,y) and size in logical coordinates. */
export function registerControlCenter(
  id: string,
  scene: string,
  cx: number,
  cy: number,
  w: number,
  h: number,
  target?: Phaser.GameObjects.Container,
  kind?: ControlKind,
  hit?: Phaser.GameObjects.Rectangle
): void {
  registerControl({ id, scene, x: cx - w / 2, y: cy - h / 2, w, h, kind }, target, hit);
}

export function getControls(): ControlRect[] {
  return registry.map((entry) => boundsForEntry(entry));
}

function isControlVisible(entry: ControlEntry): boolean {
  if (!entry.target) return true;
  return entry.target.active && entry.target.visible && entry.target.alpha > 0.05;
}

export function getVisibleControls(activeScenes: string[]): ControlRect[] {
  const set = new Set(activeScenes);
  return registry
    .filter((c) => set.has(c.scene) && isControlVisible(c))
    .map((entry) => boundsForEntry(entry));
}

function boundsForEntry(entry: ControlEntry): ControlRect {
  if (entry.hit?.active) {
    // On-screen rect: world bounds minus the scene camera scroll (scene transitions slide the camera).
    const b = entry.hit.getBounds();
    const cam = entry.hit.scene?.cameras?.main;
    const sx = cam?.scrollX ?? 0;
    const sy = cam?.scrollY ?? 0;
    return { id: entry.id, scene: entry.scene, x: b.x - sx, y: b.y - sy, w: b.width, h: b.height, kind: entry.kind };
  }
  if (entry.target?.active) {
    const b = entry.target.getBounds();
    if (
      entry.kind === "primary" ||
      entry.kind === "secondary" ||
      entry.kind === "icon"
    ) {
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      return {
        id: entry.id,
        scene: entry.scene,
        x: cx - entry.w / 2,
        y: cy - entry.h / 2,
        w: entry.w,
        h: entry.h,
        kind: entry.kind,
      };
    }
    return {
      id: entry.id,
      scene: entry.scene,
      x: b.x,
      y: b.y,
      w: b.width,
      h: b.height,
      kind: entry.kind,
    };
  }
  return {
    id: entry.id,
    scene: entry.scene,
    x: entry.x,
    y: entry.y,
    w: entry.w,
    h: entry.h,
    kind: entry.kind,
  };
}
