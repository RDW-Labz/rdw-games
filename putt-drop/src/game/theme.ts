import Phaser from "phaser";
import { unlockAudio } from "../audio/sfx.js";
import { unlockMusic } from "../audio/music.js";
import { bodyTextStyleUi, displayTextStyle, FONT_BODY, FONT_DISPLAY } from "../ui/fonts.js";
import { iconButton } from "../ui/iconButton.js";
import { pillButton } from "../ui/pillButton.js";
import { topBar } from "../ui/topBar.js";
import { TOKENS, cssColor, DEPTH as TOKEN_DEPTH } from "../ui/tokens.js";

export const BG = cssColor("bgBottom");

export const FONT = FONT_BODY;

export const COLORS = {
  bg: TOKENS.color.bgBottom,
  wall: TOKENS.color.rail,
  cup: TOKENS.color.cup,
  ball: TOKENS.color.ballLight,
  sand: TOKENS.color.sand,
  water: TOKENS.color.waterTop,
  slope: TOKENS.color.slope,
  mover: TOKENS.color.mover,
  aim: TOKENS.color.aimBacking,
  lime: TOKENS.color.success,
  amber: TOKENS.color.star,
  red: TOKENS.color.danger,
  magenta: TOKENS.color.bumper,
  text: TOKENS.color.text,
  textDim: TOKENS.color.textMuted,
  panel: TOKENS.color.surfaceTop,
  panelStroke: TOKENS.color.border,
};

export const DEPTH = {
  bg: TOKEN_DEPTH.background,
  level: TOKEN_DEPTH.terrain,
  ball: TOKEN_DEPTH.ball,
  fx: TOKEN_DEPTH.courseFx,
  hud: TOKEN_DEPTH.hud,
  overlay: TOKEN_DEPTH.sheet,
};

export function powerColor(power: number): number {
  if (power < 0.5) return TOKENS.color.aimLow;
  if (power < 0.85) return TOKENS.color.aimMid;
  return TOKENS.color.aimHigh;
}

export function neonTextStyle(fontSize: string, color = TOKENS.textPrimary): Phaser.Types.GameObjects.Text.TextStyle {
  const px = parseInt(fontSize, 10) || 20;
  return displayTextStyle(px, 700, color);
}

export function bodyTextStyle(fontSize = "18px"): Phaser.Types.GameObjects.Text.TextStyle {
  const px = parseInt(fontSize, 10) || 16;
  return bodyTextStyleUi(px, 600);
}

export type InteractiveGo = Phaser.GameObjects.GameObject & {
  setSize(width: number, height: number): Phaser.GameObjects.GameObject;
  setInteractive(
    hitArea?: Phaser.Types.Input.InputConfiguration | Phaser.Geom.Rectangle,
    callback?: Phaser.Types.Input.HitAreaCallback
  ): Phaser.GameObjects.GameObject;
  on(event: string, fn: (...args: unknown[]) => void, context?: unknown): Phaser.GameObjects.GameObject;
  input: Phaser.Types.Input.InteractiveObject | null;
  getBounds(output?: Phaser.Geom.Rectangle): Phaser.Geom.Rectangle;
};

export function setContainerHitArea(obj: InteractiveGo, width: number, height: number): void {
  obj.setSize(width, height);
  obj.setInteractive(
    new Phaser.Geom.Rectangle(-width / 2, -height / 2, width, height),
    Phaser.Geom.Rectangle.Contains
  );
}

/** Scene event: cancel any captured press without activating (emitted by scroll containers past 8px). */
export const UI_CANCEL_PRESS = "ui-cancel-press";

export function bindTap(
  obj: InteractiveGo,
  onTap: () => void,
  onPress?: () => void
): void {
  let pressed = false;
  obj.on("pointerdown", () => {
    pressed = true;
    onPress?.();
  });
  // Leaving the target or a scroll gesture (scene event "ui-cancel-press") cancels activation.
  obj.on("pointerout", () => {
    pressed = false;
  });
  const cancel = (): void => {
    if (!pressed) return;
    pressed = false;
    obj.emit("pointerout");
  };
  const events = obj.scene?.events;
  if (events) {
    events.on(UI_CANCEL_PRESS, cancel);
    obj.once("destroy", () => events.off(UI_CANCEL_PRESS, cancel));
  }
  obj.on("pointerup", (_pointer: Phaser.Input.Pointer, localX: number, localY: number) => {
    if (!pressed) return;
    pressed = false;
    const input = obj.input;
    if (!input?.hitArea || !input.hitAreaCallback) {
      onTap();
      return;
    }
    if (input.hitAreaCallback(input.hitArea, localX, localY, obj)) onTap();
  });
}

export function touchAudioUnlock(): void {
  queueMicrotask(() => {
    unlockAudio();
    unlockMusic();
  });
}

export function safeTopInset(): number {
  return TOKENS.safeTop;
}

export function makeTopBar(scene: Phaser.Scene, title: string, onBack: () => void): number {
  return topBar(scene, {
    title,
    backId: `${scene.scene.key.toLowerCase()}.back`,
    onBack: () => onBack(),
  });
}

export function makeButton(
  scene: Phaser.Scene,
  x: number,
  y: number,
  label: string,
  onClick: () => void,
  width = TOKENS.primaryBtnW
): Phaser.GameObjects.Container {
  return pillButton(scene, x, y, label, onClick, {
    variant: "secondary",
    width,
  });
}

export function makeBackButton(
  scene: Phaser.Scene,
  onBack: () => void,
  _width = 100
): Phaser.GameObjects.Container {
  void _width;
  return iconButton(scene, TOKENS.screenPadding + 28, safeTopInset() + 32, "back", onBack);
}

export function makeNeonLogo(scene: Phaser.Scene): Phaser.GameObjects.Text {
  const title = scene.add
    .text(180, 150, "PUTT DROP", displayTextStyle(48, 700, TOKENS.textPrimary))
    .setOrigin(0.5)
    .setDepth(DEPTH.hud);
  return title;
}
