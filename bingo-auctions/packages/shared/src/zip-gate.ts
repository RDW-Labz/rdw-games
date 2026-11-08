// ZIP-required gate (0448 plan): shared decision logic for the mandatory
// "give us your ZIP" block the bidder app and the web storefront show before
// the bidder's NEXT bid or checkout action, once, if they have none on file.
//
// This is deliberately separate from apps/bidder-app/lib/postal-code.ts's
// isZipPromptDue(): that is the DISMISSIBLE home-tab prompt (snooze / 3-strike
// "never again"). This gate has no snooze — "no ZIP yet" is reason enough to
// ask again on the very next bid or checkout attempt, every time, until one is
// saved. Once bidders.postal_code is set, needsZipBeforeBid() is false forever
// (short of the bidder clearing it again from their profile).
//
// Pure logic only — no network client. Each app wires createZipChecker's
// `lookup` functions to its own Supabase client; see apps/bidder-app/lib/
// zip-gate.ts and apps/operator-web/src/components/bidder/ZipGateModal.tsx.

export const ZIP_FORMAT_ERROR = 'Enter a 5-digit ZIP';
export const ZIP_UNKNOWN_ERROR = "We don't recognize that ZIP. Check it and try again.";

export type ZipFormatResult = { ok: true; zip: string } | { ok: false; error: string };

/**
 * Exactly five digits, trimmed. Unlike postal-code.ts's validateZip (which
 * allows empty = "clear the ZIP" for the profile screen), this gate always
 * requires a real ZIP — there is no "clear" action here.
 */
export function validateZipFormat(raw: string | null | undefined): ZipFormatResult {
  const zip = (raw ?? '').trim();
  if (/^[0-9]{5}$/.test(zip)) return { ok: true, zip };
  return { ok: false, error: ZIP_FORMAT_ERROR };
}

/**
 * True when the signed-in bidder must be stopped and asked for a ZIP before
 * the bid / checkout action they just took continues. `postalCode` is
 * whatever bidders.postal_code currently reads for them (null/'' = none).
 */
export function needsZipBeforeBid(postalCode: string | null | undefined): boolean {
  return !postalCode;
}

export type ZipReferenceLookup = {
  /** Cheap `select postal_code from zip_reference limit 1` — true once the
   *  GeoNames loader has run and the table has any rows at all. */
  hasAnyRows: () => Promise<boolean>;
  /** `select postal_code from zip_reference where postal_code = $1 limit 1`. */
  exists: (zip: string) => Promise<boolean>;
};

export type ZipCheckResult =
  | { ok: true; zip: string }
  | { ok: false; reason: 'format'; error: string }
  | { ok: false; reason: 'unknown'; error: string };

/**
 * Builds a per-instance ZIP checker: caches whether zip_reference is
 * populated (one `limit 1` query, ever, per instance — call sites should keep
 * one instance per session/page, not build a fresh one per keystroke) and
 * validates candidate ZIPs against it once it is.
 *
 * FAIL OPEN: before the GeoNames loader has run (empty table) this is
 * format-only. On any network error from either lookup call, it is also
 * format-only for that attempt — never block placing a bid or checking out
 * because a reference lookup hiccupped. The ONE thing it always enforces is
 * the five-digit format.
 */
export function createZipChecker(lookup: ZipReferenceLookup) {
  let referencePopulated: boolean | null = null; // null = not checked yet

  async function check(raw: string | null | undefined): Promise<ZipCheckResult> {
    const fmt = validateZipFormat(raw);
    if (!fmt.ok) return { ok: false, reason: 'format', error: fmt.error };

    try {
      if (referencePopulated === null) {
        referencePopulated = await lookup.hasAnyRows();
      }
      if (!referencePopulated) return { ok: true, zip: fmt.zip };
      const found = await lookup.exists(fmt.zip);
      if (!found) return { ok: false, reason: 'unknown', error: ZIP_UNKNOWN_ERROR };
      return { ok: true, zip: fmt.zip };
    } catch {
      return { ok: true, zip: fmt.zip };
    }
  }

  return { check };
}

// ── "How did you hear about us?" (0448 optional profile field) ─────────────
// Fixed options + 'other' free text. Kept here so the bidder app and web
// profile screens render the identical list and the server's CHECK
// constraint / RPC validation never drifts from what the UI offers.

export const HEARD_ABOUT_OPTIONS = [
  { value: 'bingo_customer', label: 'Already a BinGo customer' },
  { value: 'friend_referral', label: 'A friend or family member told me' },
  { value: 'social_media', label: 'Social media' },
  { value: 'search_engine', label: 'Search engine' },
  { value: 'drive_by', label: 'Drove or walked by a warehouse' },
  { value: 'other', label: 'Other' },
] as const;

export type HeardAboutValue = (typeof HEARD_ABOUT_OPTIONS)[number]['value'];

export const HEARD_ABOUT_OTHER_MAX_LEN = 100;

export function isValidHeardAbout(value: string | null | undefined): value is HeardAboutValue {
  if (!value) return false;
  return HEARD_ABOUT_OPTIONS.some((o) => o.value === value);
}

/** Trims and caps at HEARD_ABOUT_OTHER_MAX_LEN; '' when empty/whitespace. */
export function sanitizeHeardAboutOther(raw: string | null | undefined): string {
  return (raw ?? '').trim().slice(0, HEARD_ABOUT_OTHER_MAX_LEN);
}

// ── SMS consent (0448) ──────────────────────────────────────────────────────
// Bumping this string is how a future copy change gets its own version on
// record — ship the new copy and this constant together; the server stores
// whatever version string the client sends with p_sms_consent = true, so an
// older build in the wild keeps recording the version matching the copy it
// actually showed.

export const SMS_CONSENT_TEXT_VERSION = 'sms-consent-v1';

/**
 * OFF until Michael approves the text-consent wording (owner, 2026-10-26).
 * While false, the new optional phone field and the text-message consent box
 * are hidden in the app and on the web, and no consent is ever saved. The ZIP
 * gate and "How did you hear about us?" are not affected. Turning it on is a
 * one-line change plus an app update / console deploy.
 */
export const SMS_CONSENT_ENABLED = false;

export const SMS_CONSENT_TEXT =
  'By checking this box, you agree to receive text messages from BinGo Auctions ' +
  'about auctions, bids, and pickups at the phone number you provided. Message ' +
  'and data rates may apply. Message frequency varies. Reply STOP to opt out, ' +
  'HELP for help. Consent is not a condition of purchase.';
