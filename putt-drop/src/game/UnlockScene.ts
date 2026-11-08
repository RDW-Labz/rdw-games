import Phaser from "phaser";
import { bindBackKey, sceneFadeIn, sceneGo, showScreenToast } from "./juice.js";
import { getSave, updateSave } from "./BootScene.js";
import { FREE_HOLE_COUNT, fullGameOnSale } from "../progress.js";
import { paidOfferLine } from "./course/worldsCatalog.js";
import {
  billingAvailable,
  isAndroidApp,
  isPurchasePending,
  onEntitlementChange,
  onProductMetadataChange,
  productPrice,
  purchaseUnlock,
  restorePurchases,
} from "../platform/billing.js";
import { applyEntitlementFlag } from "../platform/save.js";
import { loadLevels } from "../levels.js";
import { ScreenBackground } from "../ui/background.js";
import { clearSceneControls } from "../ui/controls.js";
import { bodyTextStyleUi, displayTextStyle } from "../ui/fonts.js";
import { panelImage } from "../ui/panel.js";
import { pillButton } from "../ui/pillButton.js";
import { ensureUiTextures } from "../ui/textures.js";
import { topBar } from "../ui/topBar.js";
import { TOKENS, cssColor } from "../ui/tokens.js";
import { isTraveling, pocketLayout, registerSceneBackground } from "./travel.js";
import { appearFx } from "../ui/motion.js";
import { pixelCenteredText } from "../ui/pillButton.js";
import { disabledPillTexture, faceImage } from "../ui/textures.js";
import { bindTap, touchAudioUnlock } from "./theme.js";
import { sfxUiTap } from "../audio/sfx.js";
import { registerControlCenter } from "../ui/controls.js";

/** Test builds only: registry key read once by the next Unlock create() to force a state. */
export const UNLOCK_FIXTURE_KEY = "unlockFixtureState";

export type UnlockFixtureState =
  | "default"
  | "purchasing"
  | "success"
  | "cancelled"
  | "failed"
  | "restore";

const HUD = TOKENS.depth.hud;

/**
 * Honest full-game offer (brief.md, screens.md sections 9-12): what you get from the real level
 * count, price only from Google Play (never hardcoded), Restore purchases (always present), and a
 * clear way to keep playing the free holes. The real offer appears only when fullGameOnSale(). No countdowns, discounts or pre-checked anything.
 */
export class UnlockScene extends Phaser.Scene {
  private bg!: ScreenBackground;
  private intendedHole = -1;
  private uiState: UnlockFixtureState = "default";
  private purchaseInFlight = false;
  private restoreInFlight = false;
  private footerTop = 0;
  private onSale = false;
  private shownUnlocked = false;
  private billingUnsub: (() => void) | null = null;
  private metadataUnsub: (() => void) | null = null;

  constructor() {
    super("Unlock");
  }

  init(data: { intendedHole?: number; keepFlags?: boolean }): void {
    this.intendedHole = typeof data?.intendedHole === "number" ? data.intendedHole : -1;
    // keepFlags: re-render during an in-flight purchase/restore ("Waiting for store" / "Restoring…").
    if (!data?.keepFlags) {
      this.purchaseInFlight = false;
      this.restoreInFlight = false;
    }
    this.uiState = "default";
    if (import.meta.env.MODE !== "production") {
      // Consumed once so a forced state never leaks into later visits.
      this.uiState =
        (this.registry.get(UNLOCK_FIXTURE_KEY) as UnlockFixtureState | undefined) ?? "default";
      this.registry.remove(UNLOCK_FIXTURE_KEY);
    }
  }

  create(): void {
    clearSceneControls(this.scene.key);
    ensureUiTextures(this);
    this.bg = new ScreenBackground(this);
    registerSceneBackground(this, this.bg);
    sceneFadeIn(this);

    const { A, G, Y } = pocketLayout();
    const levels = loadLevels();
    const save = getSave(this);
    const onSale = fullGameOnSale(levels.length);
    const success = this.uiState === "success" || save.unlocked;
    this.shownUnlocked = save.unlocked;

    topBar(this, {
      title: "Full game",
      backId: "unlock.back",
      onBack: () => this.goBack(),
    });

    if (success) this.buildSuccess(A, G, Y, levels.length);
    else this.buildOffer(A, G, Y, levels.length, onSale);

    if (import.meta.env.MODE !== "production" && this.uiState !== "default") {
      // screens.md: forced store states must carry a visible "Store fixture" badge.
      this.add
        .text(TOKENS.layout.logicalW - G, Y - 8, "Store fixture", bodyTextStyleUi(TOKENS.type.caption.size, TOKENS.type.caption.weight, cssColor("textMuted")))
        .setOrigin(1, 1)
        .setDepth(HUD);
    }

    bindBackKey(this, () => this.goBack());
    // Play's answer can arrive while this screen is open (launch refresh, a pending purchase
    // completing, a refund). BootScene's listener persists the flag; here we only re-render.
    this.billingUnsub = onEntitlementChange((owned) => {
      if (!this.scene.isActive() || owned === this.shownUnlocked) return;
      void updateSave(this, applyEntitlementFlag(getSave(this), owned)).then(() => {
        if (this.scene.isActive()) this.scene.restart({ intendedHole: this.intendedHole, keepFlags: true });
      });
    });
    this.metadataUnsub = onProductMetadataChange(() => {
      if (this.scene.isActive() && !getSave(this).unlocked && this.uiState === "default") {
        this.scene.restart({ intendedHole: this.intendedHole, keepFlags: true });
      }
    });
    this.events.once("shutdown", () => {
      clearSceneControls(this.scene.key);
      this.billingUnsub?.();
      this.metadataUnsub?.();
    });
  }

  private goBack(): void {
    sceneGo(this, "LevelSelect", { nav: "back" });
  }

  private buildSuccess(A: number, G: number, Y: number, total: number): void {
    const cx = G + TOKENS.layout.contentW / 2;
    const card = panelImage(this, cx, Y + 112, TOKENS.layout.contentW, 224).setDepth(HUD - 1);
    const check = this.add.circle(cx, Y + 16 + 28, 28, TOKENS.color.success).setDepth(HUD);
    check.setStrokeStyle(2, TOKENS.color.highlight, 1);
    const tick = this.add.graphics().setDepth(HUD);
    tick.lineStyle(4, TOKENS.color.highlight, 1);
    tick.beginPath();
    tick.moveTo(cx - 11, Y + 45);
    tick.lineTo(cx - 3, Y + 53);
    tick.lineTo(cx + 12, Y + 36);
    tick.strokePath();
    this.add
      .text(cx, Y + 108, "Full game unlocked", displayTextStyle(TOKENS.type.display.size, TOKENS.type.display.weight, cssColor("text")))
      .setOrigin(0.5)
      .setDepth(HUD);
    this.add
      .text(G + TOKENS.space.lg, Y + 140, paidContentLine(total), bodyTextStyleUi(TOKENS.type.body.size, TOKENS.type.body.weight, cssColor("textMuted")))
      .setOrigin(0, 0)
      .setWordWrapWidth(296)
      .setDepth(HUD);
    appearFx(this, [card], { card: true });

    const primaryCy = A - 120 + TOKENS.component.pill.primary.h / 2;
    const holesCy = A - 56 + TOKENS.component.pill.secondary.h / 2;
    const target =
      this.intendedHole >= FREE_HOLE_COUNT && this.intendedHole < total
        ? this.intendedHole
        : total > FREE_HOLE_COUNT
          ? FREE_HOLE_COUNT
          : -1;
    const primaryLabel = target >= 0 ? `Play hole ${target + 1}` : "Back to holes";
    pillButton(
      this,
      pocketLayout().CX,
      primaryCy,
      primaryLabel,
      () => {
        if (target >= 0) sceneGo(this, "Play", { holeIndex: target });
        else sceneGo(this, "LevelSelect");
      },
      { variant: "primary", id: "unlock.success.play" }
    );
    pillButton(this, pocketLayout().CX, holesCy, "Holes", () => sceneGo(this, "LevelSelect"), {
      variant: "secondary",
      id: "unlock.success.holes",
    });
  }

  private buildOffer(A: number, G: number, Y: number, total: number, onSale: boolean): void {
    this.onSale = onSale;
    const cx = G + TOKENS.layout.contentW / 2;
    const card = panelImage(this, cx, Y + 112, TOKENS.layout.contentW, 224).setDepth(HUD - 1);
    this.add
      .text(G + 16, Y + 16, "Unlock full game", displayTextStyle(TOKENS.type.screen.size, TOKENS.type.screen.weight, cssColor("text")))
      .setOrigin(0, 0)
      .setDepth(HUD);
    // Real store offer only when the catalog has paid holes AND Google Play billing is connected.
    const billingLive = onSale && billingAvailable();
    const price = billingLive ? productPrice() : null;
    const feature = onSale ? paidOfferLine(loadLevels()) : `The ${FREE_HOLE_COUNT} free holes are ready to play. Full-game unlock isn't available in this build.`;
    this.add
      .text(G + 16, Y + 58, feature, bodyTextStyleUi(TOKENS.type.body.size, TOKENS.type.body.weight, cssColor("text")))
      .setOrigin(0, 0)
      .setWordWrapWidth(296)
      .setDepth(HUD);
    this.add
      .text(G + 16, Y + 136, "Play offline. No ads. No subscription.", bodyTextStyleUi(TOKENS.type.body.size, TOKENS.type.body.weight, cssColor("textMuted")))
      .setOrigin(0, 0)
      .setWordWrapWidth(296)
      .setDepth(HUD);
    appearFx(this, [card], { card: true });

    const purchasing = this.uiState === "purchasing" || this.purchaseInFlight;
    const storeReady = billingLive && price != null;
    const priceLoading = billingLive && price == null;
    const caption = !onSale
      ? "Not on sale yet"
      : purchasing
        ? "Complete your purchase in the store."
        : isPurchasePending()
          ? "Purchase pending. Unlocks when payment completes."
          : priceLoading
            ? "Store price is loading"
            : billingLive
              ? "One-time purchase"
              : "Store unavailable. Free holes still work.";
    this.add
      .text(G, A - 210, caption, bodyTextStyleUi(TOKENS.type.caption.size, TOKENS.type.caption.weight, cssColor("textMuted")))
      .setOrigin(0, 0)
      .setDepth(HUD);

    this.footerTop = A - 184;
    const purchaseCy = this.footerTop + TOKENS.component.pill.primary.h / 2;
    const restoreCy = A - 120 + TOKENS.component.pill.secondary.h / 2;
    const freeCy = A - 56 + TOKENS.component.pill.secondary.h / 2;
    const { CX } = pocketLayout();
    const pillW = TOKENS.component.pill.primary.w;
    const pillH = TOKENS.component.pill.primary.h;

    if (storeReady) {
      pillButton(
        this,
        CX,
        purchaseCy,
        purchasing ? "Waiting for store" : `Unlock full game · ${price}`,
        () => void this.onPurchase(this.footerTop),
        { variant: "primary", id: "unlock.purchase", disabled: purchasing }
      );
    } else if (priceLoading) {
      pillButton(this, CX, purchaseCy, "Loading price…", () => {}, {
        variant: "primary",
        id: "unlock.purchase",
        disabled: true,
      });
    } else {
      this.addDisabledUnlockPill(CX, purchaseCy, pillW, pillH, this.footerTop, onSale ? "Price unavailable" : "Not on sale yet");
    }

    // brief.md: Restore purchases is always on the offer. Where Google Play isn't available it
    // explains why instead of pretending to restore (see onRestore).
    pillButton(this, CX, restoreCy, this.restoreInFlight ? "Restoring…" : "Restore purchases", () => void this.onRestore(this.footerTop), {
      variant: "secondary",
      id: "unlock.restore",
      disabled: this.restoreInFlight,
    });

    // Free replay is the coral primary whenever there is nothing to buy right now.
    pillButton(this, CX, freeCy, "Keep playing free holes", () => sceneGo(this, "LevelSelect"), {
      variant: storeReady ? "secondary" : "primary",
      id: "unlock.keepPlaying",
    });

    if (import.meta.env.MODE !== "production") {
      if (this.uiState === "cancelled") showScreenToast(this, "Purchase cancelled.", "warning", this.footerTop);
      else if (this.uiState === "failed") this.showFailed(this.footerTop);
      else if (this.uiState === "restore") showScreenToast(this, "No purchase found on this Google account", "warning", this.footerTop);
    }
  }

  private addDisabledUnlockPill(
    cx: number,
    cy: number,
    w: number,
    h: number,
    footerTop: number,
    label: string
  ): void {
    const key = disabledPillTexture(this, w, h);
    const bg = faceImage(this, key, w, h);
    const labelText = pixelCenteredText(
      this,
      label,
      displayTextStyle(TOKENS.type.action.size, TOKENS.type.action.weight, cssColor("disabledText"))
    );
    const hit = this.add.rectangle(0, 0, w, h, 0x000000, 0.001);
    const visual = this.add.container(cx, cy, [bg, labelText, hit]).setDepth(HUD);
    hit.setInteractive({ useHandCursor: true });
    bindTap(hit, () => {
      touchAudioUnlock();
      sfxUiTap();
      showScreenToast(this, unavailableMessage(this.onSale), "warning", footerTop);
    });
    visual.setSize(w, h);
    registerControlCenter("unlock.purchase", this.scene.key, cx, cy, w, h, visual, "primary", hit);
  }

  private async onRestore(footerTop: number): Promise<void> {
    if (this.restoreInFlight) return;
    if (!billingAvailable()) {
      const msg = isAndroidApp()
        ? "Couldn't reach Google Play. Try again when it's available."
        : "Restore works in the Android app from Google Play.";
      showScreenToast(this, msg, "warning", footerTop);
      return;
    }
    this.restoreInFlight = true;
    this.scene.restart({ intendedHole: this.intendedHole, keepFlags: true });
    const result = await restorePurchases();
    this.restoreInFlight = false;
    if (!this.scene.isActive()) return;
    if (result === "restored") {
      await updateSave(this, applyEntitlementFlag(getSave(this), true));
      this.scene.restart({ intendedHole: this.intendedHole });
      this.events.once("create", () => showScreenToast(this, "Full game restored", "success", this.footerTop));
      return;
    }
    this.scene.restart({ intendedHole: this.intendedHole });
    this.events.once("create", () => {
      if (result === "nothing") {
        showScreenToast(this, "No purchase found on this Google account", "warning", this.footerTop);
      } else {
        showScreenToast(this, "Couldn't reach Google Play. Try again when it's available.", "danger", this.footerTop);
      }
    });
  }

  private showFailed(footerTop: number): void {
    showScreenToast(this, "Purchase didn't complete. Try again.", "danger", footerTop, () =>
      void this.onPurchase(footerTop)
    );
  }

  private async onPurchase(footerTop: number): Promise<void> {
    if (!this.onSale || !billingAvailable() || !productPrice()) {
      showScreenToast(this, unavailableMessage(this.onSale), "warning", footerTop);
      return;
    }
    if (this.purchaseInFlight) return;
    this.purchaseInFlight = true;
    this.scene.restart({ intendedHole: this.intendedHole, keepFlags: true });
    const result = await purchaseUnlock();
    this.purchaseInFlight = false;
    if (!this.scene.isActive()) return;
    if (result === "success") {
      await updateSave(this, applyEntitlementFlag(getSave(this), true));
      this.scene.restart({ intendedHole: this.intendedHole });
      return;
    }
    this.scene.restart({ intendedHole: this.intendedHole });
    this.events.once("create", () => {
      if (result === "cancelled") showScreenToast(this, "Purchase cancelled.", "warning", this.footerTop);
      else if (result === "pending")
        showScreenToast(this, "Purchase pending. The full game unlocks when Google Play confirms payment.", "warning", this.footerTop);
      else this.showFailed(this.footerTop);
    });
  }

  update(_t: number, dt: number): void {
    if (!this.scene.isActive()) return;
    if (!isTraveling(this)) this.bg.update(dt / 1000);
  }
}

function unavailableMessage(onSale: boolean): string {
  if (!onSale) return "Full-game unlock isn't on sale in this build yet.";
  return isAndroidApp()
    ? "Couldn't reach Google Play. Free holes still work."
    : "Buy the full game in the Android app from Google Play.";
}

function paidContentLine(total: number): string {
  return `Your purchase is ready. All ${total} holes are available.`;
}
