import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import type { SaveData } from "../progress.js";
import { createDefaultSave } from "../progress.js";
import { isProductOwned, refreshEntitlementFromStore } from "./billing.js";

const STORAGE_KEY = "putt-drop-save-v1";

function isNative(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

async function readRaw(): Promise<string | null> {
  if (isNative()) {
    try {
      const { value } = await Preferences.get({ key: STORAGE_KEY });
      return value;
    } catch {
      return null;
    }
  }
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

async function writeRaw(value: string): Promise<void> {
  if (isNative()) {
    try {
      await Preferences.set({ key: STORAGE_KEY, value });
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* ignore */
  }
}

export function applyEntitlementFlag(save: SaveData, unlocked: boolean): SaveData {
  if (save.unlocked === unlocked) return save;
  return { ...save, unlocked };
}

/** Refresh unlock flag from Play when billing is live; otherwise keep cached value (offline). */
export async function syncEntitlementOnLaunch(save: SaveData): Promise<SaveData> {
  await refreshEntitlementFromStore();
  return applyEntitlementFlag(save, isProductOwned());
}

export async function loadSave(holeCount: number): Promise<SaveData> {
  const raw = await readRaw();
  if (!raw) return createDefaultSave(holeCount);
  try {
    const parsed = JSON.parse(raw) as SaveData;
    if (!parsed.settings || !Array.isArray(parsed.holes)) {
      return createDefaultSave(holeCount);
    }
    const settings = { ...createDefaultSave(holeCount).settings, ...parsed.settings };
    if (parsed.settings.reducedMotion === undefined) settings.reducedMotion = false;
    if (parsed.settings.colorblindAim === undefined) settings.colorblindAim = false;
    return { ...parsed, settings };
  } catch {
    return createDefaultSave(holeCount);
  }
}

export async function persistSave(save: SaveData): Promise<void> {
  await writeRaw(JSON.stringify(save));
}

export async function clearSave(holeCount: number): Promise<SaveData> {
  const fresh = createDefaultSave(holeCount);
  await persistSave(fresh);
  return fresh;
}
