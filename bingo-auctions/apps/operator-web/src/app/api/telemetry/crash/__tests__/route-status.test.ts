// The crash sink's reply decides whether the app keeps a queued report: both
// apps delete it only on a 2xx. It used to answer 204 even when the insert
// failed, so a report that was never stored was deleted on the phone.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';

const { insert, upsert } = vi.hoisted(() => ({ insert: vi.fn(), upsert: vi.fn() }));

vi.mock('@/lib/supabase-admin', () => ({
  getSupabaseAdmin: () => ({ from: () => ({ insert, upsert }) }),
}));

import { POST } from '../route';

function req(body: unknown): NextRequest {
  return new Request('https://bingoauctions.com/api/telemetry/crash', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }) as unknown as NextRequest;
}

const report = { app: 'bidder', platform: 'ios', message: 'TypeError: x is undefined', is_fatal: true };

describe('POST /api/telemetry/crash status', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    insert.mockReset();
    upsert.mockReset();
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => errSpy.mockRestore());

  it('204 when the report is stored', async () => {
    insert.mockResolvedValue({ error: null });
    const res = await POST(req(report));
    expect(res.status).toBe(204);
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('503 when the insert fails for a transient reason, so the app keeps the report', async () => {
    insert.mockResolvedValue({ error: { code: '', message: 'TypeError: fetch failed' } });
    const res = await POST(req(report));
    expect(res.status).toBe(503);
    expect(res.ok).toBe(false);
  });

  it('503 on a statement timeout or connection error', async () => {
    for (const code of ['57014', '08006', 'PGRST000']) {
      insert.mockResolvedValue({ error: { code, message: 'down' } });
      expect((await POST(req(report))).status).toBe(503);
    }
  });

  it('202 stored:false when the database rejects the data, so the app stops retrying it', async () => {
    for (const code of ['22P05', '23514', '22001']) {
      insert.mockResolvedValue({ error: { code, message: 'rejected' } });
      const res = await POST(req(report));
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ stored: false });
    }
  });

  it('strips NUL characters before inserting', async () => {
    insert.mockResolvedValue({ error: null });
    await POST(req({ ...report, message: 'bad\u0000msg', stack: 'at a\u0000b', screen: '/lots\u0000' }));
    const row = insert.mock.calls[0]?.[0] as Record<string, string>;
    expect(row.message).toBe('badmsg');
    expect(row.stack).toBe('at ab');
    expect(row.screen).toBe('/lots');
  });

  it('400 on a malformed body, without touching the database', async () => {
    expect((await POST(req('not json'))).status).toBe(400);
    expect((await POST(req({ ...report, app: 'other' }))).status).toBe(400);
    expect(insert).not.toHaveBeenCalled();
  });

  it('with a report_id: upsert that ignores a duplicate, and 204 either way', async () => {
    upsert.mockResolvedValue({ error: null });
    const id = '3f1c7a52-9d7e-4b8e-a1f0-2c9b7d4e6a11';
    const res = await POST(req({ ...report, report_id: id }));
    expect(res.status).toBe(204);
    expect(insert).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ report_id: id, message: report.message }), {
      onConflict: 'report_id',
      ignoreDuplicates: true,
    });
  });

  it('without a report_id: plain insert, no report_id column sent (older builds)', async () => {
    insert.mockResolvedValue({ error: null });
    await POST(req(report));
    expect(upsert).not.toHaveBeenCalled();
    const row = insert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row).not.toHaveProperty('report_id');
    for (const key of [
      'device_model',
      'os_version',
      'free_storage_bytes',
      'total_memory_bytes',
      'js_heap_bytes',
    ]) {
      expect(row).not.toHaveProperty(key);
    }
  });

  it('400 on a report_id that is not a uuid', async () => {
    expect((await POST(req({ ...report, report_id: 'abc' }))).status).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('503 when the upsert fails transiently, so the app resends with the same id', async () => {
    upsert.mockResolvedValue({ error: { code: '57014', message: 'timeout' } });
    const res = await POST(req({ ...report, report_id: '3f1c7a52-9d7e-4b8e-a1f0-2c9b7d4e6a11' }));
    expect(res.status).toBe(503);
  });

  it('stores optional device fields when present', async () => {
    insert.mockResolvedValue({ error: null });
    await POST(
      req({
        ...report,
        device_model: 'iPhone 15',
        os_version: '18.0',
        free_storage_bytes: 1_000_000,
        total_memory_bytes: 8_000_000_000,
        js_heap_bytes: 4_194_304,
      }),
    );
    expect(insert.mock.calls[0]?.[0]).toMatchObject({
      device_model: 'iPhone 15',
      os_version: '18.0',
      free_storage_bytes: 1_000_000,
      total_memory_bytes: 8_000_000_000,
      js_heap_bytes: 4_194_304,
    });
  });

  it('400 when device fields have invalid types', async () => {
    expect((await POST(req({ ...report, free_storage_bytes: -1 }))).status).toBe(400);
    expect((await POST(req({ ...report, js_heap_bytes: 1.5 }))).status).toBe(400);
    expect((await POST(req({ ...report, device_model: 'x'.repeat(101) }))).status).toBe(400);
    expect(insert).not.toHaveBeenCalled();
  });

  it('204 when all device fields are null (unknown device context)', async () => {
    insert.mockResolvedValue({ error: null });
    const res = await POST(
      req({
        ...report,
        device_model: null,
        os_version: null,
        free_storage_bytes: null,
        total_memory_bytes: null,
        js_heap_bytes: null,
      }),
    );
    expect(res.status).toBe(204);
    const row = insert.mock.calls[0]?.[0] as Record<string, unknown>;
    for (const key of [
      'device_model',
      'os_version',
      'free_storage_bytes',
      'total_memory_bytes',
      'js_heap_bytes',
    ]) {
      expect(row).not.toHaveProperty(key);
    }
  });

  it('retries insert without device columns when Postgres returns undefined_column (42703)', async () => {
    insert
      .mockResolvedValueOnce({
        error: { code: '42703', message: 'column "device_model" does not exist' },
      })
      .mockResolvedValueOnce({ error: null });
    const res = await POST(
      req({
        ...report,
        device_model: 'iPhone 15',
        os_version: '18.0',
        free_storage_bytes: 1_000,
      }),
    );
    expect(res.status).toBe(204);
    expect(insert).toHaveBeenCalledTimes(2);
    const first = insert.mock.calls[0]?.[0] as Record<string, unknown>;
    const second = insert.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(first).toMatchObject({ device_model: 'iPhone 15' });
    for (const key of [
      'device_model',
      'os_version',
      'free_storage_bytes',
      'total_memory_bytes',
      'js_heap_bytes',
    ]) {
      expect(second).not.toHaveProperty(key);
    }
  });
});
