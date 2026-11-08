// @ts-expect-error zzfx ships without TypeScript declarations
import { zzfx } from "zzfx/ZzFX.js";

let muted = false;
let unlocked = false;

export function setSfxMuted(m: boolean): void {
  muted = m;
}

export function unlockAudio(): void {
  unlocked = true;
}

function play(params: (number | undefined)[]): void {
  if (muted || !unlocked) return;
  try {
    zzfx(...(params as number[]));
  } catch {
    /* ignore */
  }
}

export function sfxPutt(): void {
  play([1.2, , 180, 0.03, 0.08, 0.12, , 1.2, , , , , , , , , 0.04, 0.5]);
}

export function sfxUiTap(): void {
  play([0.4, , 520, 0.01, 0.04, 0.08, , 1.5, , , , , , , , , 0.02, 0.4]);
}

export function sfxWallTick(speed: number): void {
  const t = Math.min(1, speed / 600);
  play([0.15 + t * 0.1, , 200 + t * 400, 0.01, 0.02, 0.04, , 2, , , , , , , , , 0.01, 0.3]);
}

export function sfxBumperPop(): void {
  play([0.6, , 340, 0.02, 0.06, 0.2, 1, 1.8, , , , , , , , , 0.05, 0.5]);
}

export function sfxSand(): void {
  play([0.5, , 90, 0.02, 0.12, 0.15, , 0.8, , , , , , , , , 0.03, 0.35]);
}

export function sfxSplash(): void {
  play([0.8, , 120, 0.03, 0.2, 0.35, , 1.2, , , , , , , , , 0.04, 0.45]);
}

export function sfxLipOut(): void {
  play([0.35, , 280, 0.01, 0.05, 0.08, , 3.5, , , 80, 0.05, , , , , 0.02, 0.4]);
}

export function sfxHoledJingle(): void {
  play([1.4, , 523, 0.05, 0.12, 0.25, 1, 1.2, , , , , , , , , 0.06, 0.55]);
  setTimeout(() => play([1.2, , 659, 0.04, 0.1, 0.2, 1, 1.1, , , , , , , , , 0.05, 0.5]), 120);
  setTimeout(() => play([1.5, , 784, 0.06, 0.15, 0.3, 1, 1, , , , , , , , , 0.06, 0.55]), 240);
}

export function sfxRim(): void {
  play([0.3, , 320, 0.01, 0.04, 0.06, , 2.8, , , , , , , , , 0.02, 0.35]);
}

export function sfxCupPlop(): void {
  play([0.9, , 180, 0.02, 0.08, 0.14, , 1.1, , , , , , , , , 0.04, 0.4]);
}

export function sfxStarNote(freq: number): void {
  play([0.8, , freq, 0.02, 0.06, 0.08, 1, 1.2, , , , , , , , , 0.12, 0.45]);
}

export function sfxCompletionQuiet(): void {
  play([0.6, , 440, 0.03, 0.1, 0.15, 1, 1, , , , , , , , , 0.08, 0.35]);
}
