import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const { setItem, captureDeviceSnapshot, getCrashHandler } = vi.hoisted(() => {
  const setItem = vi.fn(() => Promise.resolve());
  let crashHandler: ((error: unknown, isFatal?: boolean) => void) | undefined;
  const previous = vi.fn();
  (globalThis as unknown as { ErrorUtils?: unknown }).ErrorUtils = {
    getGlobalHandler: () => previous,
    setGlobalHandler: (h: (error: unknown, isFatal?: boolean) => void) => {
      crashHandler = h;
    },
  };
  return {
    setItem,
    captureDeviceSnapshot: vi.fn(),
    getCrashHandler: () => crashHandler,
  };
});

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { setItem, removeItem: vi.fn(() => Promise.resolve()) },
}));

vi.mock('./device-snapshot', () => ({ captureDeviceSnapshot }));

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.0' } } }));
vi.mock('expo-updates', () => ({ updateId: null }));

describe('crash-reporter disk-first', () => {
  let PENDING_CRASH_KEY: string;
  let resolveSnapshot: (value: Record<string, null>) => void;

  beforeAll(async () => {
    vi.resetModules();
    const mod = await import('./crash-reporter');
    PENDING_CRASH_KEY = mod.PENDING_CRASH_KEY;
    mod.installCrashReporter();
    expect(getCrashHandler()).toBeTypeOf('function');
  });

  beforeEach(() => {
    setItem.mockClear();
    captureDeviceSnapshot.mockClear();
    captureDeviceSnapshot.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve;
        }),
    );
    globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true } as Response));
  });

  it('calls AsyncStorage.setItem before captureDeviceSnapshot resolves', () => {
    getCrashHandler()!(new Error('disk-first'), true);

    expect(setItem).toHaveBeenCalledTimes(1);
    expect(setItem).toHaveBeenCalledWith(PENDING_CRASH_KEY, expect.any(String));
    const [, raw] = setItem.mock.calls[0] as unknown as [string, string];
    const firstBody = JSON.parse(raw) as Record<string, unknown>;
    expect(firstBody.message).toBe('disk-first');
    expect(firstBody).not.toHaveProperty('device_model');

    resolveSnapshot({
      device_model: null,
      os_version: null,
      free_storage_bytes: null,
      total_memory_bytes: null,
      js_heap_bytes: null,
    });
  });
});
