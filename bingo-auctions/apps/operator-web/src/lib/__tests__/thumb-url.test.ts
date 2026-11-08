import { describe, it, expect } from 'vitest';
import { thumbUrl } from '../thumb-url';

describe('thumbUrl', () => {
  // Supabase bills transformations per distinct origin image; a thumbnail
  // must never be a /render/image/ URL (2026-09-24, ~39x over quota).
  it('returns a Supabase public object unchanged (no render transform)', () => {
    const src =
      'https://npwseclcxcatjhgjrtwe.supabase.co/storage/v1/object/public/lot-photos/op/BIN-1/123.jpg';
    expect(thumbUrl(src)).toBe(src);
    expect(thumbUrl(src, 60)).toBe(src);
    expect(thumbUrl(src)).not.toContain('/render/image/');
  });

  it('maps an already-transformed Supabase URL back to its object', () => {
    const obj = 'https://x.supabase.co/storage/v1/object/public/stock-images/abc.png';
    const rendered =
      'https://x.supabase.co/storage/v1/render/image/public/stock-images/abc.png?width=240&height=240&resize=cover&quality=70';
    expect(thumbUrl(rendered)).toBe(obj);
  });

  it('rewrites a Wayfair wfcdn render size in the path', () => {
    const src =
      'https://secure.img1-fg.wfcdn.com/im/123/resize-h800-w800/9/x.jpg';
    expect(thumbUrl(src, 120)).toBe(
      'https://secure.img1-fg.wfcdn.com/im/123/resize-h800-w800/9/x.jpg'.replace(
        'resize-h800-w800',
        'resize-h120-w120',
      ),
    );
  });

  it('passes through other hosts unchanged', () => {
    const src = 'https://m.media-amazon.com/images/I/71abc.jpg';
    expect(thumbUrl(src)).toBe(src);
  });

  it('returns null for empty / invalid input', () => {
    expect(thumbUrl(null)).toBeNull();
    expect(thumbUrl(undefined)).toBeNull();
    expect(thumbUrl('')).toBeNull();
    expect(thumbUrl('not a url')).toBeNull();
  });
});
