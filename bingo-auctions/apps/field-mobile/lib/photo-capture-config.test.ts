import { describe, it, expect, vi } from 'vitest';
import type { CameraDeviceFormat } from 'react-native-vision-camera';
import {
  selectLargestPhotoFormatAtOrUnderCap,
  compressForVisionSequential,
  CAPTURE_MAX_PHOTO_PX,
} from './photo-capture-config';

function fmt(photoWidth: number, photoHeight: number): CameraDeviceFormat {
  return {
    photoWidth,
    photoHeight,
    videoWidth: 1920,
    videoHeight: 1080,
    maxISO: 800,
    minISO: 100,
    fieldOfView: 60,
    supportsVideoHdr: false,
    supportsPhotoHdr: false,
    supportsDepthCapture: false,
    autoFocusSystem: 'contrast-detection',
    videoStabilizationModes: ['off'],
    maxFps: 30,
    minFps: 30,
  };
}

describe('selectLargestPhotoFormatAtOrUnderCap', () => {
  it('returns undefined for an empty list', () => {
    expect(selectLargestPhotoFormatAtOrUnderCap([], CAPTURE_MAX_PHOTO_PX)).toBeUndefined();
  });

  it('returns the largest format at or under the cap', () => {
    const formats = [
      fmt(1280, 960),
      fmt(1920, 1440),
      fmt(1600, 1200),
      fmt(4032, 3024),
    ];
    const picked = selectLargestPhotoFormatAtOrUnderCap(formats, CAPTURE_MAX_PHOTO_PX);
    expect(picked?.photoWidth).toBe(1920);
    expect(picked?.photoHeight).toBe(1440);
  });

  it('ignores formats above the cap on either axis', () => {
    const formats = [fmt(2000, 1400), fmt(1920, 1500), fmt(1280, 960)];
    const picked = selectLargestPhotoFormatAtOrUnderCap(formats, CAPTURE_MAX_PHOTO_PX);
    expect(picked?.photoWidth).toBe(1280);
    expect(picked?.photoHeight).toBe(960);
  });
});

describe('compressForVisionSequential', () => {
  it('awaits compress in array order', async () => {
    const order: string[] = [];
    const compressFn = vi.fn(async (uri: string) => {
      order.push(uri);
      return `b64-${uri}`;
    });

    const result = await compressForVisionSequential(
      [
        { uri: 'a', width: 100, height: 100 },
        { uri: 'b', width: 200, height: 150 },
      ],
      compressFn,
    );

    expect(order).toEqual(['a', 'b']);
    expect(compressFn).toHaveBeenCalledTimes(2);
    expect(compressFn.mock.calls[0]).toEqual(['a', { width: 100, height: 100 }]);
    expect(result).toEqual([
      { base64: 'b64-a', mediaType: 'image/jpeg' },
      { base64: 'b64-b', mediaType: 'image/jpeg' },
    ]);
  });
});
