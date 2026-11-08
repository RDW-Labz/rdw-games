import { AVATAR_STATES, type AvatarState } from './looks';

export interface SheetPixels { width: number; height: number; rgba: Uint8ClampedArray }
export interface AvatarManifest {
  name: string;
  artist: string;
  grid: { frame: 128; columns: 4; rows: AvatarState[]; fps: number };
  palette: string[];
  anchors: { status_light: { x: number; y: number; w: number; h: number }; chat_button: { x: number; y: number }; baseline: number };
}
export interface PackError { code: 'missing' | 'grid' | 'anchor' | 'palette' | 'pixels' | 'alpha' | 'colour'; path: string }
export type PackValidation = { ok: true; manifest: AvatarManifest; pixels: SheetPixels } | { ok: false; errors: PackError[] };
function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const inside = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 128;

/** Pure validation: no DOM, image decoder, or drawing before this succeeds. */
export function validateAvatarPack(input: unknown, sheet: SheetPixels): PackValidation {
  const errors: PackError[] = [];
  const fail = (code: PackError['code'], path: string) => errors.push({ code, path });
  const m = record(input);
  for (const key of ['name', 'artist', 'grid', 'palette', 'anchors']) {
    if (m[key] === undefined) fail('missing', key);
  }
  for (const key of ['name', 'artist']) {
    if (typeof m[key] !== 'string' || !m[key].trim()) fail('missing', key);
  }
  const grid = record(m.grid);
  if (grid.frame !== 128 || grid.columns !== 4 || !Array.isArray(grid.rows) || grid.rows.length !== 8 || !AVATAR_STATES.every((state, i) => (grid.rows as unknown[])[i] === state)) fail('grid', 'grid');
  if (typeof grid.fps !== 'number' || !Number.isFinite(grid.fps) || grid.fps < 1 || grid.fps > 12) fail('grid', 'grid.fps');
  const anchors = record(m.anchors);
  for (const key of ['status_light', 'chat_button', 'baseline']) {
    if (anchors[key] === undefined) fail('missing', `anchors.${key}`);
  }
  const light = record(anchors.status_light);
  const chat = record(anchors.chat_button);
  if (!inside(light.x) || !inside(light.y) || typeof light.w !== 'number' || typeof light.h !== 'number' || !Number.isInteger(light.w) || !Number.isInteger(light.h) || light.w <= 0 || light.h <= 0 || light.x + light.w > 128 || light.y + light.h > 128) fail('anchor', 'anchors.status_light');
  if (!inside(chat.x) || !inside(chat.y)) fail('anchor', 'anchors.chat_button');
  if (!inside(anchors.baseline)) fail('anchor', 'anchors.baseline');
  const palette = m.palette;
  const validPalette = Array.isArray(palette) && palette.length >= 1 && palette.length <= 256 && palette.every((colour) => typeof colour === 'string' && /^#[\da-f]{6}$/i.test(colour));
  if (!validPalette) fail('palette', 'palette');
  if (!sheet || sheet.width !== 512 || sheet.height !== 1024) fail('grid', 'sheet');
  if (!sheet || !(sheet.rgba instanceof Uint8ClampedArray) || sheet.rgba.length !== 512 * 1024 * 4) {
    fail('pixels', 'sheet.rgba');
  } else {
    const colours = new Set<number>(validPalette ? (palette as string[]).map((c) => parseInt(c.slice(1), 16)) : []);
    let badAlpha = false;
    let badColour = false;
    for (let i = 0; i < sheet.rgba.length; i += 4) {
      const alpha = sheet.rgba[i + 3];
      if (alpha !== 0 && alpha !== 255) badAlpha = true;
      if (alpha === 255 && !colours.has((sheet.rgba[i] << 16) | (sheet.rgba[i + 1] << 8) | sheet.rgba[i + 2])) badColour = true;
    }
    if (badAlpha) fail('alpha', 'sheet.rgba');
    if (badColour) fail('colour', 'sheet.rgba');
  }
  return errors.length ? { ok: false, errors } : { ok: true, manifest: input as AvatarManifest, pixels: sheet };
}
