import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { getFreeDiskStorageAsync } = vi.hoisted(() => ({
  getFreeDiskStorageAsync: vi.fn(async () => 12_345_678),
}));

vi.mock('expo-device', () => ({
  modelName: 'iPhone 15',
  osVersion: '18.0',
  totalMemory: 8_000_000_000,
}));

vi.mock('expo-file-system/legacy', () => ({
  getFreeDiskStorageAsync,
}));

import {
  captureDeviceSnapshot,
  mergeWatchdogDeviceSnapshot,
  readDeviceModelOs,
} from './device-snapshot';

describe('readDeviceModelOs', () => {
  it('returns model and os from expo-device', () => {
    expect(readDeviceModelOs()).toEqual({ device_model: 'iPhone 15', os_version: '18.0' });
  });
});

describe('captureDeviceSnapshot', () => {
  beforeEach(() => {
    getFreeDiskStorageAsync.mockResolvedValue(12_345_678);
    (globalThis as unknown as { HermesInternal?: unknown }).HermesInternal = {
      getInstrumentedStats: () => ({ js_heapSize: 4_194_304 }),
    };
  });
  afterEach(() => {
    delete (globalThis as unknown as { HermesInternal?: unknown }).HermesInternal;
  });

  it('collects all fields when modules succeed', async () => {
    await expect(captureDeviceSnapshot()).resolves.toEqual({
      device_model: 'iPhone 15',
      os_version: '18.0',
      free_storage_bytes: 12_345_678,
      total_memory_bytes: 8_000_000_000,
      js_heap_bytes: 4_194_304,
    });
  });

  it('returns nulls on timeout', async () => {
    getFreeDiskStorageAsync.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(1), 500)),
    );
    await expect(captureDeviceSnapshot()).resolves.toEqual({
      device_model: null,
      os_version: null,
      free_storage_bytes: null,
      total_memory_bytes: null,
      js_heap_bytes: null,
    });
  });
});

describe('mergeWatchdogDeviceSnapshot', () => {
  it('uses mark-time model/os and report-time storage/memory/heap', () => {
    expect(
      mergeWatchdogDeviceSnapshot(
        { device_model: 'iPad', os_version: '17.4' },
        { free_storage_bytes: 100, total_memory_bytes: 200, js_heap_bytes: 50 },
      ),
    ).toEqual({
      device_model: 'iPad',
      os_version: '17.4',
      free_storage_bytes: 100,
      total_memory_bytes: 200,
      js_heap_bytes: 50,
    });
  });
});
