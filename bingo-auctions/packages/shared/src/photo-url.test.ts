import { describe, expect, it } from 'vitest';
import {
  isStorageTransformUrl,
  nextPhotoAttempt,
  originalPhotoUrl,
  photoSourceChain,
} from './photo-url';

const BASE = 'https://npwseclcxcatjhgjrtwe.supabase.co';
const OBJECT = `${BASE}/storage/v1/object/public/lot-photos/op/BIN-1/a.jpg`;
const RENDER = `${BASE}/storage/v1/render/image/public/lot-photos/op/BIN-1/a.jpg`;

describe('isStorageTransformUrl', () => {
  it('recognises render URLs only', () => {
    expect(isStorageTransformUrl(`${RENDER}?width=780&resize=contain`)).toBe(true);
    expect(isStorageTransformUrl(OBJECT)).toBe(false);
    expect(isStorageTransformUrl('https://images.thdstatic.com/x.jpg')).toBe(false);
    expect(isStorageTransformUrl('not a url')).toBe(false);
    expect(isStorageTransformUrl(null)).toBe(false);
  });
});

describe('originalPhotoUrl', () => {
  it('maps a render URL back to its object and drops transform params', () => {
    expect(originalPhotoUrl(`${RENDER}?width=240&height=240&resize=cover&quality=70`)).toBe(OBJECT);
    expect(originalPhotoUrl(`${RENDER}?width=785.45&resize=contain&format=origin`)).toBe(OBJECT);
  });

  it('keeps non-transform query params such as a cache-buster', () => {
    expect(originalPhotoUrl(`${RENDER}?width=120&v=1700000000`)).toBe(`${OBJECT}?v=1700000000`);
  });

  it('leaves object, external, local and invalid URLs untouched', () => {
    expect(originalPhotoUrl(OBJECT)).toBe(OBJECT);
    expect(originalPhotoUrl(`${OBJECT}?v=2`)).toBe(`${OBJECT}?v=2`);
    const ext = 'https://secure.img1-fg.wfcdn.com/im/1/resize-h800-w800%5Ecompr-r85/x.jpg';
    expect(originalPhotoUrl(ext)).toBe(ext);
    expect(originalPhotoUrl('file:///tmp/p.jpg')).toBe('file:///tmp/p.jpg');
    expect(originalPhotoUrl('/img/lot-photos/a.jpg')).toBe('/img/lot-photos/a.jpg');
    expect(originalPhotoUrl('not a url')).toBe('not a url');
  });

  it('never produces a render URL (so no fallback can bill a transform)', () => {
    for (const u of [RENDER, `${RENDER}?width=1`, OBJECT]) {
      expect(isStorageTransformUrl(originalPhotoUrl(u))).toBe(false);
    }
  });
});

describe('photoSourceChain', () => {
  it('is just the original when nothing is preferred', () => {
    expect(photoSourceChain(OBJECT)).toEqual([OBJECT]);
    expect(photoSourceChain(`${RENDER}?width=780`)).toEqual([OBJECT]);
  });

  it('tries the preferred source first, then the original', () => {
    expect(photoSourceChain(OBJECT, '/img/lot-photos/op/BIN-1/a.jpg')).toEqual([
      '/img/lot-photos/op/BIN-1/a.jpg',
      OBJECT,
    ]);
    expect(photoSourceChain(OBJECT, `${RENDER}?width=780`)).toEqual([
      `${RENDER}?width=780`,
      OBJECT,
    ]);
  });

  it('de-duplicates when the preferred source is the original', () => {
    expect(photoSourceChain(OBJECT, OBJECT)).toEqual([OBJECT]);
  });

  it('is empty for missing input, so callers go straight to the placeholder', () => {
    expect(photoSourceChain(null)).toEqual([]);
    expect(photoSourceChain(undefined, null)).toEqual([]);
    expect(photoSourceChain('   ', '')).toEqual([]);
  });
});

describe('nextPhotoAttempt', () => {
  it('walks the chain once then parks on the placeholder', () => {
    const chain = photoSourceChain(OBJECT, '/img/x.jpg'); // 2 sources
    let attempt = 0;
    const seen: Array<string | undefined> = [];
    for (let i = 0; i < 6; i++) {
      seen.push(chain[attempt]);
      attempt = nextPhotoAttempt(attempt, chain.length);
    }
    // Each source tried exactly once, then placeholder (undefined) forever.
    expect(seen).toEqual(['/img/x.jpg', OBJECT, undefined, undefined, undefined, undefined]);
    expect(attempt).toBe(chain.length);
  });

  it('never moves backwards, whatever the input', () => {
    expect(nextPhotoAttempt(5, 2)).toBe(2);
    expect(nextPhotoAttempt(-1, 2)).toBe(1);
    expect(nextPhotoAttempt(Number.NaN, 2)).toBe(1);
    expect(nextPhotoAttempt(0, 0)).toBe(0);
  });
});
