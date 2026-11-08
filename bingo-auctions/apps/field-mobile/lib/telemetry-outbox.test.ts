// Tests for the telemetry outbox. The 2026-09-23 failure — evidence deleted
// before a send that then timed out on a slow connection — is the first case.

import { describe, it, expect } from 'vitest';
import {
  OUTBOX_KEY,
  OUTBOX_MAX,
  OUTBOX_MAX_AGE_MS,
  OUTBOX_MAX_ATTEMPTS,
  enqueueReports,
  newReportId,
  sendOutcomeFor,
  flushOutbox,
  parseOutbox,
  type CrashReportBody,
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

const report = (message: string): CrashReportBody => ({ message, screen: '/', is_fatal: false });
const queuedMessages = (store: { data: Record<string, string> }) =>
  parseOutbox(store.data[OUTBOX_KEY] ?? null).map((e) => e.body.message);

const NOW = 1_790_000_000_000;

describe('flushOutbox', () => {
  it('keeps a report whose send failed, and sends it on a later flush', async () => {
    const store = memoryStore();
    await enqueueReports(store, [report('silent exit on /')], NOW);

    const offline = await flushOutbox(store, async () => 'retry', NOW);
    expect(offline).toEqual({ sent: 0, kept: 1, dropped: 0 });
    expect(queuedMessages(store)).toEqual(['silent exit on /']);

    const sent: string[] = [];
    const online = await flushOutbox(store, async (b) => (sent.push(b.message), 'accepted'), NOW + 1000);
    expect(online).toEqual({ sent: 1, kept: 0, dropped: 0 });
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
    await flushOutbox(store, async (b) => (b.message === 'b' ? 'accepted' : 'retry'), NOW);
    expect(queuedMessages(store)).toEqual(['a', 'c']);
  });

  it('does not lose a report queued while a flush waits on the network', async () => {
    const store = memoryStore();
    await enqueueReports(store, [report('first')], NOW);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const flushing = flushOutbox(store, async () => (await gate, 'accepted' as const), NOW);
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
    expect(parseOutbox('[{"body":{"message":"a","screen":"/","is_fatal":false},"queuedAt":1,"att')).toEqual([]);
    expect(parseOutbox('{"not":"an array"}')).toEqual([]);
    expect(parseOutbox('[null, {"body":{}}, 7]')).toEqual([]);
  });
});

describe('report ids (2026-09-28: a lost reply stored the report twice)', () => {
  it('sends the same id on every attempt of one report, and different ids for different reports', async () => {
    const store = memoryStore();
    await enqueueReports(store, [report('a'), report('b')], NOW);
    const seen: Record<string, string[]> = {};
    const record = async (b: CrashReportBody, id: string) => {
      (seen[b.message] ??= []).push(id);
      return 'retry' as const;
    };
    await flushOutbox(store, record, NOW);
    await flushOutbox(store, record, NOW + 1);
    expect(seen.a).toHaveLength(2);
    expect(seen.a?.[0]).toBe(seen.a?.[1]);
    expect(seen.a?.[0]).not.toBe(seen.b?.[0]);
  });

  it('gives an entry queued before ids existed an id once, and keeps it', async () => {
    const legacy = JSON.stringify([{ body: report('old'), queuedAt: NOW, attempts: 2 }]);
    const store = memoryStore({ [OUTBOX_KEY]: legacy });
    const ids: string[] = [];
    await flushOutbox(store, async (_b, id) => (ids.push(id), 'retry'), NOW);
    await flushOutbox(store, async (_b, id) => (ids.push(id), 'retry'), NOW);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(ids[1]).toBe(ids[0]);
  });

  it('newReportId is a v4 uuid the server accepts', () => {
    for (let i = 0; i < 200; i++) {
      expect(newReportId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });
});

describe('rejected reports stop (2026-09-28: a 4xx was resent for 7 days)', () => {
  it('drops a report the server rejects, keeps one it asked to retry', async () => {
    const store = memoryStore();
    await enqueueReports(store, [report('bad'), report('later')], NOW);
    const out = await flushOutbox(store, async (b) => (b.message === 'bad' ? 'rejected' : 'retry'), NOW);
    expect(out).toEqual({ sent: 0, kept: 1, dropped: 1 });
    expect(queuedMessages(store)).toEqual(['later']);
  });

  it('drops a report after OUTBOX_MAX_ATTEMPTS retries', async () => {
    const store = memoryStore();
    await enqueueReports(store, [report('stuck')], NOW);
    let last = { sent: 0, kept: 0, dropped: 0 };
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i++) last = await flushOutbox(store, async () => 'retry', NOW);
    expect(last).toEqual({ sent: 0, kept: 0, dropped: 1 });
    expect(queuedMessages(store)).toEqual([]);
  });

  it('maps HTTP status to outcome', () => {
    expect(sendOutcomeFor(204)).toBe('accepted');
    expect(sendOutcomeFor(202)).toBe('accepted'); // stored:false, the server gave up on it
    expect(sendOutcomeFor(400)).toBe('rejected');
    expect(sendOutcomeFor(413)).toBe('rejected');
    expect(sendOutcomeFor(408)).toBe('retry');
    expect(sendOutcomeFor(429)).toBe('retry');
    expect(sendOutcomeFor(503)).toBe('retry');
    expect(sendOutcomeFor(500)).toBe('retry');
  });
});
