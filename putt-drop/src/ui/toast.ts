import Phaser from "phaser";
import { bodyTextStyleUi } from "./fonts.js";
import { bakePanelTexture, faceImage } from "./textures.js";
import { TOKENS, cssColor } from "./tokens.js";
import { reducedMotion } from "./motion.js";

export type ToastSeverity = "success" | "warning" | "danger";

/** Severity glyph (check / ! / x) in white on a 20px colored disc; static geometry. */
function severityIcon(scene: Phaser.Scene, severity: ToastSeverity, color: number): Phaser.GameObjects.Graphics {
  const r = TOKENS.component.toast.icon / 2;
  const g = scene.add.graphics();
  g.fillStyle(color, 1);
  g.fillCircle(0, 0, r);
  g.lineStyle(2, TOKENS.color.highlight, 1);
  if (severity === "success") {
    g.beginPath();
    g.moveTo(-4.5, 0.5);
    g.lineTo(-1.5, 3.5);
    g.lineTo(4.5, -3);
    g.strokePath();
  } else if (severity === "warning") {
    g.lineBetween(0, -5, 0, 1.5);
    g.fillStyle(TOKENS.color.highlight, 1);
    g.fillCircle(0, 4.5, 1.2);
  } else {
    g.lineBetween(-3.5, -3.5, 3.5, 3.5);
    g.lineBetween(3.5, -3.5, -3.5, 3.5);
  }
  return g;
}

/**
 * Inert toast: raised gradient panel W328, min H64 (grows to max 108 for 3 lines), severity icon
 * plus text (never color alone). Optional Retry has its own 64x56 target.
 */
export function showToast(
  scene: Phaser.Scene,
  message: string,
  severity: ToastSeverity = "success",
  onRetry?: () => void,
  opts: { width?: number; persist?: boolean } = {}
): Phaser.GameObjects.Container {
  const spec = { ...TOKENS.component.toast, w: opts.width ?? TOKENS.component.toast.w };
  const color =
    severity === "success" ? TOKENS.color.success : severity === "warning" ? TOKENS.color.warning : TOKENS.color.danger;
  const left = -spec.w / 2 + spec.pad;
  const retryW = onRetry ? 64 : 0;
  const textX = left + spec.icon + spec.gap;
  const text = scene.add.text(0, 0, message, {
    ...bodyTextStyleUi(TOKENS.type.body.size, TOKENS.type.body.weight, cssColor("text")),
    wordWrap: { width: spec.w / 2 - spec.pad - retryW - textX, useAdvancedWrap: true },
    maxLines: 3,
  });
  const h = Math.min(spec.maxH, Math.max(spec.minH, Math.ceil(text.height + spec.pad * 2)));
  text.setPosition(Math.round(textX), -Math.round(text.height / 2));
  const panel = faceImage(scene, bakePanelTexture(scene, spec.w, h, "raised"), spec.w, h);
  const icon = severityIcon(scene, severity, color);
  icon.setPosition(left + spec.icon / 2, 0);
  const parts: Phaser.GameObjects.GameObject[] = [panel, icon, text];
  if (onRetry) {
    const retryLabel = scene.add
      .text(spec.w / 2 - 32, 0, "Retry", bodyTextStyleUi(TOKENS.type.label.size, TOKENS.type.label.weight, cssColor("success")))
      .setOrigin(0.5);
    const retryHit = scene.add
      .rectangle(spec.w / 2 - 32, 0, 64, 56, 0x000000, 0.001)
      .setInteractive({ useHandCursor: true });
    retryHit.on("pointerup", () => onRetry());
    parts.push(retryLabel, retryHit);
  }
  const restY = TOKENS.layout.logicalH - TOKENS.layout.safeBottom - h / 2;
  const root = scene.add.container(TOKENS.layout.logicalW / 2, restY, parts);
  root.setSize(spec.w, h);
  root.setDepth(TOKENS.depth.toast);
  const reduce = reducedMotion();
  root.alpha = 0.7;
  root.y = restY + (reduce ? 0 : 6);
  scene.tweens.add({
    targets: root,
    alpha: 1,
    y: restY,
    duration: reduce ? TOKENS.motion.duration.instant : TOKENS.motion.duration.quick,
    ease: TOKENS.motion.ease.enter,
  });
  if (!onRetry && !opts.persist) {
    scene.time.delayedCall(TOKENS.motion.duration.toastHold, () => {
      if (!root.active) return;
      scene.tweens.add({
        targets: root,
        alpha: 0,
        duration: TOKENS.motion.duration.quick,
        onComplete: () => root.destroy(),
      });
    });
  }
  return root;
}
