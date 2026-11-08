import type Phaser from "phaser";

/** Keys owned by a scene; removed on explicit scene texture release. */
const byScene = new Map<string, Set<string>>();

/** Global keys (UI, boot) — never auto-released. */
const globalKeys = new Set<string>();

export function markGlobalTexture(key: string): void {
  globalKeys.add(key);
}

export function acquireSceneTexture(scene: Phaser.Scene, key: string): void {
  let set = byScene.get(scene.scene.key);
  if (!set) {
    set = new Set();
    byScene.set(scene.scene.key, set);
  }
  set.add(key);
}

export function releaseTexture(scene: Phaser.Scene, key: string): void {
  if (globalKeys.has(key)) return;
  const tm = scene.textures;
  if (tm.exists(key)) tm.remove(key);
  for (const set of byScene.values()) set.delete(key);
}

export function releaseSceneTextures(scene: Phaser.Scene): void {
  const set = byScene.get(scene.scene.key);
  if (!set) return;
  const tm = scene.textures;
  for (const key of set) {
    if (!globalKeys.has(key) && tm.exists(key)) tm.remove(key);
  }
  byScene.delete(scene.scene.key);
}

export function textureCount(game: Phaser.Game): number {
  return game.textures.getTextureKeys().filter((k) => k !== "__DEFAULT" && k !== "__MISSING").length;
}
