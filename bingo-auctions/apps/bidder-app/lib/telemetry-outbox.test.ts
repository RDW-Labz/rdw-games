// Tests for the telemetry outbox. The 2026-09-23 failure — evidence deleted
// before a send that then timed out on a slow connection — is the first case.

import { describe, it, expect } from 'vitest';
import type { CrashReportBody } from './telemetry-post';
import {
  OUTBOX_KEY,
  OUTBOX_MAX,
  OUTBOX_MAX_AGE_MS,
  enqueueReports,
  flushOutbox,
  parseOutbox,
  type KeyValueStore,
} from './telemetry-outbox';

function memoryStore(initial: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: async (k) => data[k] ?? null,
    setItem: async (k, v) => {
      data[k] = v;
    },
  };
}

const report = (message: string): CrashReportBody => ({ message, is_fatal: false });
const queuedMessages = (store: { data: Record<string, string> }) =>
  parseOutbox(store.data[OUTBOX_KEY] ?? null).map((e) => e.body.message);

const NOW = 1_790_000_000_000;

describe('flushOutbox', () => {
  it('keeps a report whose send failed, and sends it on a later flush', async () => {
    const store = memoryStore();
    await enqueueReports(store, [report('silent exit on /')], NOW);

    const offline = await flushOutbox(store, async () => false, NOW);
    expect(offline).toEqual({ sent: 0, kept: 1 });
    expect(queuedMessages(store)).toEqual(['silent exit on /']);

    const sent: string[] = [];
    const online = await flushOutbox(store, async (b) => (sent.push(b.message), true), NOW + 1000);
    expect(online).toEqual({ sent: 1, kept: 0 });
    expect(sent).toEqual(['silent exit on /']);
    expect(queuedMessages(store)).toEqual([]);
  });

  it('treats a sender that throws (timeout, abort) as a failure', async () => {
    const store = memoryStore();
    await enqueueReports(store, [report('a')], NOW);
    await flushOutbox(store, async () => {
      throw new Error('AbortError');
    }, NOW);
    expect(queuedMessages(store)).toEqual(['a']);
    expect(parseOutbox(store.data[OUTBOX_KEY] ?? null)[0]?.attempts).toBe(1);
  });

  it('removes only the accepted reports and keeps the rest in order', async () => {
    const store = memoryStore();
    await enqueueReports(store, [report('a'), report('b'), report('c')], NOW);
    await flushOutbox(store, async (b) => b.message === 'b', NOW);
    expect(queuedMessages(store)).toEqual(['a', 'c']);
  });

  it('does not lose a report queued while a flush waits on the network', async () => {
    const store = memoryStore();
    await enqueueReports(store, [report('first')], NOW);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const flushing = flushOutbox(store, async () => (await gate, true), NOW);
    const queuing = enqueueReports(store, [report('second')], NOW);
    release();
    await Promise.all([flushing, queuing]);

    expect(queuedMessages(store)).toEqual(['second']);
  });
});

describe('enqueueReports', () => {
  it('caps the queue at the newest OUTBOX_MAX reports', async () => {
    const store = memoryStore();
    const many = Array.from({ length: OUTBOX_MAX + 5 }, (_, i) => report(`r${i}`));
    await enqueueReports(store, many, NOW);
    const kept = queuedMessages(store);
    expect(kept).toHaveLength(OUTBOX_MAX);
    expect(kept[0]).toBe('r5');
    expect(kept.at(-1)).toBe(`r${OUTBOX_MAX + 4}`);
  });

  it('drops reports older than OUTBOX_MAX_AGE_MS', async () => {
    const store = memoryStore();
    await enqueueReports(store, [report('old')], NOW);
    await enqueueReports(store, [report('new')], NOW + OUTBOX_MAX_AGE_MS + 1);
    expect(queuedMessages(store)).toEqual(['new']);
  });

  it('reports false when storage fails, so callers keep the evidence', async () => {
    const broken: KeyValueStore = {
      getItem: async () => null,
      setItem: async () => {
        throw new Error('disk full');
      },
    };
    expect(await enqueueReports(broken, [report('a')], NOW)).toBe(false);
  });
});

describe('parseOutbox', () => {
  it('survives a queue half-written by a kill', () => {
    expect(parseOutbox('[{"body":{"message":"a","is_fatal":false},"queuedAt":1,"att')).toEqual([]);
    expect(parseOutbox('{"not":"an array"}')).toEqual([]);
    expect(parseOutbox('[null, {"body":{}}, 7]')).toEqual([]);
  });
});
