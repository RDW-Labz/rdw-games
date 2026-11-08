// normalise-photo-url.test.ts
//
// Pure function — no mocks needed.

import { describe, it, expect } from 'vitest';
import { normalisePhotoUrl } from '../normalise-photo-url.js';

describe('normalisePhotoUrl — non-string inputs', () => {
  it('1. null → null', () => expect(normalisePhotoUrl(null)).toBeNull());
  it('2. undefined → null', () => expect(normalisePhotoUrl(undefined)).toBeNull());
  it('3. number → null', () => expect(normalisePhotoUrl(42)).toBeNull());
  it('4. object → null', () => expect(normalisePhotoUrl({ url: 'https://x.com/img.jpg' })).toBeNull());
  it('5. boolean → null', () => expect(normalisePhotoUrl(true)).toBeNull());
});

describe('normalisePhotoUrl — placeholder strings', () => {
  it('6. empty string → null', () => expect(normalisePhotoUrl('')).toBeNull());
  it('7. whitespace-only → null', () => expect(normalisePhotoUrl('   ')).toBeNull());
  it('8. "NA" uppercase → null', () => expect(normalisePhotoUrl('NA')).toBeNull());
  it('9. "na" lowercase → null', () => expect(normalisePhotoUrl('na')).toBeNull());
  it('10. "Na" mixed-case → null', () => expect(normalisePhotoUrl('Na')).toBeNull());
  it('11. "N/A" uppercase → null', () => expect(normalisePhotoUrl('N/A')).toBeNull());
  it('12. "n/a" lowercase → null', () => expect(normalisePhotoUrl('n/a')).toBeNull());
  it('13. "N/a" mixed-case → null', () => expect(normalisePhotoUrl('N/a')).toBeNull());
  it('14. "null" lowercase → null', () => expect(normalisePhotoUrl('null')).toBeNull());
  it('15. "NULL" uppercase → null', () => expect(normalisePhotoUrl('NULL')).toBeNull());
  it('16. "none" lowercase → null', () => expect(normalisePhotoUrl('none')).toBeNull());
  it('17. "NONE" uppercase → null', () => expect(normalisePhotoUrl('NONE')).toBeNull());
  it('18. "-" dash → null', () => expect(normalisePhotoUrl('-')).toBeNull());
  it('19. "  NA  " with surrounding whitespace → null', () => expect(normalisePhotoUrl('  NA  ')).toBeNull());
  it('20. "  N/A  " with surrounding whitespace → null', () => expect(normalisePhotoUrl('  N/A  ')).toBeNull());
});

describe('normalisePhotoUrl — invalid protocol', () => {
  it('21. ftp:// → null (not http/https)', () => expect(normalisePhotoUrl('ftp://example.com/img.jpg')).toBeNull());
  it('22. plain domain (no protocol) → null', () => expect(normalisePhotoUrl('example.com/img.jpg')).toBeNull());
  it('23. relative path → null', () => expect(normalisePhotoUrl('/images/photo.jpg')).toBeNull());
  it('24. data: URI → null', () => expect(normalisePhotoUrl('data:image/png;base64,abc')).toBeNull());
});

describe('normalisePhotoUrl — valid URLs', () => {
  it('25. http:// URL → returned as-is', () => {
    const url = 'http://images.openfoodfacts.org/images/products/001/front.jpg';
    expect(normalisePhotoUrl(url)).toBe(url);
  });

  it('26. https:// URL → returned as-is', () => {
    const url = 'https://images-na.ssl-images-amazon.com/images/P/B08N5WRWNW.01._SCLZZZZZZZ_.jpg';
    expect(normalisePhotoUrl(url)).toBe(url);
  });

  it('27. HTTPS:// uppercase protocol → accepted (case-insensitive)', () => {
    const url = 'HTTPS://example.com/photo.jpg';
    expect(normalisePhotoUrl(url)).toBe(url);
  });

  it('28. URL with surrounding whitespace → trimmed', () => {
    const url = 'https://example.com/photo.jpg';
    expect(normalisePhotoUrl(`  ${url}  `)).toBe(url);
  });

  it('29. Wayfair CDN URL → returned', () => {
    const url = 'https://assets.wfcdn.com/im/12345/compr-r85/5678/photo.jpg';
    expect(normalisePhotoUrl(url)).toBe(url);
  });

  it('30. Amazon m.media URL → returned', () => {
    const url = 'https://m.media-amazon.com/images/I/71abc.jpg';
    expect(normalisePhotoUrl(url)).toBe(url);
  });
});

describe('normalisePhotoUrl — "no image available" placeholder graphics', () => {
  it('31. Wayfair default_image.jpg → null', () =>
    expect(
      normalisePhotoUrl(
        'https://secure.img1-fg.wfcdn.com/im/77375014/resize-h400-w400%5Ecompr-r85/67248/164367248/default_image.jpg',
      ),
    ).toBeNull());
  it('32. no-image marker → null', () =>
    expect(normalisePhotoUrl('https://cdn.example.com/assets/no-image.png')).toBeNull());
  it('33. no_image marker → null', () =>
    expect(normalisePhotoUrl('https://cdn.example.com/no_image_available.jpg')).toBeNull());
  it('34. placeholder marker → null', () =>
    expect(normalisePhotoUrl('https://cdn.example.com/img/placeholder.jpg')).toBeNull());
  it('35. image-coming-soon marker → null', () =>
    expect(normalisePhotoUrl('https://cdn.example.com/image-coming-soon.jpg')).toBeNull());
  it('36. case-insensitive marker (DEFAULT_IMAGE) → null', () =>
    expect(normalisePhotoUrl('https://secure.img1-fg.wfcdn.com/im/1/DEFAULT_IMAGE.JPG')).toBeNull());
  it('37. real wfcdn product image (no marker) → returned as-is', () => {
    const url =
      'https://secure.img1-fg.wfcdn.com/im/12345678/resize-h800-w800/9999/sabirah-pillow.jpg';
    expect(normalisePhotoUrl(url)).toBe(url);
  });
});
