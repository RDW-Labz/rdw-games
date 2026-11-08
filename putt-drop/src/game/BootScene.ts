import Phaser from "phaser";
import { loadLevels } from "../levels.js";
import { initBilling, isProductOwned, onEntitlementChange, seedEntitlementCache } from "../platform/billing.js";
import { applyEntitlementFlag, loadSave, persistSave, syncEntitlementOnLaunch } from "../platform/save.js";
import { ensureHoleSlots, type SaveData } from "../progress.js";
import { applyLogicalCamera, configureCrispCanvas } from "./render.js";
import { loadGameFonts, fontsReadyForMenu, displayTextStyle } from "../ui/fonts.js";
import { ensureUiTextures } from "../ui/textures.js";
import { markGlobalTexture } from "./textureCache.js";
import { ScreenBackground } from "../ui/background.js";
import { progressDots } from "../ui/progressDots.js";
import { TOKENS, cssColor } from "../ui/tokens.js";
import { bodyTextStyleUi } from "../ui/fonts.js";
import { beginSceneTravel, pocketLayout, registerSceneBackground } from "./travel.js";
import { showToast } from "../ui/toast.js";
import { setReducedMotionPreference } from "../ui/motion.js";

export const REGISTRY_SAVE = "save";
/** Longest the boot screen waits for Google Play before continuing with the cached entitlement. */
const BILLING_BOOT_WAIT_MS = 4000;

export class BootScene extends Phaser.Scene {
  private dots?: Phaser.GameObjects.Container;
  private stage = 0;

  constructor() {
    super("Boot");
  }

  create(): void {
    configureCrispCanvas(this.game);
    applyLogicalCamera(this);
    this.cameras.main.setBackgroundColor(TOKENS.color.bgTop);
    if (typeof document !== "undefined") {
      const sky = cssColor("bgTop");
      document.documentElement.style.background = sky;
      document.body.style.background = sky;
    }
    ensureUiTextures(this);
    const bg = new ScreenBackground(this);
    registerSceneBackground(this, bg);

    const { CX, T, A } = pocketLayout();
    const markY = T + (A - T) * 0.42;
    const mark = this.add
      .text(CX, markY, "PD", displayTextStyle(40, 700, cssColor("text")))
      .setOrigin(0.5)
      .setAlpha(0);
    this.tweens.add({
      targets: mark,
      alpha: 1,
      duration: TOKENS.motion.duration.instant,
      ease: TOKENS.motion.ease.fade,
    });

    this.dots = progressDots(this, CX, markY + 72, 1, 3);
    const caption = this.add
      .text(CX, markY + 96, "", bodyTextStyleUi(TOKENS.type.caption.size, TOKENS.type.caption.weight, cssColor("textMuted")))
      .setOrigin(0.5)
      .setAlpha(0);

    void this.bootLoad(mark, caption);
  }

  private async bootLoad(
    mark: Phaser.GameObjects.Text,
    caption: Phaser.GameObjects.Text
  ): Promise<void> {
    this.setStage(1);
    await loadGameFonts(2500);
    const fontDeadline = Date.now() + 2500;
    while (!fontsReadyForMenu() && Date.now() < fontDeadline) {
      await new Promise((r) => setTimeout(r, 40));
    }
    this.registry.set("fontsReady", fontsReadyForMenu());
    this.setStage(2);

    const levels = loadLevels();
    let save = await loadSave(levels.length);
    save = ensureHoleSlots(save, levels.length);
    // Entitlement: start from the cached flag (works offline), then let Play correct it.
    // Boot waits at most BILLING_BOOT_WAIT_MS; a later Play answer still updates the save.
    seedEntitlementCache(save.unlocked);
    this.game.registry.set(REGISTRY_SAVE, save);
    onEntitlementChange((owned) => {
      const current = this.game.registry.get(REGISTRY_SAVE) as SaveData;
      const next = applyEntitlementFlag(current, owned);
      if (next !== current) {
        this.game.registry.set(REGISTRY_SAVE, next);
        void persistSave(next);
      }
    });
    await Promise.race([
      initBilling().then(() => syncEntitlementOnLaunch(this.game.registry.get(REGISTRY_SAVE) as SaveData)),
      new Promise((r) => setTimeout(r, BILLING_BOOT_WAIT_MS)),
    ]);
    save = applyEntitlementFlag(this.game.registry.get(REGISTRY_SAVE) as SaveData, isProductOwned());
    if (save !== this.game.registry.get(REGISTRY_SAVE)) await persistSave(save);
    setReducedMotionPreference(save.settings.reducedMotion);
    this.registry.set(REGISTRY_SAVE, save);
    this.registry.set("holeCount", levels.length);
    this.setStage(3);

    const g = this.add.graphics();
    g.fillStyle(0xffffff, 1);
    g.fillCircle(8, 8, 8);
    g.generateTexture("particle-dot", 16, 16);
    markGlobalTexture("particle-dot");
    g.destroy();

    if (fontsReadyForMenu()) {
      caption.setText("Opening the park…");
      this.tweens.add({ targets: caption, alpha: 1, duration: TOKENS.motion.duration.instant });
    }

    this.time.delayedCall(80, () => {
      beginSceneTravel(this, "Menu");
      this.scene.start("Menu");
    });
  }


  private setStage(n: number): void {
    this.stage = n;
    if (this.dots) {
      this.dots.destroy();
      const { CX, T, A } = pocketLayout();
      const markY = T + (A - T) * 0.42;
      this.dots = progressDots(this, CX, markY + 72, n, 3);
    }
  }
}

export async function updateSave(scene: Phaser.Scene, save: SaveData): Promise<void> {
  scene.registry.set(REGISTRY_SAVE, save);
  try {
    await persistSave(save);
  } catch {
    showToast(scene, "Couldn't save. Progress may be lost when you close.", "danger", () => {
      void updateSave(scene, getSave(scene));
    });
  }
}

export function getSave(scene: Phaser.Scene): SaveData {
  return scene.registry.get(REGISTRY_SAVE) as SaveData;
}
