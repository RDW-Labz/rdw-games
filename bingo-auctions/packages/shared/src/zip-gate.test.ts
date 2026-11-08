import { describe, expect, it } from 'vitest';
import {
  HEARD_ABOUT_OPTIONS,
  HEARD_ABOUT_OTHER_MAX_LEN,
  ZIP_FORMAT_ERROR,
  ZIP_UNKNOWN_ERROR,
  createZipChecker,
  isValidHeardAbout,
  needsZipBeforeBid,
  sanitizeHeardAboutOther,
  validateZipFormat,
  type ZipReferenceLookup,
} from './zip-gate';

describe('validateZipFormat', () => {
  it('accepts five digits, trimmed', () => {
    expect(validateZipFormat('72712')).toEqual({ ok: true, zip: '72712' });
    expect(validateZipFormat('  72712 ')).toEqual({ ok: true, zip: '72712' });
  });
  it('rejects empty, short, long, and non-digit input (no "clear" here)', () => {
    for (const bad of ['', '   ', '7271', '727123', 'abcde', '72712-1234', null, undefined]) {
      expect(validateZipFormat(bad as string | null | undefined)).toEqual({
        ok: false,
        error: ZIP_FORMAT_ERROR,
      });
    }
  });
});

describe('needsZipBeforeBid', () => {
  it('true for null, undefined, empty string', () => {
    expect(needsZipBeforeBid(null)).toBe(true);
    expect(needsZipBeforeBid(undefined)).toBe(true);
    expect(needsZipBeforeBid('')).toBe(true);
  });
  it('false once a ZIP is on file', () => {
    expect(needsZipBeforeBid('72712')).toBe(false);
  });
  it('ignores snooze-style concerns entirely — it only looks at the ZIP', () => {
    // There is no prompt_count / prompt_after parameter at all: the gate's
    // signature only accepts the ZIP itself, so a snoozed dismissible prompt
    // can never suppress the mandatory block.
    expect(needsZipBeforeBid('72712')).toBe(false);
  });
});

function fakeLookup(over: Partial<ZipReferenceLookup> = {}): ZipReferenceLookup {
  return {
    hasAnyRows: async () => false,
    exists: async () => false,
    ...over,
  };
}

describe('createZipChecker', () => {
  it('rejects bad format before ever calling the lookup', async () => {
    let called = false;
    const checker = createZipChecker(
      fakeLookup({ hasAnyRows: async () => ((called = true), true) }),
    );
    expect(await checker.check('abc')).toEqual({ ok: false, reason: 'format', error: ZIP_FORMAT_ERROR });
    expect(called).toBe(false);
  });

  it('empty zip_reference table: format-only, any 5-digit ZIP passes', async () => {
    const checker = createZipChecker(fakeLookup({ hasAnyRows: async () => false }));
    expect(await checker.check('99999')).toEqual({ ok: true, zip: '99999' });
  });

  it('populated table: unknown ZIP is rejected, known ZIP passes', async () => {
    const checker = createZipChecker(
      fakeLookup({
        hasAnyRows: async () => true,
        exists: async (z) => z === '72712',
      }),
    );
    expect(await checker.check('72712')).toEqual({ ok: true, zip: '72712' });
    expect(await checker.check('00000')).toEqual({
      ok: false,
      reason: 'unknown',
      error: ZIP_UNKNOWN_ERROR,
    });
  });

  it('caches the "has any rows" check — only queried once per instance', async () => {
    let calls = 0;
    const checker = createZipChecker(
      fakeLookup({
        hasAnyRows: async () => ((calls += 1), false),
      }),
    );
    await checker.check('11111');
    await checker.check('22222');
    await checker.check('33333');
    expect(calls).toBe(1);
  });

  it('fails OPEN on a network error from hasAnyRows', async () => {
    const checker = createZipChecker(
      fakeLookup({
        hasAnyRows: async () => {
          throw new Error('offline');
        },
      }),
    );
    expect(await checker.check('72712')).toEqual({ ok: true, zip: '72712' });
  });

  it('fails OPEN on a network error from exists, after the table is known populated', async () => {
    const checker = createZipChecker(
      fakeLookup({
        hasAnyRows: async () => true,
        exists: async () => {
          throw new Error('offline');
        },
      }),
    );
    expect(await checker.check('72712')).toEqual({ ok: true, zip: '72712' });
  });
});

describe('heard-about helpers', () => {
  it('isValidHeardAbout accepts exactly the listed values', () => {
    for (const opt of HEARD_ABOUT_OPTIONS) {
      expect(isValidHeardAbout(opt.value)).toBe(true);
    }
    expect(isValidHeardAbout('made_up')).toBe(false);
    expect(isValidHeardAbout(null)).toBe(false);
    expect(isValidHeardAbout(undefined)).toBe(false);
    expect(isValidHeardAbout('')).toBe(false);
  });

  it('sanitizeHeardAboutOther trims and caps at the max length', () => {
    expect(sanitizeHeardAboutOther('  flyer at the gate  ')).toBe('flyer at the gate');
    expect(sanitizeHeardAboutOther(null)).toBe('');
    expect(sanitizeHeardAboutOther(undefined)).toBe('');
    const long = 'x'.repeat(200);
    const capped = sanitizeHeardAboutOther(long);
    expect(capped.length).toBe(HEARD_ABOUT_OTHER_MAX_LEN);
  });
});
