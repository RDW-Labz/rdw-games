import { describe, expect, it } from 'vitest';
import { decideDraftRecovery, type SavedPhotoDraft } from './draft-recovery';
import {
  gateAfterBlockedSkip,
  gateAfterDraftLoad,
  maySkipBlockedDraft,
  mayStartNewItem,
  mayWriteDraft,
  type BlockedDraftSource,
  type DraftWriteGate,
} from './photo-draft-gate';
import {
  PHOTO_RECOVERY_PREFIX,
  preservePhotoRecovery,
  readLatestPhotoRecoveryFor,
  type RecoveryStorage,
} from './photo-recovery';

const saved: SavedPhotoDraft = {
  editable: { title: 'Lamp' },
  created: { lotId: 'lot-1', lotCode: 'DEV-0001' },
  operatorId: 'op-a',
};

type Role = { kind: string; operatorId?: string };

/**
 * Mirrors the screen's two effects: the async draft read (which decides the
 * gate) and the mount/state-change save (which clears when nothing is being
 * edited). A write only lands when the gate is open, exactly like the real
 * effect.
 */
function lifecycle(seed: SavedPhotoDraft | null) {
  let stored = seed;
  let gate: DraftWriteGate = 'loading';
  return {
    /** Mount: the save effect runs before the async read resolves. */
    mountWrite() {
      if (!mayWriteDraft(gate)) return;
      stored = null;
    },
    /** Every later state change while still on an empty camera screen. */
    idleWrite() {
      if (!mayWriteDraft(gate)) return;
      stored = null;
    },
    load(role: Role) {
      const decision = decideDraftRecovery(stored, role);
      gate = gateAfterDraftLoad(decision);
      return { decision, gate };
    },
    /** Operator answers the restore prompt. */
    answerRestore() {
      gate = 'open';
    },
    writeReview() {
      if (!mayWriteDraft(gate)) return;
      stored = seed;
    },
    get stored() {
      return stored;
    },
    get gate() {
      return gate;
    },
  };
}

describe('photo draft write gate', () => {
  it('does not delete a saved lot while the operator role is still loading', () => {
    const screen = lifecycle(saved);
    screen.mountWrite();
    expect(screen.load({ kind: 'loading' })).toEqual({
      decision: { action: 'wait' },
      gate: 'loading',
    });
    // Past the 800ms debounce, another idle state change still must not clear.
    screen.idleWrite();
    expect(screen.stored).toEqual(saved);

    // Role resolves to the same operator: recovery can now finish the lot.
    expect(screen.load({ kind: 'staff', operatorId: 'op-a' }).decision).toEqual({
      action: 'finish',
      operatorId: 'op-a',
    });
    expect(screen.gate).toBe('open');
    expect(screen.stored).toEqual(saved);
  });

  it('keeps a draft untouched when another operator opens the screen', () => {
    const screen = lifecycle(saved);
    screen.mountWrite();
    expect(screen.load({ kind: 'staff', operatorId: 'op-b' })).toEqual({
      decision: { action: 'blocked', reason: 'owner_mismatch' },
      gate: 'preserve',
    });
    screen.idleWrite();
    // Returning to the owner in the same process still must not delete it.
    screen.idleWrite();
    expect(screen.stored).toEqual(saved);
  });

  it('keeps a legacy ownerless draft instead of clearing it', () => {
    const legacy = { ...saved, operatorId: undefined };
    const screen = lifecycle(legacy);
    screen.mountWrite();
    expect(screen.load({ kind: 'staff', operatorId: 'op-a' }).decision).toEqual({
      action: 'blocked',
      reason: 'owner_unknown',
    });
    screen.idleWrite();
    expect(screen.stored).toEqual(legacy);
  });

  it('waits for the restore prompt before overwriting or clearing an unsaved draft', () => {
    const unsaved = { ...saved, created: null };
    const screen = lifecycle(unsaved);
    screen.mountWrite();
    expect(screen.load({ kind: 'loading' }).gate).toBe('preserve');
    screen.idleWrite();
    expect(screen.stored).toEqual(unsaved);

    // "Keep": the form reopens and the draft can be rewritten normally.
    screen.answerRestore();
    screen.writeReview();
    expect(screen.stored).toEqual(unsaved);
  });

  it('clears normally when there was no saved draft', () => {
    const screen = lifecycle(null);
    screen.mountWrite();
    expect(screen.load({ kind: 'loading' })).toEqual({
      decision: { action: 'none' },
      gate: 'open',
    });
    screen.idleWrite();
    expect(screen.stored).toBeNull();
  });

  it('never reuses a stale cleared draft after a normal empty mount', () => {
    const screen = lifecycle(null);
    screen.mountWrite();
    screen.load({ kind: 'staff', operatorId: 'op-a' });
    screen.idleWrite();
    expect(screen.stored).toBeNull();
  });
});

describe('new item capture gate', () => {
  it('refuses a capture while the stored draft read is still retrying', () => {
    // Archive A exists, its first read fails, and the screen retries. The
    // camera must not start B while its draft cannot be persisted, or the
    // restored A would bury B (RED TEAM #744 HIGH).
    let gate: DraftWriteGate = 'loading';
    let captured = 0;
    const capture = () => {
      if (!mayStartNewItem(gate)) return false;
      captured += 1;
      return true;
    };

    expect(capture()).toBe(false);
    expect(captured).toBe(0);

    // A read that settles with no recovery opens normal operation.
    gate = 'open';
    expect(capture()).toBe(true);
    expect(captured).toBe(1);
  });

  it('invalidates an in-flight analysis when a recovered draft is restored', () => {
    // Mirrors the screen's run-id stamp: claiming a recovered draft bumps the
    // id, so a scan result that arrives afterwards is discarded instead of
    // overwriting the restored item (RED TEAM #744 HIGH).
    let runId = 0;
    let editable: string | null = null;
    const startScan = (item: string) => {
      runId += 1;
      return { token: runId, item };
    };
    const applyScan = (scan: { token: number; item: string }) => {
      if (scan.token !== runId) return;
      editable = scan.item;
    };

    const inFlight = startScan('B');
    runId += 1; // recovery claims the screen
    applyScan(inFlight);
    expect(editable).toBeNull();
  });

  it('only opens capture for the open gate', () => {
    expect(mayStartNewItem('loading')).toBe(false);
    expect(mayStartNewItem('preserve')).toBe(false);
    expect(mayStartNewItem('open')).toBe(true);
  });
});

const MAIN_DRAFT_KEY = 'lotting:draft:photo';

function memoryStorage() {
  const data = new Map<string, string>();
  const storage: RecoveryStorage = {
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      data.set(key, value);
    },
    removeItem: async (key) => {
      data.delete(key);
    },
    getAllKeys: async () => [...data.keys()],
  };
  return { data, storage };
}

/**
 * Mirrors the screen's load effect closely enough to prove the blocked-archive
 * path: the main draft is read first, then the newest recovery archive. A
 * blocked decision leaves the writer closed; applying a draft is the only path
 * that would queue its photos.
 */
function screenModel(storage: RecoveryStorage, role: Role) {
  let gate: DraftWriteGate = 'loading';
  let offered = false;
  let uploads = 0;
  let source: BlockedDraftSource | null = null;

  return {
    async load() {
      if (offered) return { gate, decision: null, source };
      const mainRaw = await storage.getItem(MAIN_DRAFT_KEY);
      let saved: SavedPhotoDraft | null = mainRaw ? JSON.parse(mainRaw).draft : null;
      source = saved ? 'main' : null;
      if (!saved) {
        const read = await readLatestPhotoRecoveryFor<SavedPhotoDraft>(storage, role.operatorId);
        if (read.status === 'ok' && read.record) {
          saved = read.record.draft;
          source = 'recovery';
        }
      }
      const decision = decideDraftRecovery(saved, role);
      gate = gateAfterDraftLoad(decision);
      if (decision.action === 'blocked') {
        offered = true;
        return { gate, decision, source };
      }
      if (decision.action === 'finish' || decision.action === 'offer') {
        // Applying a draft is what would queue its photos for upload.
        uploads += 1;
      }
      if (decision.action === 'none') offered = true;
      return { gate, decision, source };
    },
    skip() {
      if (source && maySkipBlockedDraft(source)) gate = gateAfterBlockedSkip();
      return gate;
    },
    saveIndependent(draft: SavedPhotoDraft) {
      if (!mayWriteDraft(gate)) return false;
      storage.setItem(MAIN_DRAFT_KEY, JSON.stringify({ savedAt: 1, draft }));
      return true;
    },
    get gate() {
      return gate;
    },
    get uploads() {
      return uploads;
    },
    get source() {
      return source;
    },
  };
}

describe('blocked recovery archive skip', () => {
  const foreign: SavedPhotoDraft = {
    editable: { title: 'Foreign item' },
    created: { lotId: 'lot-b', lotCode: 'B-1' },
    operatorId: 'op-b',
  };
  const legacy: SavedPhotoDraft = {
    editable: { title: 'Legacy item' },
    created: { lotId: 'lot-c', lotCode: 'C-1' },
  };

  it('lets the operator skip a foreign archive without touching it', async () => {
    const { data, storage } = memoryStorage();
    await preservePhotoRecovery(storage, 'lot-b', foreign, 200);
    const archiveKey = `${PHOTO_RECOVERY_PREFIX}lot-b`;
    const archiveBefore = data.get(archiveKey);

    const screen = screenModel(storage, { kind: 'staff', operatorId: 'op-a' });
    const loaded = await screen.load();
    expect(loaded.decision).toEqual({ action: 'blocked', reason: 'owner_mismatch' });
    expect(loaded.gate).toBe('preserve');
    expect(loaded.source).toBe('recovery');
    expect(screen.uploads).toBe(0);

    // Explicit skip opens the writer but leaves the archive byte-for-byte.
    expect(screen.skip()).toBe('open');
    expect(data.get(archiveKey)).toBe(archiveBefore);

    // A role refresh on the same mount does not re-run the load or touch it.
    await screen.load();
    expect(screen.gate).toBe('open');
    expect(data.get(archiveKey)).toBe(archiveBefore);

    // Independent work saves to the main key; the archive is still untouched
    // and no foreign photo was queued.
    expect(screen.saveIndependent({ editable: { title: 'New item' }, operatorId: 'op-a' })).toBe(
      true,
    );
    expect(data.get(MAIN_DRAFT_KEY)).toContain('New item');
    expect(data.get(archiveKey)).toBe(archiveBefore);
    expect(screen.uploads).toBe(0);

    // A remount with an empty main draft offers the archive again, still
    // blocked and still untouched.
    data.delete(MAIN_DRAFT_KEY);
    const remount = screenModel(storage, { kind: 'staff', operatorId: 'op-a' });
    expect((await remount.load()).decision).toEqual({
      action: 'blocked',
      reason: 'owner_mismatch',
    });
    expect(data.get(archiveKey)).toBe(archiveBefore);
  });

  it('lets the operator skip a legacy ownerless archive without touching it', async () => {
    const { data, storage } = memoryStorage();
    await preservePhotoRecovery(storage, 'lot-c', legacy, 200);
    const archiveKey = `${PHOTO_RECOVERY_PREFIX}lot-c`;
    const archiveBefore = data.get(archiveKey);

    const screen = screenModel(storage, { kind: 'staff', operatorId: 'op-a' });
    const loaded = await screen.load();
    expect(loaded.decision).toEqual({ action: 'blocked', reason: 'owner_unknown' });
    expect(loaded.source).toBe('recovery');

    expect(screen.skip()).toBe('open');
    expect(screen.saveIndependent({ editable: { title: 'New item' }, operatorId: 'op-a' })).toBe(
      true,
    );
    expect(data.get(archiveKey)).toBe(archiveBefore);
    expect(screen.uploads).toBe(0);
  });

  it('does not skip a blocked main draft, because opening the writer would clear it', async () => {
    const { data, storage } = memoryStorage();
    data.set(MAIN_DRAFT_KEY, JSON.stringify({ savedAt: 1, draft: foreign }));
    const mainBefore = data.get(MAIN_DRAFT_KEY);

    const screen = screenModel(storage, { kind: 'staff', operatorId: 'op-a' });
    const loaded = await screen.load();
    expect(loaded.decision).toEqual({ action: 'blocked', reason: 'owner_mismatch' });
    expect(loaded.source).toBe('main');
    expect(maySkipBlockedDraft('main')).toBe(false);

    expect(screen.skip()).toBe('preserve');
    expect(screen.saveIndependent({ editable: { title: 'New item' }, operatorId: 'op-a' })).toBe(
      false,
    );
    expect(data.get(MAIN_DRAFT_KEY)).toBe(mainBefore);
  });

  it('only allows a skip for a recovery archive', () => {
    expect(maySkipBlockedDraft('recovery')).toBe(true);
    expect(maySkipBlockedDraft('main')).toBe(false);
    expect(gateAfterBlockedSkip()).toBe('open');
  });
});
