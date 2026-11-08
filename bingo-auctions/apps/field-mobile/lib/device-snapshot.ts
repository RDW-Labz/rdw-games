// Best-effort device context for crash telemetry. No new dependencies — expo-device
// plus the same expo-file-system/legacy import as lib/upload-image.ts.

import * as Device from 'expo-device';
import * as FileSystem from 'expo-file-system/legacy';

export interface DeviceSnapshot {
  device_model: string | null;
  os_version: string | null;
  free_storage_bytes: number | null;
  total_memory_bytes: number | null;
  js_heap_bytes: number | null;
}

const SNAPSHOT_TIMEOUT_MS = 300;

const NULL_SNAPSHOT: DeviceSnapshot = {
  device_model: null,
  os_version: null,
  free_storage_bytes: null,
  total_memory_bytes: null,
  js_heap_bytes: null,
};

function safeString(value: unknown, maxLen = 100): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (!t) return null;
  return t.length > maxLen ? t.slice(0, maxLen) : t;
}

function safeNonNegInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

/** Model and OS only — cheap enough to write on every session-watchdog heartbeat. */
export function readDeviceModelOs(): Pick<DeviceSnapshot, 'device_model' | 'os_version'> {
  try {
    return {
      device_model: safeString(Device.modelName),
      os_version: safeString(Device.osVersion),
    };
  } catch {
    return { device_model: null, os_version: null };
  }
}

function readJsHeapBytes(): number | null {
  try {
    const stats = (
      globalThis as unknown as {
        HermesInternal?: { getInstrumentedStats?: () => { js_heapSize?: number } };
      }
    ).HermesInternal?.getInstrumentedStats?.();
    return safeNonNegInt(stats?.js_heapSize);
  } catch {
    return null;
  }
}

async function collectSnapshotBody(): Promise<DeviceSnapshot> {
  const { device_model, os_version } = readDeviceModelOs();
  let free_storage_bytes: number | null = null;
  let total_memory_bytes: number | null = null;
  try {
    total_memory_bytes = safeNonNegInt(Device.totalMemory);
  } catch {
    // ignore
  }
  try {
    if (typeof FileSystem.getFreeDiskStorageAsync === 'function') {
      free_storage_bytes = safeNonNegInt(await FileSystem.getFreeDiskStorageAsync());
    }
  } catch {
    // ignore
  }
  const js_heap_bytes = readJsHeapBytes();
  return {
    device_model,
    os_version,
    free_storage_bytes,
    total_memory_bytes,
    js_heap_bytes,
  };
}

/**
 * Full snapshot for crash reporting. Never throws; returns null fields on error
 * or if collection exceeds {@link SNAPSHOT_TIMEOUT_MS}.
 */
export async function captureDeviceSnapshot(): Promise<DeviceSnapshot> {
  try {
    return await Promise.race([
      collectSnapshotBody(),
      new Promise<DeviceSnapshot>((resolve) => setTimeout(() => resolve(NULL_SNAPSHOT), SNAPSHOT_TIMEOUT_MS)),
    ]);
  } catch {
    return NULL_SNAPSHOT;
  }
}

/**
 * Silent-exit reports: model/OS from the session mark (at last heartbeat),
 * storage / RAM / heap measured when the report is built on the next launch.
 */
export function mergeWatchdogDeviceSnapshot(
  mark: Pick<DeviceSnapshot, 'device_model' | 'os_version'>,
  atReport: Pick<DeviceSnapshot, 'free_storage_bytes' | 'total_memory_bytes' | 'js_heap_bytes'>,
): DeviceSnapshot {
  return {
    device_model: mark.device_model ?? null,
    os_version: mark.os_version ?? null,
    free_storage_bytes: atReport.free_storage_bytes ?? null,
    total_memory_bytes: atReport.total_memory_bytes ?? null,
    js_heap_bytes: atReport.js_heap_bytes ?? null,
  };
}
