import Phaser from "phaser";
import { loadLevels } from "../levels.js";
import { bindBackKey, sceneFadeIn, sceneGo } from "./juice.js";
import { getSave } from "./BootScene.js";
import { UI_CANCEL_PRESS } from "./theme.js";
import {
  FREE_HOLE_COUNT,
  fullGameOnSale,
  isHoleAvailable,
  nextHole,
  rating,
} from "../progress.js";
import { ScreenBackground } from "../ui/background.js";
import { clearSceneControls } from "../ui/controls.js";
import { holeCard } from "../ui/holeCard.js";
import { panelImage } from "../ui/panel.js";
import { pillButton } from "../ui/pillButton.js";
import { ensureUiTextures } from "../ui/textures.js";
import { topBar } from "../ui/topBar.js";
import { TOKENS } from "../ui/tokens.js";
import { appearFx } from "../ui/motion.js";
import { bodyTextStyleUi, displayTextStyle } from "../ui/fonts.js";
import { cssColor } from "../ui/tokens.js";
import { isTraveling, pocketLayout, registerSceneBackground } from "./travel.js";
import { paidOfferLine, worldSections } from "./course/worldsCatalog.js";

const SCROLL_KEY = "holesScrollY";

export class LevelSelectScene extends Phaser.Scene {
  private bg!: ScreenBackground;
  private scrollY = 0;
  private maxScroll = 0;
  private contentTop = 0;
  private grid!: Phaser.GameObjects.Container;
  private scrollDragging = false;
  private scrollLastY = 0;
  private footerHole = 0;

  constructor() {
    super("LevelSelect");
  }

  create(): void {
    clearSceneControls(this.scene.key);
    ensureUiTextures(this);
    this.bg = new ScreenBackground(this);
    registerSceneBackground(this, this.bg);
    sceneFadeIn(this);

    const { A, G } = pocketLayout();
    this.contentTop = topBar(this, {
      title: "Holes",
      backId: "holes.back",
      onBack: () => sceneGo(this, "Menu", { nav: "back" }),
    });

    const levels = loadLevels();
    const save = getSave(this);
    const highlightIdx = nextHole(save, levels.length);
    this.footerHole = highlightIdx;

    const cardW = TOKENS.component.holeCard.w;
    const cardH = TOKENS.component.holeCard.h;
    const colXs = [G + cardW / 2, G + cardW + TOKENS.space.md + cardW / 2];
    const rowStep = cardH + TOKENS.space.md;

    this.grid = this.add.container(0, this.contentTop).setDepth(TOKENS.depth.hud - 3);
    this.scrollY = (this.registry.get(SCROLL_KEY) as number) ?? 0;

    // One section per world (worlds.md), each with its header; the full-game card follows the
    // last grid row inside the scroll content (screens.md section 4).
    const headerH = 24;
    const appearTargets: Phaser.GameObjects.GameObject[] = [];
    let top = TOKENS.space.sm;
    for (const sec of worldSections(levels)) {
      const header = this.add
        .text(
          G + TOKENS.space.xs,
          top + headerH - TOKENS.space.xs,
          sec.title,
          bodyTextStyleUi(TOKENS.type.caption.size, TOKENS.type.caption.weight, cssColor("textMuted"))
        )
        .setOrigin(0, 1);
      this.grid.add(header);
      top += headerH;
      for (let i = sec.start; i < sec.end; i++) {
        const local = i - sec.start;
        const col = local % 2;
        const x = colXs[col];
        const y = top + Math.floor(local / 2) * rowStep + cardH / 2;
        const par = levels[i].par;
        const hp = save.holes[i];
        const stars = rating(hp?.best, par);
        const locked = !isHoleAvailable(i, save.unlocked);
        const card = holeCard(this, x, y, cardW, cardH, {
          holeNum: i + 1,
          par,
          stars,
          locked,
          level: levels[i],
          highlighted: i === highlightIdx,
          id: `holes.card.${i + 1}`,
          onPick: locked
            ? () => sceneGo(this, "Unlock", { intendedHole: i })
            : () => {
                sceneGo(this, "Play", { holeIndex: i });
              },
        });
        this.grid.add(card);
        if (i < 8) appearTargets.push(card);
      }
      top += Math.ceil((sec.end - sec.start) / 2) * rowStep;
    }
    appearFx(this, appearTargets, { card: true, stagger: TOKENS.motion.duration.stagger });

    // Full-game information card follows the last grid row (screens.md section 4) and states the
    // exact offer. With 36 holes that card is far below the first screen, so its "Full game" action
    // is a fixed pairedFooter secondary at A-120 above "Play hole N": always visible, never
    // scrolled behind the footer. Entitled players and builds without paid holes get no button.
    const paidExists = fullGameOnSale(levels.length);
    const showButton = paidExists && !save.unlocked;
    const panelTop = top;
    const panelH = showButton ? 100 : 84;
    const panelCx = G + TOKENS.layout.contentW / 2;
    const panel = panelImage(this, panelCx, panelTop + panelH / 2, TOKENS.layout.contentW, panelH);
    const titleText = save.unlocked ? "Full game unlocked" : "More park to explore";
    let body = `${FREE_HOLE_COUNT} free holes available`;
    if (save.unlocked) body = `All ${levels.length} holes are available.`;
    else if (paidExists) body = paidOfferLine(levels);
    const title = this.add
      .text(G + 16, panelTop + 12, titleText, displayTextStyle(TOKENS.type.screen.size, TOKENS.type.screen.weight, cssColor("text")))
      .setOrigin(0, 0);
    const bodyText = this.add
      .text(G + 16, panelTop + 44, body, bodyTextStyleUi(TOKENS.type.body.size, TOKENS.type.body.weight, cssColor("textMuted")))
      .setOrigin(0, 0)
      .setWordWrapWidth(296);
    this.grid.add([panel, title, bodyText]);
    if (showButton) {
      pillButton(
        this,
        pocketLayout().CX,
        A - 120 + TOKENS.component.pill.secondary.h / 2,
        "Full game",
        () => sceneGo(this, "Unlock", { intendedHole: FREE_HOLE_COUNT }),
        { variant: "secondary", id: "holes.unlock" }
      );
    }
    const panelBottom = panelTop + panelH;

    // Scrolling body clips 12 px above the first fixed footer action (screens.md section 1).
    const viewTop = this.contentTop;
    const viewBottom = (showButton ? A - 120 : A - 56) - TOKENS.space.md - TOKENS.space.sm;
    const viewH = viewBottom - viewTop;
    const contentH = panelBottom + TOKENS.space.lg;
    this.maxScroll = Math.max(0, contentH - viewH);
    this.setScroll(this.scrollY);

    // Clip the scrolling grid with a second camera whose viewport is the grid rect
    // (GeometryMask is Canvas-only in Phaser 4). Camera viewports also clip input: parts of
    // cards scrolled outside the viewport cannot be hit.
    this.setupGridCamera(viewTop, viewBottom);

    const primaryCy = A - 56 + TOKENS.component.pill.primary.h / 2;
    pillButton(
      this,
      pocketLayout().CX,
      primaryCy,
      `Play hole ${this.footerHole + 1}`,
      () => sceneGo(this, "Play", { holeIndex: this.footerHole }),
      { variant: "primary", id: "holes.play" }
    );

    // Scroll: worldY is logical (camera zoom R); p.y would be canvas pixels. A drag past 8 px
    // becomes a scroll and cancels any pressed card (screens.md section 4).
    let dragStartY = 0;
    let scrolling = false;
    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
      if (p.worldY >= viewTop && p.worldY < viewBottom) {
        this.scrollDragging = true;
        scrolling = false;
        dragStartY = p.worldY;
        this.scrollLastY = p.worldY;
      }
    });
    this.input.on("pointermove", (p: Phaser.Input.Pointer) => {
      if (!this.scrollDragging || !p.isDown) return;
      if (!scrolling && Math.abs(p.worldY - dragStartY) > 8) {
        scrolling = true;
        this.events.emit(UI_CANCEL_PRESS);
      }
      if (scrolling) this.setScroll(this.scrollY + (this.scrollLastY - p.worldY));
      this.scrollLastY = p.worldY;
    });
    this.input.on("pointerup", () => {
      this.scrollDragging = false;
      scrolling = false;
    });

    bindBackKey(this, () => sceneGo(this, "Menu", { nav: "back" }));
    this.events.once("shutdown", () => {
      this.registry.set(SCROLL_KEY, this.scrollY);
      clearSceneControls(this.scene.key);
    });
  }

  private setupGridCamera(top: number, bottom: number): void {
    const main = this.cameras.main;
    const z = main.zoom;
    const gridCam = this.cameras.add(0, Math.round(top * z), main.width, Math.round((bottom - top) * z));
    gridCam.setOrigin(0, 0);
    gridCam.setZoom(z);
    gridCam.setScroll(0, Math.round(top * z) / z);
    gridCam.transparent = true;
    main.ignore(this.grid);
    const onlyGrid = (obj: Phaser.GameObjects.GameObject): void => {
      if (obj !== this.grid) gridCam.ignore(obj);
    };
    this.children.list.forEach(onlyGrid);
    this.events.on(Phaser.Scenes.Events.ADDED_TO_SCENE, onlyGrid);
    this.events.once("shutdown", () => {
      this.events.off(Phaser.Scenes.Events.ADDED_TO_SCENE, onlyGrid);
      this.cameras.remove(gridCam);
    });
  }

  private setScroll(y: number): void {
    this.scrollY = Phaser.Math.Clamp(y, 0, this.maxScroll);
    this.grid.y = this.contentTop - this.scrollY;
  }

  update(_t: number, dt: number): void {
    if (!this.scene.isActive()) return;
    if (!isTraveling(this)) this.bg.update(dt / 1000);
  }
}
