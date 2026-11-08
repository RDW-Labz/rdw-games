import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The blocked-skip suite drives the same production pieces the screen uses:
 * the shared alert/banner callbacks, the screen's writer step
 * (`openWriterForBlockedSkip`), the real persisted-draft writer/reader, the
 * real recovery archive and the durable photo queue backed by one connected
 * synthetic store. Mutating any of them (writer to a no-op, skip that deletes
 * the archive) must fail these cases (RED TEAM #760).
 */
const state = vi.hoisted(() => ({
  store: new Map<string, string>(),
  files: new Set<string>(),
  deletedFiles: [] as string[],
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => state.store.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      state.store.set(key, value);
    },
    removeItem: async (key: string) => {
      state.store.delete(key);
    },
    getAllKeys: async () => [...state.store.keys()],
  },
}));

vi.mock('@auction-platform/supabase-client', () => ({
  resolveOperatorIdForUpload: async () => 'op-a',
  supabase: { rpc: async () => ({ data: null, error: { message: 'not_used' } }) },
}));

vi.mock('@/lib/upload-image', () => ({
  uploadImageFromUri: async () => ({ ok: false, reason: 'offline' }),
}));

vi.mock('@/lib/image-compress', () => ({ compressToJpegUri: async (uri: string) => uri }));

vi.mock('@/features/lotting/uploadPendingPhotos', () => ({
  isLocalPhotoUri: (uri: string) => !/^https:\/\//i.test(uri.trim()),
}));

vi.mock('@/lib/persist-photo', () => ({
  persistedPhotoExists: async (uri: string) => state.files.has(uri),
  deletePersistedPhoto: async (uri: string) => {
    state.deletedFiles.push(uri);
    state.files.delete(uri);
  },
}));

import { decideDraftRecovery, type SavedPhotoDraft } from './draft-recovery';
import { createDraftPersistence } from './draft-persistence';
import {
  BLOCKED_SKIP_TITLE,
  blockedSkipAlert,
  blockedSkipBannerActions,
  blockedSkipBannerVisible,
  blockedSkipFlowFor,
  createBlockedSkipScreen,
  type BlockedSkipFlow,
} from './photo-blocked-skip';
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
  type RecoveryStorage,
} from './photo-recovery';
import { enqueueLotPhoto, photoQueueCount } from './photo-upload-queue';

const MAIN_DRAFT_KEY = 'lotting:draft:photo';
const MAX_AGE_MS = 30 * 60 * 1000;

type PhotoDraft = SavedPhotoDraft & {
  editable: { title: string; stockPhotos: string[] };
  hero?: { uri: string };
  conditionPhotos?: { uri: string }[];
};

const foreign: PhotoDraft = {
  editable: { title: 'Foreign item', stockPhotos: ['file:///stock-foreign.jpg'] },
  created: { lotId: 'lot-b', lotCode: 'B-1' },
  operatorId: 'op-b',
  hero: { uri: 'file:///foreign-hero.jpg' },
  conditionPhotos: [{ uri: 'file:///foreign-condition.jpg' }],
};
const legacy: PhotoDraft = {
  editable: { title: 'Legacy item', stockPhotos: ['file:///stock-legacy.jpg'] },
  created: { lotId: 'lot-c', lotCode: 'C-1' },
  hero: { uri: 'file:///legacy-hero.jpg' },
  conditionPhotos: [{ uri: 'file:///legacy-condition.jpg' }],
};

const independentDraft: PhotoDraft = {
  editable: { title: 'New item', stockPhotos: ['file:///new-stock.jpg'] },
  operatorId: 'op-a',
};

const storageAdapter: RecoveryStorage = {
  getItem: async (key) => state.store.get(key) ?? null,
  setItem: async (key, value) => {
    state.store.set(key, value);
  },
  removeItem: async (key) => {
    state.store.delete(key);
  },
  getAllKeys: async () => [...state.store.keys()],
};

function reasonFor(draft: PhotoDraft) {
  return draft.operatorId ? 'owner_mismatch' : 'owner_unknown';
}

type Screen = {
  alert: ReturnType<typeof blockedSkipAlert> | null;
  presented: Array<ReturnType<typeof blockedSkipAlert>>;
  get banner(): ReturnType<typeof blockedSkipBannerActions> | null;
  get flow(): BlockedSkipFlow;
  get gate(): DraftWriteGate;
  get bannerVisible(): boolean;
};

/**
 * Drives `createBlockedSkipScreen` — the exact composition `photo.tsx` builds
 * — instead of reimplementing the screen's wiring in the test. Mutating the
 * production composition (removing the writer step, or the banner handlers)
 * fails these cases (RED TEAM #762).
 */
function blockedScreen(draft: PhotoDraft, from: BlockedDraftSource = 'recovery'): Screen {
  const reason = reasonFor(draft);
  const decision = decideDraftRecovery(draft, { kind: 'staff', operatorId: 'op-a' });
  let flow = blockedSkipFlowFor(decision, from);
  let gate = gateAfterDraftLoad(decision);
  const presented: Array<ReturnType<typeof blockedSkipAlert>> = [];

  const controller = createBlockedSkipScreen({
    setFlow: (updater: (current: BlockedSkipFlow) => BlockedSkipFlow) => {
      flow = updater(flow);
    },
    setGate: (next) => {
      gate = next;
    },
    present: (alert) => {
      presented.push(alert);
    },
  });

  // The screen offers the alert when the load decision is a skippable block.
  const alert = flow.kind === 'prompt' ? controller.alertFor(reason) : null;

  return {
    alert,
    presented,
    get banner() {
      return controller.bannerFor(flow);
    },
    get flow() {
      return flow;
    },
    get gate() {
      return gate;
    },
    get bannerVisible() {
      return blockedSkipBannerVisible(flow);
    },
  };
}

async function seedArchive(draft: PhotoDraft) {
  await preservePhotoRecovery(storageAdapter, draft.created!.lotId, draft, Date.now());
  for (const uri of [
    draft.hero?.uri,
    ...(draft.conditionPhotos ?? []).map((photo) => photo.uri),
    ...draft.editable.stockPhotos,
  ])
    if (uri) state.files.add(uri);
  const key = `${PHOTO_RECOVERY_PREFIX}${draft.created!.lotId}`;
  return { key, bytes: state.store.get(key) };
}

describe('blocked skip drives the real writer, archive and queue', () => {
  beforeEach(() => {
    state.store.clear();
    state.files.clear();
    state.deletedFiles = [];
  });

  for (const [name, draft] of [
    ['foreign', foreign],
    ['legacy ownerless', legacy],
  ] as const) {
    it(`dismisses, reopens, skips and saves a real new draft without touching the ${name} archive`, async () => {
      const { key, bytes } = await seedArchive(draft);
      const lotId = draft.created!.lotId;
      const screen = blockedScreen(draft);
      const persistence = createDraftPersistence<PhotoDraft>(storageAdapter, MAIN_DRAFT_KEY, {
        maxAgeMs: MAX_AGE_MS,
        deleteFile: async (uri) => {
          state.deletedFiles.push(uri);
          state.files.delete(uri);
        },
      });

      expect(screen.flow.kind).toBe('prompt');
      expect(screen.gate).toBe('preserve');
      expect(screen.bannerVisible).toBe(false);

      // "Not now" moves the decision to the banner; the writer stays shut.
      const notNow = screen.alert!.buttons.find((button) => button.text === 'Not now');
      notNow?.onPress?.();
      expect(screen.flow.kind).toBe('dismissed');
      expect(screen.bannerVisible).toBe(true);
      expect(mayStartNewItem(screen.gate)).toBe(false);

      // While preserved, the screen's save effect must not write at all.
      if (mayWriteDraft(screen.gate)) await persistence.write(independentDraft);
      expect(state.store.has(MAIN_DRAFT_KEY)).toBe(false);

      // "Review saved item" reopens the same choice in this mount, through the
      // same production composition that presents the first alert.
      screen.banner!.review();
      expect(screen.flow.kind).toBe('prompt');
      expect(screen.presented).toHaveLength(2);
      expect(screen.presented[1]!.message).toContain(
        reasonFor(draft) === 'owner_mismatch'
          ? 'different staff sign-in'
          : 'before the app recorded',
      );

      // "Start a new item" on the reopened alert opens the real writer, then
      // the ordinary save path stores a genuine independent draft and admits
      // its own photo.
      const reopenedStartNew = screen.presented[1]!.buttons.find(
        (button) => button.text === 'Start a new item',
      );
      reopenedStartNew?.onPress?.();
      expect(screen.flow.kind).toBe('skipped');
      expect(screen.gate).toBe(gateAfterBlockedSkip());
      expect(mayWriteDraft(screen.gate)).toBe(true);

      if (mayWriteDraft(screen.gate)) await persistence.write(independentDraft);

      // The production persistence controller reads the same record back.
      expect(await persistence.load()).toEqual(independentDraft);

      // The real durable queue is connected to the same store. The new item is
      // admitted; the foreign lot never is.
      state.files.add('file:///new-stock.jpg');
      const queued = await enqueueLotPhoto({
        lotId: 'lot-new',
        lotCode: 'N-1',
        operatorId: 'op-a',
        localUri: 'file:///new-stock.jpg',
      });
      expect(queued.status).toBe('queued');
      expect(await photoQueueCount('lot-new')).toBe(1);
      expect(await photoQueueCount(lotId)).toBe(0);

      // The archive and every foreign file are byte-for-byte untouched.
      expect(state.store.has(key)).toBe(true);
      expect(state.store.get(key)).toBe(bytes);
      expect(JSON.parse(state.store.get(key)!).draft).toEqual(draft);
      for (const uri of [
        draft.hero?.uri,
        ...(draft.conditionPhotos ?? []).map((photo) => photo.uri),
        ...draft.editable.stockPhotos,
      ])
        if (uri) expect(state.files.has(uri)).toBe(true);
      expect(state.deletedFiles).toEqual([]);
    });

    it(`treats Android back/outside on the ${name} alert as "Not now"`, async () => {
      await seedArchive(draft);
      const screen = blockedScreen(draft);
      screen.alert!.options.onDismiss?.();
      expect(screen.flow.kind).toBe('dismissed');
      expect(screen.bannerVisible).toBe(true);
      expect(screen.gate).toBe('preserve');
      expect(state.deletedFiles).toEqual([]);
    });

    it(`skips the ${name} archive straight from the alert`, async () => {
      const { key, bytes } = await seedArchive(draft);
      const screen = blockedScreen(draft);
      const startNew = screen.alert!.buttons.find((button) => button.text === 'Start a new item');
      startNew?.onPress?.();
      expect(screen.flow.kind).toBe('skipped');
      expect(screen.gate).toBe('open');
      expect(state.store.get(key)).toBe(bytes);
      expect(state.deletedFiles).toEqual([]);
    });
  }

  it('renders the alert title and buttons the screen shows', () => {
    const screen = blockedScreen(foreign);
    expect(screen.alert!.title).toBe(BLOCKED_SKIP_TITLE);
    expect(screen.alert!.message.length).toBeGreaterThan(0);
    expect(screen.alert!.buttons.map((button) => button.text)).toEqual([
      'Not now',
      'Start a new item',
    ]);
  });

  it('never offers a skip for a blocked main draft', () => {
    const screen = blockedScreen(foreign, 'main');
    expect(screen.flow.kind).toBe('none');
    expect(screen.bannerVisible).toBe(false);
    expect(screen.gate).toBe('preserve');
    expect(maySkipBlockedDraft('main')).toBe(false);
    expect(mayWriteDraft(screen.gate)).toBe(false);
  });

  it('does not prompt when nothing is saved', () => {
    const decision = decideDraftRecovery(null, { kind: 'staff', operatorId: 'op-a' });
    expect(decision.action).toBe('none');
    expect(blockedSkipFlowFor(decision, 'recovery').kind).toBe('none');
    expect(gateAfterDraftLoad(decision)).toBe('open');
  });
});

describe('photo screen wires the shared callbacks and writer', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../app/(staff)/lotting/photo.tsx'),
    'utf8',
  );
  const hookSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../features/lotting/useDraftPersistence.ts'),
    'utf8',
  );

  it('presents the shared alert and banner through the production controller', () => {
    expect(source).toMatch(/createBlockedSkipScreen\(/);
    expect(source).toMatch(/blockedSkipScreen\.alertFor\(/);
    expect(source).toMatch(/blockedSkipScreen\.bannerFor\(blockedSkip\)/);
    expect(source).toMatch(
      /Alert\.alert\(alert\.title, alert\.message, alert\.buttons, alert\.options\)/,
    );
  });

  it('uses the shared banner handlers for both buttons', () => {
    expect(source).toMatch(/onPress=\{blockedSkipBanner\.review\}/);
    expect(source).toMatch(/onPress=\{blockedSkipBanner\.startNew\}/);
  });

  it('opens the writer through the shared production step', () => {
    const composer = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), './photo-blocked-skip.ts'),
      'utf8',
    );
    expect(composer).toMatch(/openWriterForBlockedSkip\(actions\.setGate\)/);
    expect(source).not.toMatch(/openWriterForBlockedSkip\(/);
  });

  it('still gates the screen draft save on the writer gate', () => {
    expect(source).toMatch(/if \(!mayWriteDraft\(draftGate\)\) return;/);
    expect(source).toMatch(/draftStore\.save\(/);
  });

  it('persists through the shared controller, not storage directly', () => {
    expect(hookSource).toMatch(/createDraftPersistence<T>\(/);
    expect(hookSource).toMatch(/persistence\.write\(/);
    expect(hookSource).not.toMatch(/writeStoredDraft\(/);
  });
});
