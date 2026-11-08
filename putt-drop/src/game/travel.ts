import Phaser from "phaser";
import type { ScreenBackground } from "../ui/background.js";
import { reducedMotion } from "../ui/motion.js";
import { TOKENS } from "../ui/tokens.js";
import { applyLogicalCamera } from "./render.js";

/**
 * Park travel (motion.md section 2): one 240 ms transition total. The destination scene is
 * active and interactive from its first frame; only decoration moves:
 * - a non-interactive snapshot of the outgoing background (no UI) fades 1 -> 0 while moving
 *   24 px opposite the travel vector;
 * - the incoming scenery layers move from +24 px (x layer factor) along the vector to 0 while
 *   fading 0.70 -> 1.
 * Reduced motion: no movement, 80 ms background crossfade only.
 *
 * The snapshot is stored as plain data (not game objects) and rebuilt inside the arriving
 * scene, so no game object ever crosses scene boundaries.
 */

const REGISTRY_TRAVEL = "pdParkTravelPlan";
const TRAVEL_PX = 24;
const REDUCED_MS = TOKENS.motion.duration.instant; // 80
/** Below every UI/HUD depth, above the background layers. */
const SNAPSHOT_DEPTH = TOKENS.depth.decoration + 5;

export interface PocketLayout {
  T: number;
  B: number;
  H: number;
  A: number;
  Y: number;
  CX: number;
  G: number;
  CW: number;
}

export function pocketLayout(): PocketLayout {
  const T = TOKENS.layout.safeTop;
  const B = TOKENS.layout.safeBottom;
  const H = TOKENS.layout.logicalH;
  const A = H - B - TOKENS.space.lg;
  const Y = T + 80;
  const CX = TOKENS.layout.logicalW / 2;
  const G = TOKENS.layout.gutter;
  return { T, B, H, A, Y, CX, G, CW: TOKENS.layout.contentW };
}

type ParkPoint = { x: number; y: number };

interface EllipseSpec {
  x: number;
  y: number;
  w: number;
  h: number;
  color: number;
  alpha: number;
}

interface LayerSpec {
  x: number;
  y: number;
  ellipses: EllipseSpec[];
}

interface TravelPlan {
  vx: number;
  vy: number;
  active: boolean;
  snapshot: LayerSpec[] | null;
}

const bgByScene = new WeakMap<Phaser.Scene, ScreenBackground>();
const travelTweens = new WeakMap<Phaser.Scene, Phaser.Tweens.Tween[]>();

export function registerSceneBackground(scene: Phaser.Scene, bg: ScreenBackground): void {
  bgByScene.set(scene, bg);
}

function parkCoord(sceneKey: string): ParkPoint {
  const m = TOKENS.motion.parkMap;
  switch (sceneKey) {
    case "LevelSelect":
      return m.holes;
    case "Settings":
      return m.settings;
    case "Play":
      return m.play;
    case "Unlock":
      return m.unlock;
    default:
      return m.menu;
  }
}

function travelVector(fromKey: string, toKey: string): { vx: number; vy: number; active: boolean } {
  const from = parkCoord(fromKey);
  const to = parkCoord(toKey);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 0.001) return { vx: 0, vy: 0, active: false };
  return { vx: dx / len, vy: dy / len, active: true };
}

function describeBackground(bg: ScreenBackground): LayerSpec[] {
  const out: LayerSpec[] = [];
  for (const name of ["far", "mid", "near"] as const) {
    const layer = bg.layers[name];
    const ellipses: EllipseSpec[] = [];
    layer.list.forEach((child) => {
      if (child instanceof Phaser.GameObjects.Ellipse) {
        ellipses.push({
          x: child.x,
          y: child.y,
          w: child.width,
          h: child.height,
          color: child.fillColor,
          alpha: child.fillAlpha,
        });
      }
    });
    out.push({ x: layer.x, y: layer.y, ellipses });
  }
  return out;
}

/** Call on the outgoing scene right before starting the destination scene. */
export function beginSceneTravel(scene: Phaser.Scene, toKey: string): void {
  const v = travelVector(scene.scene.key, toKey);
  const bg = bgByScene.get(scene);
  const plan: TravelPlan = { ...v, snapshot: bg ? describeBackground(bg) : null };
  scene.game.registry.set(REGISTRY_TRAVEL, plan);
}

/** Finish any running travel decoration now (e.g. a putt drag starts). */
export function settleTravel(scene: Phaser.Scene): void {
  const tweens = travelTweens.get(scene);
  if (!tweens) return;
  for (const t of tweens) {
    if (t.isPlaying() || t.isPaused()) t.complete();
  }
  travelTweens.delete(scene);
}

function track(scene: Phaser.Scene, tween: Phaser.Tweens.Tween): void {
  const list = travelTweens.get(scene) ?? [];
  list.push(tween);
  travelTweens.set(scene, list);
}

function buildSnapshot(scene: Phaser.Scene, layers: LayerSpec[]): Phaser.GameObjects.Container {
  const snap = scene.add.container(0, 0);
  const grad = scene.add
    .image(TOKENS.layout.logicalW / 2, TOKENS.layout.logicalH / 2, "ui-bg-gradient")
    .setDisplaySize(TOKENS.layout.logicalW, TOKENS.layout.logicalH);
  snap.add(grad);
  for (const l of layers) {
    const c = scene.add.container(l.x, l.y);
    for (const e of l.ellipses) c.add(scene.add.ellipse(e.x, e.y, e.w, e.h, e.color, e.alpha));
    snap.add(c);
  }
  snap.setDepth(SNAPSHOT_DEPTH);
  return snap;
}

function playSceneArrival(scene: Phaser.Scene, bg: ScreenBackground): void {
  const plan = scene.game.registry.get(REGISTRY_TRAVEL) as TravelPlan | undefined;
  scene.game.registry.set(REGISTRY_TRAVEL, undefined);
  travelTweens.set(scene, []);
  const reduce = reducedMotion();
  const duration = reduce ? REDUCED_MS : TOKENS.motion.duration.base;
  const ease = reduce ? TOKENS.motion.ease.fade : TOKENS.motion.ease.enter;
  if (import.meta.env.MODE !== "production") {
    scene.game.registry.set("pdLastTransitionMs", plan ? duration : 0);
  }
  if (!plan) return;

  const vx = plan.active && !reduce ? plan.vx : 0;
  const vy = plan.active && !reduce ? plan.vy : 0;

  if (plan.snapshot) {
    const snap = buildSnapshot(scene, plan.snapshot);
    track(
      scene,
      scene.tweens.add({
        targets: snap,
        x: -vx * TRAVEL_PX,
        y: -vy * TRAVEL_PX,
        alpha: 0,
        duration,
        ease,
        onComplete: () => snap.destroy(true),
      })
    );
  }

  if (reduce || !plan.active) return;
  const layers: [Phaser.GameObjects.Container, number][] = [
    [bg.layers.far, 0.25],
    [bg.layers.mid, 0.5],
    [bg.layers.near, 1],
  ];
  for (const [layer, k] of layers) {
    const restX = layer.x;
    const restYv = layer.y;
    layer.setPosition(restX + vx * TRAVEL_PX * k, restYv + vy * TRAVEL_PX * k);
    layer.setAlpha(0.7);
    track(
      scene,
      scene.tweens.add({ targets: layer, x: restX, y: restYv, alpha: 1, duration, ease })
    );
  }
}

/**
 * Every scene calls this first thing in create(): sets the logical camera (zoom R, origin 0,0)
 * so UI drawn in 360x640 logical units fills the R-scaled canvas and pointer coordinates map
 * back to logical units, then plays the arrival decoration.
 */
export function sceneFadeIn(scene: Phaser.Scene): void {
  const cam = scene.cameras.main;
  cam.resetFX();
  cam.setAlpha(1);
  applyLogicalCamera(scene);
  const bg = bgByScene.get(scene);
  if (bg) playSceneArrival(scene, bg);
}

export function isTraveling(scene: Phaser.Scene): boolean {
  const tweens = travelTweens.get(scene);
  return !!tweens && tweens.some((t) => t.isPlaying());
}
