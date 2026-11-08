import { R } from "../game/display.js";
import { cssColor } from "./tokens.js";

export const FONT_DISPLAY = "Fredoka";
export const FONT_BODY = "Nunito";

const WEIGHTS_DISPLAY = [500, 600, 700] as const;
const WEIGHTS_BODY = [600, 700, 800] as const;

export async function loadGameFonts(timeoutMs = 2500): Promise<void> {
  if (typeof document === "undefined" || !document.fonts?.load) return;
  const loads: Promise<unknown>[] = [];
  for (const w of WEIGHTS_DISPLAY) {
    loads.push(document.fonts.load(`${w} 48px ${FONT_DISPLAY}`));
    loads.push(document.fonts.load(`${w} 28px ${FONT_DISPLAY}`));
    loads.push(document.fonts.load(`${w} 20px ${FONT_DISPLAY}`));
  }
  for (const w of WEIGHTS_BODY) {
    loads.push(document.fonts.load(`${w} 16px ${FONT_BODY}`));
    loads.push(document.fonts.load(`${w} 20px ${FONT_BODY}`));
  }
  await Promise.race([
    Promise.allSettled(loads),
    new Promise((r) => setTimeout(r, timeoutMs)),
  ]);
}

function checkFont(candidates: string[]): boolean {
  if (typeof document === "undefined" || !document.fonts?.check) return true;
  return candidates.some((spec) => document.fonts.check(spec));
}

export function fontsReadyForMenu(): boolean {
  return (
    checkFont([
      `700 20px ${FONT_DISPLAY}`,
      `bold 20px ${FONT_DISPLAY}`,
      `20px ${FONT_DISPLAY}`,
    ]) &&
    checkFont([`600 16px ${FONT_BODY}`, `16px ${FONT_BODY}`])
  );
}

export function displayTextStyle(
  sizePx: number,
  weight = 700,
  color = cssColor("text")
): Phaser.Types.GameObjects.Text.TextStyle {
  return {
    font: `${weight} ${sizePx}px ${FONT_DISPLAY}`,
    color,
    resolution: R,
  };
}

export function bodyTextStyleUi(
  sizePx: number,
  weight = 600,
  color = cssColor("text")
): Phaser.Types.GameObjects.Text.TextStyle {
  return {
    font: `${weight} ${sizePx}px ${FONT_BODY}`,
    color,
    resolution: R,
  };
}
