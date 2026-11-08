import { describe, expect, it } from 'vitest';
import { mergePhotoUrls, mergePhotosAfterSave } from './photo-merge';

describe('mergePhotoUrls', () => {
  it('keeps a photo added concurrently and does not duplicate', () => {
    expect(
      mergePhotoUrls(['https://cdn/a.jpg'], ['https://cdn/b.jpg', 'https://cdn/a.jpg']),
    ).toEqual(['https://cdn/a.jpg', 'https://cdn/b.jpg']);
  });

  it('preserves the current order', () => {
    expect(mergePhotoUrls(['b', 'a'], ['c'])).toEqual(['b', 'a', 'c']);
  });

  it('ignores empty entries', () => {
    expect(mergePhotoUrls(['a'], ['', 'b'])).toEqual(['a', 'b']);
  });
});

describe('mergePhotosAfterSave', () => {
  it('keeps a photo captured while the save request was pending', () => {
    const startPhotos = ['file:///hero.jpg', 'https://cdn/stock.jpg'];
    const saved = ['https://cdn/hero.jpg', 'https://cdn/stock.jpg'];
    const current = [
      'https://cdn/hero.jpg',
      'https://cdn/stock.jpg',
      'file:///added-during-save.jpg',
    ];
    expect(mergePhotosAfterSave(current, startPhotos, saved)).toEqual([
      'https://cdn/hero.jpg',
      'https://cdn/stock.jpg',
      'file:///added-during-save.jpg',
    ]);
  });

  it('drops the uploaded originals and keeps concurrent remote additions', () => {
    const current = ['file:///hero.jpg', 'https://cdn/hero.jpg', 'https://cdn/other-device.jpg'];
    expect(mergePhotosAfterSave(current, ['file:///hero.jpg'], ['https://cdn/hero.jpg'])).toEqual([
      'https://cdn/hero.jpg',
      'https://cdn/other-device.jpg',
    ]);
  });
});
