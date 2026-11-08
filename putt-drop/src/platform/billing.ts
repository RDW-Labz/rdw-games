/// <reference path="../../node_modules/cordova-plugin-purchase/www/store.d.ts" />
import { Capacitor } from "@capacitor/core";

/**
 * Google Play Billing for the one non-consumable "Unlock full game" product (docs/billing.md).
 * cordova-plugin-purchase 13.18.0. NO receipt validator and NO server: entitlement is what the
 * Play Billing client reports locally (store.owned), cached in save.ts for offline launches.
 */
export const UNLOCK_PRODUCT_ID = "unlock_full";

export type PurchaseResult = "success" | "cancelled" | "failed" | "pending";
export type RestoreResult = "restored" | "nothing" | "failed";

type CdvNamespace = typeof CdvPurchase;
type CdvStore = CdvPurchase.Store;
type CdvProduct = CdvPurchase.Product;
type CdvTransaction = CdvPurchase.Transaction;

declare global {
  interface Window {
    CdvPurchase?: CdvNamespace;
  }
}

/** How long to wait for window.CdvPurchase (Cordova plugin JS) after the app starts. */
const CDV_WAIT_MS = 12_000;
/** After the Play purchase sheet closes, how long to wait for the purchase update to arrive. */
const PURCHASE_UPDATE_WAIT_MS = 20_000;

export interface BillingTestHooks {
  platform: () => string;
  getCdvPurchase: () => CdvNamespace | undefined;
  waitForReady: () => Promise<CdvNamespace | undefined>;
  purchaseUpdateWaitMs?: number;
}

let testHooks: BillingTestHooks | null = null;

/** Unit tests only: inject platform and a mocked CdvPurchase. Ignored in production builds. */
export function __setBillingTestHooks(hooks: BillingTestHooks | null): void {
  if (import.meta.env.MODE === "production") return;
  testHooks = hooks;
}

/** Unit tests only: reset module state between cases. Ignored in production builds. */
export function __resetBillingForTests(): void {
  if (import.meta.env.MODE === "production") return;
  initStarted = null;
  storeTrusted = false;
  store = null;
  cdvNs = null;
  cachedPrice = null;
  cachedOwned = false;
  activePurchase = null;
  purchasePending = false;
  entitlementListeners.clear();
  metadataListeners.clear();
}

function platformId(): string {
  return testHooks?.platform() ?? Capacitor.getPlatform();
}

function getCdv(): CdvNamespace | undefined {
  if (testHooks) return testHooks.getCdvPurchase();
  if (typeof window === "undefined") return undefined;
  return window.CdvPurchase;
}

let store: CdvStore | null = null;
let cdvNs: CdvNamespace | null = null;
let initStarted: Promise<void> | null = null;
/** True only after store.initialize() reported no errors: only then is "not owned" believed. */
let storeTrusted = false;
let cachedPrice: string | null = null;
let cachedOwned = false;
let purchasePending = false;
let activePurchase: ((result: PurchaseResult) => void) | null = null;
const entitlementListeners = new Set<(owned: boolean) => void>();
const metadataListeners = new Set<() => void>();

function notifyEntitlement(owned: boolean): void {
  if (cachedOwned === owned) return;
  cachedOwned = owned;
  for (const cb of entitlementListeners) cb(owned);
}

function notifyMetadata(): void {
  for (const cb of metadataListeners) cb();
}

function isUnlockTx(tx: CdvTransaction): boolean {
  return tx.products.some((p) => p.id === UNLOCK_PRODUCT_ID);
}

function readPrice(product: CdvProduct | undefined): string | null {
  const price = product?.pricing?.price;
  return price && price.length > 0 ? price : null;
}

/** Play's local answer. store.owned() is false for pending transactions (LocalReceipts.isOwned). */
function storeSaysOwned(): boolean {
  return store?.owned(UNLOCK_PRODUCT_ID) ?? false;
}

function updatePrice(product: CdvProduct | undefined): void {
  const next = readPrice(product);
  if (next === cachedPrice) return;
  cachedPrice = next;
  notifyMetadata();
}

/**
 * Re-read ownership from Play. Ignored until initialize() succeeded, so a failed connection
 * (offline, Play missing) never re-locks a cached purchase. A refund/void makes Play drop the
 * purchase, store.owned() turns false, and the cached flag follows (re-lock).
 */
function syncOwnership(): void {
  if (!store || !storeTrusted) return;
  notifyEntitlement(storeSaysOwned());
}

function waitForCdvPurchase(): Promise<CdvNamespace | undefined> {
  if (testHooks) return testHooks.waitForReady();
  return new Promise((resolve) => {
    const existing = getCdv();
    if (existing) {
      resolve(existing);
      return;
    }
    if (typeof document === "undefined") {
      resolve(undefined);
      return;
    }
    let done = false;
    const finish = (cdv?: CdvNamespace): void => {
      if (done) return;
      done = true;
      resolve(cdv);
    };
    document.addEventListener("deviceready", () => finish(getCdv()), { once: true });
    const deadline = Date.now() + CDV_WAIT_MS;
    const poll = (): void => {
      if (done) return;
      const cdv = getCdv();
      if (cdv) finish(cdv);
      else if (Date.now() >= deadline) finish(undefined);
      else setTimeout(poll, 40);
    };
    poll();
  });
}

/** True only on Android with the plugin present and Play Billing connected without errors. */
export function billingAvailable(): boolean {
  return platformId() === "android" && store != null && storeTrusted;
}

/** Store-formatted price (e.g. "$2.99", "2,99 €") or null. Never hardcoded. */
export function productPrice(): string | null {
  if (!billingAvailable()) return null;
  return cachedPrice;
}

/** Last known entitlement: Play's answer when connected, else the cached save flag. */
export function isProductOwned(): boolean {
  return cachedOwned;
}

export function isPurchasePending(): boolean {
  return purchasePending;
}

export function onEntitlementChange(cb: (owned: boolean) => void): () => void {
  entitlementListeners.add(cb);
  return () => entitlementListeners.delete(cb);
}

export function onProductMetadataChange(cb: () => void): () => void {
  metadataListeners.add(cb);
  return () => metadataListeners.delete(cb);
}

/** Seed with the cached save flag before Play answers (offline launch keeps this value). */
export function seedEntitlementCache(owned: boolean): void {
  cachedOwned = owned;
}

/**
 * Connect to Google Play once. Android only, and only when window.CdvPurchase exists.
 * Every other platform (web, iPhone browser) stays billing-unavailable.
 */
export function initBilling(): Promise<void> {
  if (!initStarted) initStarted = doInit();
  return initStarted;
}

async function doInit(): Promise<void> {
  if (platformId() !== "android") return;
  const cdv = await waitForCdvPurchase();
  if (!cdv?.store) return;
  cdvNs = cdv;
  const st = cdv.store;
  store = st;
  const { Platform, ProductType } = cdv;

  st.register([
    {
      id: UNLOCK_PRODUCT_ID,
      type: ProductType.NON_CONSUMABLE,
      platform: Platform.GOOGLE_PLAY,
    },
  ]);

  const onPendingTx = (tx: CdvTransaction): void => {
    if (!isUnlockTx(tx) || !tx.isPending) return;
    // Pending (e.g. cash payment): no entitlement until Play reports it PURCHASED -> approved.
    purchasePending = true;
    activePurchase?.("pending");
  };

  st.when()
    .productUpdated((product) => {
      if (product.id !== UNLOCK_PRODUCT_ID) return;
      updatePrice(product);
      syncOwnership();
    })
    // Google Play maps a PENDING purchase to state "initiated" with isPending = true.
    .initiated(onPendingTx)
    .pending(onPendingTx)
    .approved((tx) => {
      if (!isUnlockTx(tx) || tx.isPending) return;
      // finish() ACKNOWLEDGES the purchase; Play refunds it if not acknowledged within 3 days.
      void tx.finish();
      purchasePending = false;
      // A completed purchase is a positive answer from Play even before initialize() returns.
      notifyEntitlement(true);
      activePurchase?.("success");
    })
    .receiptUpdated(() => syncOwnership());

  try {
    const errors = await st.initialize([{ platform: Platform.GOOGLE_PLAY }]);
    storeTrusted = !errors || errors.length === 0;
  } catch {
    storeTrusted = false;
  }
  if (!storeTrusted) return;
  updatePrice(st.get(UNLOCK_PRODUCT_ID, Platform.GOOGLE_PLAY));
  syncOwnership();
}

/** Launch refresh: ask Play again; keeps the cached flag when Play can't be reached. */
export async function refreshEntitlementFromStore(): Promise<boolean> {
  if (!billingAvailable() || !store) return cachedOwned;
  try {
    await store.update();
  } catch {
    return cachedOwned;
  }
  syncOwnership();
  return cachedOwned;
}

export async function purchaseUnlock(): Promise<PurchaseResult> {
  const st = store;
  const cdv = cdvNs;
  if (!billingAvailable() || !st || !cdv) return "failed";
  if (activePurchase) return "failed";
  const offer = st.get(UNLOCK_PRODUCT_ID, cdv.Platform.GOOGLE_PLAY)?.getOffer();
  if (!offer) return "failed";

  return new Promise<PurchaseResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const done = (result: PurchaseResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      activePurchase = null;
      resolve(result);
    };
    activePurchase = done;

    void offer.order().then(
      (error) => {
        if (settled) return;
        if (error) {
          if (error.code === cdv.ErrorCode.PAYMENT_CANCELLED) done("cancelled");
          // e.g. ITEM_ALREADY_OWNED: don't sell twice, report the real entitlement.
          else done(storeSaysOwned() ? "success" : "failed");
          return;
        }
        // The Play sheet closed OK; the purchase update (approved / pending) follows shortly.
        const wait = testHooks?.purchaseUpdateWaitMs ?? PURCHASE_UPDATE_WAIT_MS;
        timer = setTimeout(() => {
          if (storeSaysOwned()) done("success");
          else if (purchasePending) done("pending");
          else done("failed");
        }, wait);
      },
      () => done("failed")
    );
  });
}

export async function restorePurchases(): Promise<RestoreResult> {
  const st = store;
  if (!billingAvailable() || !st) return "failed";
  try {
    const error = await st.restorePurchases();
    if (error) return "failed";
  } catch {
    return "failed";
  }
  syncOwnership();
  return cachedOwned ? "restored" : "nothing";
}

/** True when running inside the Android app (where Google Play Billing can exist). */
export function isAndroidApp(): boolean {
  return platformId() === "android";
}
