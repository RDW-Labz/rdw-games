import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetBillingForTests,
  __setBillingTestHooks,
  billingAvailable,
  initBilling,
  isProductOwned,
  isPurchasePending,
  onEntitlementChange,
  productPrice,
  purchaseUnlock,
  refreshEntitlementFromStore,
  restorePurchases,
  seedEntitlementCache,
  UNLOCK_PRODUCT_ID,
} from "../src/platform/billing.js";
import { syncEntitlementOnLaunch } from "../src/platform/save.js";
import {
  createDefaultSave,
  FREE_HOLE_COUNT,
  fullGameOnSale,
  isHoleAvailable,
  paidHoleCount,
} from "../src/progress.js";
import { loadLevels } from "../src/levels.js";
import { paidOfferLine } from "../src/game/course/worldsCatalog.js";

const ERR_CANCELLED = 6777006;
const ERR_PURCHASE = 6777003;

type Tx = {
  products: { id: string }[];
  isPending?: boolean;
  finish: () => Promise<void>;
};

/** Mock of the cordova-plugin-purchase 13 surface billing.ts uses (Google Play adapter semantics). */
function mockCdv(opts: {
  owned?: boolean;
  price?: string;
  initErrors?: unknown[];
  orderError?: { code: number };
}) {
  const state = {
    owned: opts.owned ?? false,
    pending: false,
    price: opts.price,
    orderError: opts.orderError,
    restoreError: undefined as unknown,
  };
  const handlers: Record<string, Array<(x: unknown) => void>> = {};
  const on = (name: string) => (cb: (x: unknown) => void) => {
    (handlers[name] ??= []).push(cb);
    return when;
  };
  const when = {
    productUpdated: on("productUpdated"),
    initiated: on("initiated"),
    pending: on("pending"),
    approved: on("approved"),
    receiptUpdated: on("receiptUpdated"),
  };
  const emit = (name: string, x: unknown) => (handlers[name] ?? []).forEach((cb) => cb(x));
  const finish = vi.fn(async () => {
    state.pending = false;
  });
  const product = () => ({
    id: UNLOCK_PRODUCT_ID,
    pricing: state.price ? { price: state.price } : undefined,
    getOffer: () => ({ order: order }),
  });
  const order = vi.fn(async () => state.orderError);
  const store = {
    register: vi.fn(),
    initialize: vi.fn(async () => opts.initErrors ?? []),
    update: vi.fn(async () => emit("receiptUpdated", {})),
    restorePurchases: vi.fn(async () => state.restoreError),
    // Like LocalReceipts.isOwned: a pending transaction is not owned.
    owned: (id: string) => id === UNLOCK_PRODUCT_ID && state.owned && !state.pending,
    get: (id: string) => (id === UNLOCK_PRODUCT_ID ? product() : undefined),
    when: () => when,
  };
  const cdv = {
    store,
    Platform: { GOOGLE_PLAY: "android-playstore" },
    ProductType: { NON_CONSUMABLE: "non consumable" },
    ErrorCode: { PAYMENT_CANCELLED: ERR_CANCELLED },
  };
  const tx = (isPending: boolean): Tx => ({ products: [{ id: UNLOCK_PRODUCT_ID }], isPending, finish });
  return {
    cdv,
    store,
    state,
    finish,
    order,
    /** Play reports a completed purchase (state approved). */
    approve() {
      state.owned = true;
      state.pending = false;
      emit("approved", tx(false));
    },
    /** Play reports a pending purchase (Google maps it to "initiated" + isPending). */
    pendingPurchase() {
      state.owned = true;
      state.pending = true;
      emit("initiated", tx(true));
    },
    priceArrives(price: string) {
      state.price = price;
      emit("productUpdated", product());
    },
  };
}

function useAndroid(m: ReturnType<typeof mockCdv> | undefined, waitMs = 50) {
  const getCdvPurchase = vi.fn(() => m?.cdv as never);
  __setBillingTestHooks({
    platform: () => "android",
    getCdvPurchase,
    waitForReady: async () => m?.cdv as never,
    purchaseUpdateWaitMs: waitMs,
  });
  return getCdvPurchase;
}

function useWeb(platform = "web") {
  const waitForReady = vi.fn(async () => undefined);
  __setBillingTestHooks({ platform: () => platform, getCdvPurchase: () => undefined, waitForReady });
  return waitForReady;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("billing (mocked CdvPurchase store)", () => {
  beforeEach(() => {
    __resetBillingForTests();
    __setBillingTestHooks(null);
  });
  afterEach(() => {
    __setBillingTestHooks(null);
    __resetBillingForTests();
  });

  it("initializes only on android with CdvPurchase present", async () => {
    for (const p of ["web", "ios"]) {
      __resetBillingForTests();
      const waitForReady = useWeb(p);
      await initBilling();
      expect(billingAvailable()).toBe(false);
      expect(waitForReady).not.toHaveBeenCalled();
    }

    __resetBillingForTests();
    useAndroid(undefined);
    await initBilling();
    expect(billingAvailable()).toBe(false);

    __resetBillingForTests();
    const m = mockCdv({ price: "$2.99" });
    useAndroid(m);
    await initBilling();
    expect(billingAvailable()).toBe(true);
    expect(m.store.register).toHaveBeenCalledWith([
      { id: UNLOCK_PRODUCT_ID, type: "non consumable", platform: "android-playstore" },
    ]);
    expect(m.store.initialize).toHaveBeenCalledWith([{ platform: "android-playstore" }]);
  });

  it("shows the store-formatted price, and none until the store provides it", async () => {
    const m = mockCdv({});
    useAndroid(m);
    await initBilling();
    expect(productPrice()).toBeNull();
    m.priceArrives("2,99 €");
    expect(productPrice()).toBe("2,99 €");
  });

  it("purchase success acknowledges with finish() and unlocks", async () => {
    const m = mockCdv({ price: "$2.99" });
    useAndroid(m);
    await initBilling();
    const events: boolean[] = [];
    onEntitlementChange((o) => events.push(o));
    const result = purchaseUnlock();
    await tick(); // order() resolved: sheet closed, purchase update follows
    m.approve();
    expect(await result).toBe("success");
    expect(m.finish).toHaveBeenCalledTimes(1);
    expect(events).toEqual([true]);
    expect(isProductOwned()).toBe(true);
  });

  it("cancelled and failed purchases do not unlock", async () => {
    const m = mockCdv({ price: "$2.99", orderError: { code: ERR_CANCELLED } });
    useAndroid(m);
    await initBilling();
    expect(await purchaseUnlock()).toBe("cancelled");
    m.state.orderError = { code: ERR_PURCHASE };
    expect(await purchaseUnlock()).toBe("failed");
    m.state.orderError = undefined; // sheet closed but Play never reported a purchase
    expect(await purchaseUnlock()).toBe("failed");
    expect(isProductOwned()).toBe(false);
    expect(m.finish).not.toHaveBeenCalled();
  });

  it("ITEM_ALREADY_OWNED style errors report the real entitlement instead of selling twice", async () => {
    const m = mockCdv({ price: "$2.99", owned: true, orderError: { code: ERR_PURCHASE } });
    useAndroid(m);
    await initBilling();
    expect(await purchaseUnlock()).toBe("success");
  });

  it("pending purchase does not unlock until it completes", async () => {
    const m = mockCdv({ price: "$2.99" });
    useAndroid(m);
    await initBilling();
    const events: boolean[] = [];
    onEntitlementChange((o) => events.push(o));
    const result = purchaseUnlock();
    await tick();
    m.pendingPurchase();
    expect(await result).toBe("pending");
    expect(isPurchasePending()).toBe(true);
    expect(await refreshEntitlementFromStore()).toBe(false);
    expect(events).toEqual([]);
    expect(m.finish).not.toHaveBeenCalled();

    m.approve(); // payment completed later
    expect(m.finish).toHaveBeenCalledTimes(1);
    expect(isPurchasePending()).toBe(false);
    expect(events).toEqual([true]);
  });

  it("restore reports owned vs nothing vs failed", async () => {
    const m = mockCdv({ price: "$2.99" });
    useAndroid(m);
    await initBilling();
    expect(await restorePurchases()).toBe("nothing");
    m.state.owned = true;
    expect(await restorePurchases()).toBe("restored");
    m.state.restoreError = { code: 1, message: "offline" };
    expect(await restorePurchases()).toBe("failed");
  });

  it("restore is unavailable (failed) off Android", async () => {
    useWeb();
    await initBilling();
    expect(await restorePurchases()).toBe("failed");
  });

  it("refund/void: Play no longer reports ownership on launch refresh -> re-locks the save", async () => {
    const m = mockCdv({ price: "$2.99", owned: true });
    seedEntitlementCache(true);
    useAndroid(m);
    await initBilling();
    expect(isProductOwned()).toBe(true);
    m.state.owned = false; // refunded in Play Console
    const save = await syncEntitlementOnLaunch({ ...createDefaultSave(12), unlocked: true });
    expect(save.unlocked).toBe(false);
  });

  it("offline launch (Play connection errors) keeps the cached entitlement", async () => {
    const m = mockCdv({ owned: false, initErrors: [{ code: 6777001, message: "setup failed" }] });
    seedEntitlementCache(true);
    useAndroid(m);
    await initBilling();
    expect(billingAvailable()).toBe(false);
    const save = await syncEntitlementOnLaunch({ ...createDefaultSave(12), unlocked: true });
    expect(save.unlocked).toBe(true);
  });

  it("web shows billing unavailable and keeps the cache", async () => {
    seedEntitlementCache(false);
    useWeb();
    await initBilling();
    expect(billingAvailable()).toBe(false);
    expect(productPrice()).toBeNull();
    expect(await purchaseUnlock()).toBe("failed");
  });
});

describe("full-game offer gate", () => {
  beforeEach(() => {
    __resetBillingForTests();
    __setBillingTestHooks(null);
  });
  afterEach(() => {
    __setBillingTestHooks(null);
    __resetBillingForTests();
  });

  /** Paid holes in the shipped level list: everything after the free twelve. */
  const paidLevels = () => loadLevels().slice(FREE_HOLE_COUNT);

  /** The conditions UnlockScene uses to show an enabled "Unlock full game · {price}" button. */
  const offerShown = (total: number, unlocked: boolean) =>
    fullGameOnSale(total) && billingAvailable() && !unlocked && productPrice() !== null;

  it("is on sale only when the catalog has paid holes (13+)", () => {
    expect(paidHoleCount(12)).toBe(0);
    expect(fullGameOnSale(12)).toBe(false);
    expect(paidHoleCount(30)).toBe(18);
    expect(fullGameOnSale(13)).toBe(true);
  });

  it("current catalog sells 24 paid holes, derived from the level list", () => {
    const levels = loadLevels();
    const paid = paidLevels();
    expect(paid.length).toBe(24);
    expect(paidHoleCount(levels.length)).toBe(paid.length);
    expect(fullGameOnSale(levels.length)).toBe(true);
    // Every paid hole carries one of the two new mechanics; no free hole does.
    for (const l of paid) {
      expect((l.fastTurf?.length ?? 0) + (l.oneWayGates?.length ?? 0)).toBeGreaterThan(0);
    }
    for (const l of levels.slice(0, FREE_HOLE_COUNT)) {
      expect(l.fastTurf?.length ?? 0).toBe(0);
      expect(l.oneWayGates?.length ?? 0).toBe(0);
    }
  });

  it("offer copy is derived from the level list", () => {
    expect(paidOfferLine(loadLevels())).toBe("24 more holes in 2 new worlds: fast turf and one-way wickets");
    expect(paidOfferLine(loadLevels().slice(0, FREE_HOLE_COUNT))).toBe("The 12 free holes are ready to play.");
    expect(paidOfferLine(loadLevels().slice(0, 24))).toBe("12 more holes in 1 new world: fast turf");
  });

  it("offer appears when billing is available and the player hasn't unlocked", async () => {
    const total = loadLevels().length;
    const save = createDefaultSave(total);
    expect(save.unlocked).toBe(false);
    const m = mockCdv({ price: "$2.99" });
    useAndroid(m);
    await initBilling();
    expect(offerShown(total, save.unlocked)).toBe(true);
    expect(offerShown(total, true)).toBe(false);
  });

  it("offer stays off when billing is unavailable but catalog still has paid holes", async () => {
    const total = loadLevels().length;
    expect(fullGameOnSale(total)).toBe(true);
    useWeb();
    await initBilling();
    expect(billingAvailable()).toBe(false);
    expect(productPrice()).toBeNull();
    expect(offerShown(total, false)).toBe(false);
  });

  it("locked holes 13–36 can't be started without the entitlement", () => {
    const total = loadLevels().length;
    const save = createDefaultSave(total);
    for (let i = 0; i < FREE_HOLE_COUNT; i++) expect(isHoleAvailable(i, save.unlocked)).toBe(true);
    for (let i = FREE_HOLE_COUNT; i < total; i++) expect(isHoleAvailable(i, save.unlocked)).toBe(false);
  });

  it("a verified purchase unlocks holes 13–36", async () => {
    const total = loadLevels().length;
    const m = mockCdv({ price: "$2.99" });
    useAndroid(m);
    await initBilling();
    let save = createDefaultSave(total);
    const result = purchaseUnlock();
    await tick();
    m.approve();
    expect(await result).toBe("success");
    save = await syncEntitlementOnLaunch(save);
    expect(save.unlocked).toBe(true);
    for (let i = 0; i < total; i++) expect(isHoleAvailable(i, save.unlocked)).toBe(true);
    expect(offerShown(total, save.unlocked)).toBe(false);
  });
});
