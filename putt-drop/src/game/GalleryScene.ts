import Phaser from "phaser";
import { loadLevels } from "../levels.js";
import { getSave, updateSave } from "./BootScene.js";
import { applyLogicalCamera } from "./render.js";
import { UI_CANCEL_PRESS } from "./theme.js";
import { ScreenBackground } from "../ui/background.js";
import { clearSceneControls } from "../ui/controls.js";
import { ensureUiTextures } from "../ui/textures.js";
import { pillButton } from "../ui/pillButton.js";
import { iconButton, type IconKind } from "../ui/iconButton.js";
import { toggleSwitch } from "../ui/toggle.js";
import { chip } from "../ui/chip.js";
import { infoCard } from "../ui/card.js";
import { holeCard } from "../ui/holeCard.js";
import { starRow } from "../ui/starRow.js";
import { lockBadge } from "../ui/lockBadge.js";
import { progressDots } from "../ui/progressDots.js";
import { resultCard } from "../ui/resultCard.js";
import { showToast } from "../ui/toast.js";
import { topBar } from "../ui/topBar.js";
import { openBottomSheet } from "../ui/bottomSheet.js";
import { setReducedMotionPreference, bindReducedMotionListener } from "../ui/motion.js";
import { TOKENS, cssColor } from "../ui/tokens.js";
import { bodyTextStyleUi, displayTextStyle } from "../ui/fonts.js";

/** Dev-only component gallery: one full-width column, 24px side margins, logical 360-wide layout. */
const W = TOKENS.layout.logicalW;
const H = TOKENS.layout.logicalH;
const MARGIN = TOKENS.space.xl;
const COL_W = W - MARGIN * 2;
const CX = W / 2;
const SCROLL_CANCEL_PX = 8;

export class GalleryScene extends Phaser.Scene {
  private scrollY = 0;
  private maxScroll = 0;
  private contentTop = 0;
  private content!: Phaser.GameObjects.Container;
  private dragActive = false;
  private dragStartY = 0;
  private dragLastY = 0;
  private dragScrolling = false;
  private unbindMotion: (() => void) | null = null;

  constructor() {
    super("Gallery");
  }

  create(): void {
    clearSceneControls(this.scene.key);
    for (const key of ["Menu", "LevelSelect", "Settings", "Play"]) {
      if (this.scene.isActive(key)) this.scene.stop(key);
    }
    // Same logical 360x640 camera as every other scene (game size is 360R x 640R).
    applyLogicalCamera(this);
    ensureUiTextures(this);
    new ScreenBackground(this);
    const save = getSave(this);
    setReducedMotionPreference(save.settings.reducedMotion);
    this.unbindMotion = bindReducedMotionListener();
    this.scrollY = 0;

    this.contentTop = topBar(this, {
      title: "UI Gallery",
      backId: "gallery.back",
      onBack: () => this.scene.start("Menu"),
    });

    // Content scrolls beneath the top bar (higher depth, opaque, input-blocking), which clips it.
    this.content = this.add.container(0, this.contentTop).setDepth(TOKENS.depth.hud - 10);
    const add = <T extends Phaser.GameObjects.GameObject>(go: T): T => {
      this.content.add(go);
      return go;
    };
    let y = TOKENS.space.sm;

    const section = (label: string): void => {
      add(this.add.text(MARGIN, y, label, displayTextStyle(TOKENS.type.hole.size, TOKENS.type.hole.weight, cssColor("text"))));
      y += 34;
    };
    const note = (label: string, x = MARGIN): Phaser.GameObjects.Text =>
      add(this.add.text(x, y, label, bodyTextStyleUi(TOKENS.type.caption.size, TOKENS.type.caption.weight, cssColor("textMuted"))));
    const pillH = TOKENS.component.pill.primary.h;
    const rowGap = TOKENS.space.md;
    const pill = (
      label: string,
      opts: Parameters<typeof pillButton>[5],
      onClick: () => void = () => this.toast(`${label} tapped`)
    ): Phaser.GameObjects.Container => {
      const p = pillButton(this, CX, y + pillH / 2, label, onClick, {
        width: COL_W,
        parent: this.content,
        ...opts,
      });
      y += pillH + rowGap;
      return p;
    };

    section("Pill buttons");
    pill("Primary action", { id: "gallery.primary" });
    const pressed = pill("Pressed", { id: "gallery.primary.pressed" });
    const pressedFace = pressed.list[0] as Phaser.GameObjects.Container;
    const pressedLabel = pressed.list[1] as Phaser.GameObjects.Text;
    this.time.delayedCall(TOKENS.motion.duration.slow, () => {
      this.tweens.killTweensOf(pressedFace);
      pressedFace.setScale(0.97).setAlpha(1);
      pressedFace.y = 2;
      pressedLabel.y += 2;
    });
    pill("Secondary", { variant: "secondary", id: "gallery.secondary" });
    pill("Selected option", { variant: "secondary", selected: true, id: "gallery.secondary.selected" });
    pill("Disabled", { disabled: true });
    note("Disabled: store unavailable");
    y += 26;
    pill("Destructive", {
      variant: "destructive",
      width: Math.min(COL_W, TOKENS.component.pill.destructive.w),
      id: "gallery.destructive",
    });

    section("Icon buttons");
    const icons: IconKind[] = ["back", "settings", "pause", "close"];
    const iconStep = TOKENS.component.icon.size + TOKENS.space.lg;
    icons.forEach((kind, i) => {
      const ix = MARGIN + TOKENS.component.icon.size / 2 + i * iconStep;
      add(iconButton(this, ix, this.contentTop + y + 28, kind, () => this.toast(`${kind} tapped`), `gallery.icon.${kind}`).setPosition(ix, y + 28));
    });
    y += TOKENS.component.icon.size + TOKENS.space.xl;

    section("Chips");
    const chips = ["Par 3", "Strokes 2 / Par 3", "Assist Off"];
    let chipX = MARGIN;
    for (const label of chips) {
      const c = chip(this, 0, y + 14, label);
      c.x = chipX + c.width / 2;
      chipX += c.width + TOKENS.space.sm;
      add(c);
    }
    y += 28 + TOKENS.space.xl;

    section("Toggles");
    const toggleRow = (label: string, on: boolean, id: string, onChange?: (v: boolean) => void): void => {
      const rowH = TOKENS.component.toggle.rowH;
      add(this.add.text(MARGIN, y + rowH / 2, label, bodyTextStyleUi(TOKENS.type.label.size, TOKENS.type.label.weight, cssColor("text"))).setOrigin(0, 0.5));
      const tx = W - MARGIN - 66;
      toggleSwitch(this, tx, y + rowH / 2, on, (v) => onChange?.(v), id, this.content);
      y += rowH;
    };
    toggleRow("Reduced motion", save.settings.reducedMotion, "gallery.toggle.motion", (v) => {
      const s = getSave(this);
      s.settings.reducedMotion = v;
      setReducedMotionPreference(v);
      void updateSave(this, s);
    });
    toggleRow("Sound (demo)", false, "gallery.toggle.demo");
    y += TOKENS.space.md;

    section("Card");
    add(infoCard(this, CX, y + TOKENS.component.card.minH / 2, "Park card", "Gradient, 1px border, card shadow, radius 20", COL_W));
    y += TOKENS.component.card.minH + TOKENS.space.xl;

    section("Hole cards");
    const levels = loadLevels();
    const gap = TOKENS.space.md;
    const cardW = Math.floor((COL_W - gap) / 2);
    const cardH = TOKENS.component.holeCard.h;
    const states: { label: string; idx: number; opts: Partial<Parameters<typeof holeCard>[5]> }[] = [
      { label: "Available", idx: 0, opts: { stars: 0 } },
      { label: "Current", idx: 1, opts: { stars: 0, highlighted: true } },
      { label: "Completed", idx: 4, opts: { stars: 2, best: 3, completed: true } },
      { label: "Locked", idx: 8, opts: { stars: 0, locked: true } },
    ];
    states.forEach((st, i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const level = levels[Math.min(st.idx, levels.length - 1)];
      const cx = MARGIN + cardW / 2 + col * (cardW + gap);
      const cy = y + row * (cardH + gap + 22) + cardH / 2;
      add(
        holeCard(this, cx, cy, cardW, cardH, {
          holeNum: st.idx + 1,
          par: level.par,
          level,
          stars: 0,
          id: `gallery.hole.${st.label.toLowerCase()}`,
          onPick: st.opts.locked ? undefined : () => this.toast(`Hole ${st.idx + 1}`),
          ...st.opts,
        })
      );
      const t = add(
        this.add.text(cx, cy + cardH / 2 + 6, st.label, bodyTextStyleUi(TOKENS.type.caption.size, TOKENS.type.caption.weight, cssColor("textMuted")))
      );
      t.setOrigin(0.5, 0);
    });
    y += 2 * (cardH + gap + 22) + TOKENS.space.md;

    section("Stars, lock, progress");
    for (let earned = 0; earned <= 3; earned++) {
      const sx = MARGIN + 33 + earned * 78;
      add(starRow(this, sx, y + 12, earned, "small"));
    }
    y += 24 + TOKENS.space.md;
    add(starRow(this, MARGIN + 54, y + 16, 3, "result"));
    add(lockBadge(this, W - MARGIN - 50, y + 16));
    y += 32 + TOKENS.space.lg;
    const pd1 = add(progressDots(this, 0, y + 10, 2, 4));
    pd1.x = MARGIN + 60;
    add(progressDots(this, W - MARGIN - 40, y + 10, 7, 12));
    y += 20 + TOKENS.space.xl;

    section("Result card");
    const rh = TOKENS.component.result.h;
    add(resultCard(this, CX, y + rh / 2, { strokes: 3, par: 3, stars: 2, best: 4, improved: true }, COL_W, () => this.toast("Next hole")));
    y += rh + TOKENS.space.xl;

    section("Toast & sheet");
    const toast = showToast(this, "Progress saved", "success", undefined, { width: COL_W, persist: true });
    this.tweens.killTweensOf(toast);
    toast.setAlpha(1);
    toast.setPosition(CX, y + toast.height / 2);
    add(toast);
    y += toast.height + TOKENS.space.md;
    const warn = showToast(this, "Couldn't reach the store. Check your connection and try again.", "warning", () => undefined, { width: COL_W, persist: true });
    this.tweens.killTweensOf(warn);
    warn.setAlpha(1);
    warn.setPosition(CX, y + warn.height / 2);
    add(warn);
    y += warn.height + TOKENS.space.lg;
    pill("Open bottom sheet", { variant: "secondary", id: "gallery.sheet" }, () => this.openDemoSheet());

    const viewH = H - this.contentTop;
    this.maxScroll = Math.max(0, y + MARGIN - viewH);
    this.bindScroll();

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      clearSceneControls(this.scene.key);
      this.unbindMotion?.();
      this.input.off("pointerdown");
      this.input.off("pointermove");
      this.input.off("pointerup");
      this.input.off("wheel");
    });
  }

  private openDemoSheet(): void {
    const sheetH = 260;
    const sheet = openBottomSheet(this, sheetH, (root) => {
      const inner = TOKENS.layout.sheetInnerW;
      const title = this.add.text(0, 0, "Paused", displayTextStyle(TOKENS.type.screen.size, TOKENS.type.screen.weight, cssColor("text")));
      title.setPosition(-Math.round(title.width / 2), -sheetH / 2 + 24);
      root.add(title);
      pillButton(this, 0, -sheetH / 2 + 104, "Resume", () => sheet.close(), { width: inner, parent: root, id: "gallery.sheet.resume" });
      pillButton(this, 0, -sheetH / 2 + 172, "Restart hole", () => sheet.close(), {
        variant: "secondary",
        width: inner,
        parent: root,
        id: "gallery.sheet.restart",
      });
    });
  }

  private toast(msg: string): void {
    showToast(this, msg, "success");
  }

  private bindScroll(): void {
    this.input.on("wheel", (_p: Phaser.Input.Pointer, _o: unknown, _dx: number, dy: number) => {
      this.setScroll(this.scrollY + dy * 0.5);
    });
    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
      // worldY is logical (camera zoom R); p.y is in canvas pixels.
      if (p.worldY < this.contentTop) return;
      this.dragActive = true;
      this.dragScrolling = false;
      this.dragStartY = p.worldY;
      this.dragLastY = p.worldY;
    });
    this.input.on("pointermove", (p: Phaser.Input.Pointer) => {
      if (!this.dragActive || !p.isDown) return;
      if (!this.dragScrolling && Math.abs(p.worldY - this.dragStartY) > SCROLL_CANCEL_PX) {
        this.dragScrolling = true;
        this.events.emit(UI_CANCEL_PRESS);
      }
      if (this.dragScrolling) this.setScroll(this.scrollY + (this.dragLastY - p.worldY));
      this.dragLastY = p.worldY;
    });
    this.input.on("pointerup", () => {
      this.dragActive = false;
      this.dragScrolling = false;
    });
  }

  private setScroll(v: number): void {
    this.scrollY = Phaser.Math.Clamp(v, 0, this.maxScroll);
    this.content.y = Math.round(this.contentTop - this.scrollY);
  }

  scrollByForTest(offset: number): void {
    this.setScroll(this.scrollY + offset);
  }
}
