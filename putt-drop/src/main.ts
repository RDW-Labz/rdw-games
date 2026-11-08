import Phaser from "phaser";
import { BootScene } from "./game/BootScene.js";
import { MenuScene } from "./game/MenuScene.js";
import { LevelSelectScene } from "./game/LevelSelectScene.js";
import { SettingsScene } from "./game/SettingsScene.js";
import { UnlockScene, UNLOCK_FIXTURE_KEY, type UnlockFixtureState } from "./game/UnlockScene.js";
import { PlayScene } from "./game/PlayScene.js";
import type { GalleryScene } from "./game/GalleryScene.js";
import { BG } from "./game/theme.js";
import { LOGICAL_H, LOGICAL_W, R } from "./game/display.js";
import { getVisibleControls, type ControlRect } from "./ui/controls.js";
import { fontsReadyForMenu } from "./ui/fonts.js";
import { loadLevels } from "./levels.js";
import {
  createDefaultSave,
  ensureHoleSlots,
  type SaveData,
} from "./progress.js";
import { getSave, updateSave } from "./game/BootScene.js";
import { persistSave } from "./platform/save.js";
import { textureCount } from "./game/textureCache.js";
import { beginSceneTravel, isTraveling } from "./game/travel.js";

const scenes: Phaser.Types.Scenes.SceneType[] = [
  BootScene,
  MenuScene,
  LevelSelectScene,
  SettingsScene,
  UnlockScene,
  PlayScene,
];

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: "game",
  width: LOGICAL_W * R,
  height: LOGICAL_H * R,
  backgroundColor: BG,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  render: {
    // Only tests read pixels back; keeping the buffer costs frame rate on phones.
    preserveDrawingBuffer: import.meta.env.MODE !== "production",
  },
  scene: scenes,
};

const game = new Phaser.Game(config);

// Dev/test builds only: Vite replaces MODE statically, so production drops the gallery
// (and its chunk) entirely. Registered without auto-start.
if (import.meta.env.MODE !== "production") {
  void import("./game/GalleryScene.js").then(({ GalleryScene }) => {
    game.scene.add("Gallery", GalleryScene, false);
  });
}

// Test hooks (window.__pd): compiled only into dev/test builds (`npm run build:test`).
if (import.meta.env.MODE !== "production" && typeof window !== "undefined") {
  const frameTimestamps: number[] = [];
  const trackFrames = (): void => {
    frameTimestamps.push(performance.now());
    requestAnimationFrame(trackFrames);
  };
  requestAnimationFrame(trackFrames);

  const activeScene = (): Phaser.Scene | undefined =>
    game.scene.scenes.find((s) => s.scene.isActive());

  // Count create() runs per scene so tests can prove a restart (Retry/Restart/Next) happened.
  const createCounts: Record<string, number> = {};
  game.events.once(Phaser.Core.Events.READY, () => {
    for (const s of game.scene.scenes) {
      const key = s.scene.key;
      s.sys.events.on(Phaser.Scenes.Events.CREATE, () => {
        createCounts[key] = (createCounts[key] ?? 0) + 1;
      });
    }
  });

  /** Reach a screen for testing: travel from the current scene, stop every other active scene. */
  const switchTo = (key: string, data: Record<string, unknown> = {}): void => {
    const from = activeScene();
    if (from) beginSceneTravel(from, key);
    for (const s of game.scene.scenes) {
      if (s.scene.key !== key && s.scene.isActive()) game.scene.stop(s.scene.key);
    }
    game.scene.start(key, data);
  };

  const holeCount = (): number =>
    (game.registry.get("holeCount") as number | undefined) ?? loadLevels().length;

  const mergeSave = (partial: Partial<SaveData>): SaveData => {
    const scene = activeScene();
    const current =
      scene != null
        ? getSave(scene)
        : (game.registry.get("save") as SaveData | undefined) ??
          createDefaultSave(holeCount());
    const next: SaveData = {
      ...current,
      ...partial,
      settings: { ...current.settings, ...partial.settings },
      holes: partial.holes ?? current.holes,
    };
    return ensureHoleSlots(next, holeCount());
  };

  (window as unknown as {
    __pd?: {
      activeScenes(): string[];
      strokeCount(): number;
      isPaused(): boolean;
      controls(): ControlRect[];
      pauseSheetRect(): ControlRect | null;
      fontsReady(): boolean;
      goto(sceneKey: string, data?: Record<string, unknown>): void;
      play(holeIndex: number): void;
      forceResult(strokes: number): void;
      setSave(partialSave: Partial<SaveData>): void;
      resetSave(): void;
      openPause(): void;
      fps(): number;
      heap(): number | null;
      textureCount(): number;
      scrollGallery(offset: number): void;
      forceUnlockState(state: UnlockFixtureState): void;
      transitionMs(): number;
      save(): SaveData | null;
      createCount(sceneKey: string): number;
      holeIndex(): number;
      lastToast(): { message: string; at: number } | null;
      traveling(): boolean;
    };
  }).__pd = {
    activeScenes(): string[] {
      return game.scene.scenes
        .filter((s) => s.scene.isActive())
        .map((s) => s.scene.key);
    },
    strokeCount(): number {
      const play = game.scene.getScene("Play") as PlayScene | undefined;
      if (!play?.scene.isActive()) return 0;
      return play.getStrokeCount();
    },
    isPaused(): boolean {
      const play = game.scene.getScene("Play") as PlayScene | undefined;
      if (!play?.scene.isActive()) return false;
      return play.isPausedForTest();
    },
    controls(): ControlRect[] {
      const active = this.activeScenes();
      return getVisibleControls(active);
    },
    pauseSheetRect(): ControlRect | null {
      const active = this.activeScenes();
      return getVisibleControls(active).find((c) => c.id === "pause.sheet") ?? null;
    },
    fontsReady(): boolean {
      return fontsReadyForMenu();
    },
    goto(sceneKey: string, data?: Record<string, unknown>): void {
      switchTo(sceneKey, data ?? {});
    },
    play(holeIndex: number): void {
      switchTo("Play", { holeIndex });
    },
    forceResult(strokes: number): void {
      const play = game.scene.getScene("Play") as PlayScene | undefined;
      play?.forceResultForTest(strokes);
    },
    setSave(partialSave: Partial<SaveData>): void {
      const next = mergeSave(partialSave);
      const scene = activeScene();
      if (scene) void updateSave(scene, next);
      else {
        game.registry.set("save", next);
        void persistSave(next);
      }
    },
    resetSave(): void {
      const fresh = createDefaultSave(holeCount());
      const scene = activeScene();
      if (scene) void updateSave(scene, fresh);
      else {
        game.registry.set("save", fresh);
        void persistSave(fresh);
      }
    },
    openPause(): void {
      const play = game.scene.getScene("Play") as PlayScene | undefined;
      play?.openPauseForTest();
    },
    fps(): number {
      const now = performance.now();
      const recent = frameTimestamps.filter((t) => t >= now - 1000);
      if (recent.length < 2) return 0;
      const span = recent[recent.length - 1] - recent[0];
      return span > 0 ? ((recent.length - 1) * 1000) / span : 0;
    },
    heap(): number | null {
      const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } })
        .memory;
      return mem?.usedJSHeapSize ?? null;
    },
    textureCount(): number {
      return textureCount(game);
    },
    scrollGallery(offset: number): void {
      const gallery = game.scene.getScene("Gallery") as GalleryScene | undefined;
      gallery?.scrollByForTest(offset);
    },
    forceUnlockState(state: UnlockFixtureState): void {
      game.registry.set(UNLOCK_FIXTURE_KEY, state);
      switchTo("Unlock");
    },
    transitionMs(): number {
      return (game.registry.get("pdLastTransitionMs") as number) ?? 0;
    },
    save(): SaveData | null {
      return (game.registry.get("save") as SaveData | undefined) ?? null;
    },
    createCount(sceneKey: string): number {
      return createCounts[sceneKey] ?? 0;
    },
    holeIndex(): number {
      const play = game.scene.getScene("Play") as unknown as { holeIndex?: number } | undefined;
      return play?.holeIndex ?? -1;
    },
    traveling(): boolean {
      const scene = activeScene();
      return scene ? isTraveling(scene) : false;
    },
    lastToast(): { message: string; at: number } | null {
      return (game.registry.get("pdLastToast") as { message: string; at: number } | undefined) ?? null;
    },
  };
}
