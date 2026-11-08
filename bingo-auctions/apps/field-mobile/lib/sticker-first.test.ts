// Pre-stickered mode: sticker before save. Fake codes only.
import { describe, it, expect } from 'vitest';
import { planStickerBeforeSave } from './sticker-first';

const physical = (c: string) => /^[A-Z]{3}\d{7}$/.test(c);

describe('planStickerBeforeSave', () => {
  it('Generate mode never needs a sticker', () => {
    expect(planStickerBeforeSave({ mode: 'generate' })).toEqual({ action: 'save', sticker: null });
    expect(planStickerBeforeSave({ mode: 'generate', scannedCode: 'TEA0000001', looksLikePhysicalSticker: physical })).toEqual({
      action: 'save',
      sticker: null,
    });
  });

  it('Pre-stickered with nothing known: scan first', () => {
    expect(planStickerBeforeSave({ mode: 'prestickered' })).toEqual({ action: 'scan_first' });
    expect(planStickerBeforeSave({ mode: 'lpn_sticker' })).toEqual({ action: 'scan_first' });
  });

  it('Quick Lot: the creating scan is the sticker when it looks like a physical label', () => {
    expect(
      planStickerBeforeSave({ mode: 'prestickered', scannedCode: 'TEA0000001', looksLikePhysicalSticker: physical }),
    ).toEqual({ action: 'save', sticker: 'TEA0000001' });
  });

  it('Quick Lot: a UPC scan or a manifest (shipping label) match is not a sticker', () => {
    expect(
      planStickerBeforeSave({ mode: 'prestickered', scannedCode: '012345678905', looksLikePhysicalSticker: physical }),
    ).toEqual({ action: 'scan_first' });
    expect(
      planStickerBeforeSave({
        mode: 'prestickered',
        scannedCode: 'TEA0000001',
        isManifestMatch: true,
        looksLikePhysicalSticker: physical,
      }),
    ).toEqual({ action: 'scan_first' });
    // No test function supplied: never assume the scan is a sticker.
    expect(planStickerBeforeSave({ mode: 'prestickered', scannedCode: 'TEA0000001' })).toEqual({ action: 'scan_first' });
  });

  it('Manual: a sticker handed over from Quick Lot counts', () => {
    expect(planStickerBeforeSave({ mode: 'prestickered', prefilledSticker: ' TEA0000002 ' })).toEqual({
      action: 'save',
      sticker: 'TEA0000002',
    });
  });

  it('a captured sticker wins over everything else', () => {
    expect(
      planStickerBeforeSave({
        mode: 'prestickered',
        scannedCode: 'TEA0000001',
        prefilledSticker: 'TEA0000002',
        capturedSticker: 'TEA0000003',
        looksLikePhysicalSticker: physical,
      }),
    ).toEqual({ action: 'save', sticker: 'TEA0000003' });
  });

  it("a manager's deliberate skip saves with no sticker and does not loop back to the scanner", () => {
    expect(planStickerBeforeSave({ mode: 'prestickered', capturedSticker: '' })).toEqual({ action: 'save', sticker: null });
  });
});
