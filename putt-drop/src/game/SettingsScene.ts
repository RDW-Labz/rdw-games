import Phaser from "phaser";
import { DEPTH } from "./theme.js";
import { bindBackKey, sceneFadeIn, sceneGo, showScreenToast } from "./juice.js";
import { getSave, updateSave } from "./BootScene.js";
import type { SaveData } from "../progress.js";
import { createDefaultSave } from "../progress.js";
import { setSfxMuted } from "../audio/sfx.js";
import { setMusicMuted } from "../audio/music.js";
import { ScreenBackground } from "../ui/background.js";
import { openBottomSheet } from "../ui/bottomSheet.js";
import { clearSceneControls, unregisterIdPrefix } from "../ui/controls.js";
import { bodyTextStyleUi } from "../ui/fonts.js";
import { panelImage } from "../ui/panel.js";
import { pillButton } from "../ui/pillButton.js";
import { toggleSwitch } from "../ui/toggle.js";
import { ensureUiTextures } from "../ui/textures.js";
import { topBar } from "../ui/topBar.js";
import { TOKENS, cssColor } from "../ui/tokens.js";
import { isTraveling, pocketLayout, registerSceneBackground } from "./travel.js";
import {
  bindReducedMotionListener,
  reducedMotion,
  setReducedMotionPreference,
} from "../ui/motion.js";

declare const __APP_VERSION__: string;

export class SettingsScene extends Phaser.Scene {
  private bg!: ScreenBackground;
  private sheetClose: (() => void) | null = null;
  private unbindMotion?: () => void;

  constructor() {
    super("Settings");
  }

  create(): void {
    this.sheetClose = null;
    clearSceneControls(this.scene.key);
    ensureUiTextures(this);
    this.bg = new ScreenBackground(this);
    registerSceneBackground(this, this.bg);
    sceneFadeIn(this);

    const save = getSave(this);
    setReducedMotionPreference(save.settings.reducedMotion);
    this.unbindMotion?.();
    this.unbindMotion = bindReducedMotionListener();

    const { A, G, Y } = pocketLayout();
    topBar(this, {
      title: "Settings",
      backId: "settings.back",
      onBack: () => sceneGo(this, "Menu", { nav: "back" }),
    });

    const panelH = 320;
    const panelCy = Y + panelH / 2 + TOKENS.space.sm;
    panelImage(this, G + TOKENS.layout.contentW / 2, panelCy, TOKENS.layout.contentW, panelH);

    const rows: { key: keyof SaveData["settings"]; label: string; id: string }[] = [
      { key: "sound", label: "Sound", id: "settings.toggle.sound" },
      { key: "music", label: "Music", id: "settings.toggle.music" },
      { key: "vibration", label: "Vibration", id: "settings.toggle.vibration" },
      { key: "reducedMotion", label: "Reduced motion", id: "settings.toggle.reducedMotion" },
      { key: "colorblindAim", label: "Colorblind-safe aim", id: "settings.toggle.colorblind" },
    ];

    let rowY = Y + TOKENS.space.lg + TOKENS.component.toggle.rowH / 2;
    for (const row of rows) {
      this.add
        .text(G + TOKENS.space.lg + 12, rowY, row.label, bodyTextStyleUi(TOKENS.type.body.size, TOKENS.type.body.weight, cssColor("text")))
        .setOrigin(0, 0.5)
        .setDepth(DEPTH.hud + 2);
      if (row.key === "reducedMotion" && reducedMotion() && !save.settings.reducedMotion) {
        this.add
          .text(G + TOKENS.space.lg + 12, rowY + 14, "Reduced by device setting", bodyTextStyleUi(TOKENS.type.caption.size, TOKENS.type.caption.weight, cssColor("textMuted")))
          .setDepth(DEPTH.hud + 2);
      }
      const toggleCx = TOKENS.layout.logicalW - G - (TOKENS.component.toggle.trackW + 72) / 2;
      toggleSwitch(this, toggleCx, rowY, save.settings[row.key], (on) => {
        const s = getSave(this);
        s.settings[row.key] = on;
        void updateSave(this, s);
        if (row.key === "sound") setSfxMuted(!on);
        if (row.key === "music") setMusicMuted(!on);
        if (row.key === "reducedMotion") setReducedMotionPreference(on);
      }, row.id);
      rowY += TOKENS.component.toggle.rowH;
    }

    const resetCy = A - 132 + TOKENS.component.pill.secondary.h / 2;
    pillButton(this, pocketLayout().CX, resetCy, "Reset progress", () => this.showResetConfirm(), {
      variant: "secondary",
      id: "settings.reset",
    });

    const doneCy = A - 56 + TOKENS.component.pill.primary.h / 2;
    pillButton(this, pocketLayout().CX, doneCy, "Done", () => sceneGo(this, "Menu", { nav: "back" }), {
      variant: "primary",
      id: "settings.done",
    });

    const version = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0";
    this.add
      .text(G + TOKENS.layout.contentW / 2, A - 76 + 2, `Version ${version}`, bodyTextStyleUi(TOKENS.type.caption.size, TOKENS.type.caption.weight, cssColor("textMuted")))
      .setOrigin(0.5, 0)
      .setDepth(DEPTH.hud);

    bindBackKey(this, () => sceneGo(this, "Menu", { nav: "back" }));
    this.events.once("shutdown", () => {
      clearSceneControls(this.scene.key);
      this.sheetClose?.();
      this.sheetClose = null;
      this.unbindMotion?.();
    });
  }

  private showResetConfirm(A = pocketLayout().A): void {
    if (this.sheetClose) return;
    const sheet = openBottomSheet(this, 280, (root) => {
      const title = this.add
        .text(0, -100, "Reset progress?", bodyTextStyleUi(TOKENS.type.screen.size, TOKENS.type.screen.weight, cssColor("text")))
        .setOrigin(0.5);
      const msg = this.add
        .text(0, -48, "Clear scores and stars on this device? Your purchase and settings stay.", bodyTextStyleUi(TOKENS.type.body.size, TOKENS.type.body.weight, cssColor("textMuted")))
        .setOrigin(0.5)
        .setWordWrapWidth(296);
      const cancel = pillButton(this, 0, 24, "Cancel", () => this.closeConfirm(), {
        variant: "secondary",
        width: 296,
        id: "settings.reset.cancel",
        parent: root,
      });
      const ok = pillButton(
        this,
        0,
        88,
        "Reset progress",
        async () => {
          const holeCount = this.registry.get("holeCount") as number;
          const prior = getSave(this);
          const fresh = createDefaultSave(holeCount);
          const next: SaveData = {
            ...fresh,
            unlocked: prior.unlocked,
            settings: prior.settings,
          };
          try {
            await updateSave(this, next);
            setSfxMuted(!next.settings.sound);
            setMusicMuted(!next.settings.music);
            this.closeConfirm();
          } catch {
            showScreenToast(this, "Couldn't reset progress. Try again.", "danger", A - 132);
          }
        },
        { variant: "destructive", width: 296, id: "settings.reset.confirm", parent: root }
      );
      root.add([title, msg]);
    });
    this.sheetClose = sheet.close;
  }

  private closeConfirm(): void {
    this.sheetClose?.();
    this.sheetClose = null;
    unregisterIdPrefix("settings.reset.");
  }

  update(_t: number, dt: number): void {
    if (!this.scene.isActive()) return;
    if (!isTraveling(this)) this.bg.update(dt / 1000);
  }
}
