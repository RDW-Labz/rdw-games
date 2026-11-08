import Phaser from "phaser";
import { bindTap } from "../game/theme.js";
import { faceImage, bakePanelTexture } from "./textures.js";
import { TOKENS } from "./tokens.js";
import { reducedMotion } from "./motion.js";

export interface BottomSheetHandle {
  container: Phaser.GameObjects.Container;
  content: Phaser.GameObjects.Container;
  panelW: number;
  panelH: number;
  close(): void;
}

function disableInputDeep(o: Phaser.GameObjects.GameObject): void {
  if (o.input) o.disableInteractive();
  if (o instanceof Phaser.GameObjects.Container) o.each(disableInputDeep);
}

/**
 * Modal bottom sheet: scrim (alpha 0.32, blocks course input from the first frame) plus a raised
 * R28 panel with sheet shadow and a decorative handle. Controls are placed at their final
 * coordinates immediately; only the panel face animates (sheetIn / sheetOut from motion.md).
 */
export function openBottomSheet(
  scene: Phaser.Scene,
  panelH: number,
  buildContent: (root: Phaser.GameObjects.Container) => void
): BottomSheetHandle {
  const W = TOKENS.layout.logicalW;
  const H = TOKENS.layout.logicalH;
  const panelW = TOKENS.component.sheet.w;
  const root = scene.add.container(0, 0);
  root.setDepth(TOKENS.depth.scrim);

  const scrim = scene.add.rectangle(W / 2, H / 2, W, H, TOKENS.color.scrim, 1).setAlpha(0);
  scrim.setInteractive();
  const targetY = H - panelH / 2 - TOKENS.layout.safeBottom / 2;
  const content = scene.add.container(W / 2, targetY);
  const panel = faceImage(scene, bakePanelTexture(scene, panelW, panelH, "sheet"), panelW, panelH);
  const { handleW, handleH } = TOKENS.component.sheet;
  const handle = scene.add
    .rectangle(0, -panelH / 2 + TOKENS.space.sm + handleH / 2, handleW, handleH, TOKENS.color.border, 1)
    .setOrigin(0.5);
  const face = scene.add.container(0, 0, [panel, handle]);
  content.add(face);
  const inner = scene.add.container(0, 0);
  content.add(inner);
  buildContent(inner);
  root.add([scrim, content]);

  const reduce = reducedMotion();
  const instant = TOKENS.motion.duration.instant;
  scene.tweens.add({ targets: scrim, alpha: 0.32, duration: instant, ease: TOKENS.motion.ease.fade });
  face.y = reduce ? 0 : 16;
  face.alpha = 0.75;
  scene.tweens.add({
    targets: face,
    y: 0,
    alpha: 1,
    duration: reduce ? instant : TOKENS.motion.duration.base,
    ease: reduce ? TOKENS.motion.ease.fade : TOKENS.motion.ease.enter,
  });

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    // Modal ownership ends now: nothing in the sheet accepts input during the exit fade.
    disableInputDeep(root);
    scene.tweens.killTweensOf([scrim, face, content]);
    scene.tweens.add({ targets: scrim, alpha: 0, duration: instant, ease: TOKENS.motion.ease.fade });
    scene.tweens.add({
      targets: content,
      y: reduce ? content.y : content.y + 12,
      alpha: 0,
      duration: reduce ? instant : TOKENS.motion.duration.quick,
      ease: TOKENS.motion.ease.exit,
      onComplete: () => root.destroy(),
    });
  };

  bindTap(scrim, close);

  return { container: root, content, panelW, panelH, close };
}
