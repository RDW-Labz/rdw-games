import Phaser from "phaser";
import { TOKENS } from "./tokens.js";
import { reducedMotion } from "./motionPolicy.js";

export { setReducedMotionPreference, reducedMotion, bindReducedMotionListener } from "./motionPolicy.js";

export interface PressFxTarget {
  face: Phaser.GameObjects.Image | Phaser.GameObjects.Graphics | Phaser.GameObjects.Container;
  label?: Phaser.GameObjects.Text;
  scene: Phaser.Scene;
  onRelease?: () => void;
}

type Movable = Phaser.GameObjects.GameObject & {
  x: number;
  y: number;
  alpha: number;
  setData(key: string, value: unknown): unknown;
  getData(key: string): unknown;
};

/** Resting y of an object, recorded the first time an effect touches it (never accumulates offsets). */
function restY(o: Movable): number {
  const v = o.getData("restY");
  if (typeof v === "number") return v;
  o.setData("restY", o.y);
  return o.y;
}

function tint(face: PressFxTarget["face"], on: boolean): void {
  const apply = (o: Phaser.GameObjects.GameObject): void => {
    if (o instanceof Phaser.GameObjects.Image) {
      if (on) o.setTint(0xf2f2f2);
      else o.clearTint();
    }
  };
  if (face instanceof Phaser.GameObjects.Container) face.each(apply);
  else apply(face);
}

/** buttonPress: immediate tint, face scale 0.97 and y+2, label y+2 only (never scaled). */
export function pressFx(target: PressFxTarget): void {
  const { scene, face, label } = target;
  const f = face as unknown as Movable;
  const fy = restY(f);
  scene.tweens.killTweensOf(face);
  tint(face, true);
  if (reducedMotion()) return;
  const d = TOKENS.motion.duration.instant;
  const ease = TOKENS.motion.ease.press;
  f.alpha = 1;
  scene.tweens.add({ targets: face, scaleX: 0.97, scaleY: 0.97, y: fy + 2, duration: d, ease });
  if (label) {
    const ly = restY(label as unknown as Movable);
    scene.tweens.killTweensOf(label);
    scene.tweens.add({ targets: label, y: ly + 2, duration: d, ease });
  }
}

/** buttonRelease: back to scale 1 / rest y. onRelease runs first (action already executed by caller). */
export function releaseFx(target: PressFxTarget): void {
  const { scene, face, label, onRelease } = target;
  onRelease?.();
  const f = face as unknown as Movable;
  const fy = restY(f);
  tint(face, false);
  scene.tweens.killTweensOf(face);
  if (reducedMotion()) {
    (face as Phaser.GameObjects.Container).setScale?.(1);
    f.y = fy;
    if (label) label.y = restY(label as unknown as Movable);
    return;
  }
  const d = TOKENS.motion.duration.quick;
  const ease = TOKENS.motion.ease.release;
  scene.tweens.add({ targets: face, scaleX: 1, scaleY: 1, y: fy, duration: d, ease });
  if (label) {
    const ly = restY(label as unknown as Movable);
    scene.tweens.killTweensOf(label);
    scene.tweens.add({ targets: label, y: ly, duration: d, ease });
  }
}

/** Cancel (pointer-out / scroll): snap back without action. */
export function cancelPressFx(target: PressFxTarget): void {
  const { scene, face, label } = target;
  const f = face as unknown as Movable;
  scene.tweens.killTweensOf(face);
  tint(face, false);
  (face as Phaser.GameObjects.Container).setScale?.(1);
  f.y = restY(f);
  f.alpha = 1;
  if (label) {
    scene.tweens.killTweensOf(label);
    label.y = restY(label as unknown as Movable);
  }
}

export interface AppearOptions {
  stagger?: number;
  card?: boolean;
}

/**
 * cardAppear: face y+8 and alpha 0.7 -> rest. controlAppear (buttons): face alpha 0.7 -> 1 and
 * scale 0.96 -> 1 about its center, so the face edge never leaves its final hit rect while the
 * label and hit area are final from the first frame. Reduced motion: 80ms fade only.
 */
export function appearFx(
  scene: Phaser.Scene,
  targets: Phaser.GameObjects.GameObject[],
  opts: AppearOptions = {}
): void {
  const reduce = reducedMotion();
  const card = opts.card ?? false;
  const stagger = reduce ? 0 : (opts.stagger ?? TOKENS.motion.duration.stagger);
  const d = reduce ? TOKENS.motion.duration.instant : TOKENS.motion.duration.quick;
  const cap = 72;
  let delay = 0;
  for (const t of targets) {
    if (!t) continue;
    const o = t as Movable & { setScale?: (s: number) => unknown };
    const base = restY(o);
    scene.tweens.killTweensOf(o);
    const props: Record<string, number> = { alpha: 1 };
    o.alpha = 0.7;
    if (!reduce && card) {
      o.y = base + 8;
      props.y = base;
    } else if (!reduce && o.setScale) {
      o.setScale(0.96);
      props.scaleX = 1;
      props.scaleY = 1;
    }
    scene.tweens.add({
      targets: o,
      ...props,
      duration: d,
      delay: Math.min(delay, cap),
      ease: reduce ? TOKENS.motion.ease.fade : TOKENS.motion.ease.enter,
    });
    delay += stagger;
  }
}

export function exitFx(scene: Phaser.Scene, targets: Phaser.GameObjects.GameObject[]): void {
  const d = TOKENS.motion.duration.instant;
  for (const t of targets) {
    scene.tweens.add({
      targets: t,
      alpha: 0,
      duration: d,
      ease: TOKENS.motion.ease.fade,
    });
  }
}

export function snapAppearFace(face: Phaser.GameObjects.GameObject): void {
  const f = face as Movable;
  f.scene.tweens.killTweensOf(f);
  f.y = restY(f);
  f.alpha = 1;
  (f as unknown as Phaser.GameObjects.Container).setScale?.(1);
}
